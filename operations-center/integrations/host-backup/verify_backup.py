#!/usr/bin/env python3
"""Verify schema-2 archives and restore databases in isolated containers."""
import argparse
import contextlib
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import tarfile
import tempfile
import time

from vps_backup import (BackupError, POLICY_TABLES, command, digest, load_config,
                        log, restore_conversation_settings, sqlite3, verify_payload_paths, write_json)


def unpack(archive, target):
    process = subprocess.Popen(['zstd', '-d', '-q', '-c', str(archive)], stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, start_new_session=True)
    links = []
    try:
        with tarfile.open(fileobj=process.stdout, mode='r|') as tar:
            for member in tar:
                relative = Path(member.name)
                if relative.is_absolute() or '..' in relative.parts:
                    raise BackupError('Unsafe archive member')
                path = target / relative
                if member.isdir():
                    path.mkdir(parents=True, exist_ok=True, mode=0o700)
                elif member.issym():
                    links.append((path, member.linkname))
                elif member.isfile():
                    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                    with tar.extractfile(member) as src, path.open('xb') as dst:
                        shutil.copyfileobj(src, dst, 1024 * 1024)
                    os.chmod(path, member.mode & 0o777)
                else:
                    raise BackupError('Unsupported archive member type')
        if process.wait(timeout=10):
            raise BackupError('Archive decompression failed')
        # Symlinks are created last, so extraction never writes through one.
        for path, link in links:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.symlink_to(link)
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()


def remove_test_container(name):
    if not name.startswith('vps-online-verify-'):
        raise BackupError('Refusing to remove an unrelated container')
    subprocess.run(['docker', 'rm', '-fv', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def load_image_artifact(path, image_id):
    producer = subprocess.Popen(['zstd', '-d', '-q', '-c', str(path)], stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, start_new_session=True)
    try:
        command(['docker', 'image', 'load'], stdin=producer.stdout, timeout=600)
        producer.stdout.close()
        if producer.wait(timeout=10):
            raise BackupError('Image decompression failed')
        if command(['docker', 'image', 'inspect', '--format', '{{.Id}}', image_id]).strip() != image_id:
            raise BackupError('Restored immutable image identity differs')
    finally:
        if producer.poll() is None:
            producer.kill()
            producer.wait()


def restore_postgres(payload, metadata, container, database):
    name = 'vps-online-verify-' + database + '-' + secrets.token_hex(3)
    role = 'backup_restore_check'
    try:
        command(['docker', 'run', '-d', '--name', name, '--network', 'none', '--user', '0',
                 '--label', 'vps.backup-verification=true', '-e', 'POSTGRES_USER=' + role,
                 '-e', 'POSTGRES_DB=postgres', '-e', 'POSTGRES_PASSWORD=' + secrets.token_hex(24),
                 '-e', 'PGDATA=/var/lib/postgresql/verify-data', metadata['images'][container]['id']])
        for _ in range(60):
            result = subprocess.run(['docker', 'exec', name, 'pg_isready', '-U', role],
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if result.returncode == 0:
                break
            time.sleep(1)
        else:
            raise BackupError('Isolated PostgreSQL did not become ready')
        with (payload / 'database' / (database + '-globals.private.sql')).open('rb') as stream:
            command(['docker', 'exec', '-i', name, 'psql', '-X', '-U', role, '-d', 'postgres',
                     '-v', 'ON_ERROR_STOP=1'], stdin=stream)
        command(['docker', 'exec', name, 'createdb', '-U', role, database])
        with (payload / 'database' / (database + '.dump')).open('rb') as stream:
            command(['docker', 'exec', '-i', name, 'pg_restore', '-U', role, '--exit-on-error', '-d', database],
                    stdin=stream, timeout=900)
        query = "SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')"
        tables = int(command(['docker', 'exec', name, 'psql', '-X', '-At', '-U', role,
                              '-d', database, '-v', 'ON_ERROR_STOP=1', '-c', query]).strip())
        return {'restored': True, 'tables': tables, 'network': 'none'}
    finally:
        remove_test_container(name)


def restore_redis(payload, metadata, container):
    name = 'vps-online-verify-' + container + '-' + secrets.token_hex(3)
    try:
        command(['docker', 'run', '-d', '--name', name, '--network', 'none', '--user', '0',
                 '--label', 'vps.backup-verification=true', '--entrypoint', 'redis-server',
                 '--mount', 'type=bind,src=' + str(payload / 'runtime') + ',dst=/restore,readonly',
                 metadata['images'][container]['id'], '--port', '0', '--unixsocket', '/tmp/redis.sock',
                 '--dir', '/restore', '--dbfilename', container + '.rdb', '--save', '', '--appendonly', 'no'])
        for _ in range(30):
            result = subprocess.run(['docker', 'exec', name, 'redis-cli', '-s', '/tmp/redis.sock', 'PING'],
                                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            if result.stdout.strip() == b'PONG':
                return {'restored': True, 'network': 'none'}
            time.sleep(1)
        raise BackupError('Isolated Redis snapshot did not load')
    finally:
        remove_test_container(name)


def verify_settings_with_application(payload, metadata, work):
    target = work / 'settings-restore' / 'conversation-logs'
    restore_conversation_settings(payload / 'conversation-settings' / 'operations-center', target)
    # The actual deployed application decrypts policies in an isolated empty archive.
    script = """const {ConversationLogStore}=require('/app/src/conversation-log-store');
const {ConversationPushStore}=require('/app/src/conversation-push-store');
const a=new ConversationLogStore('/restore').initialize();
const p=new ConversationPushStore(a).initialize();
if(a.db.prepare('SELECT count(*) n FROM cl_records').get().n!==0)process.exit(2);
if(!a.policy().version||!p.policy().version)process.exit(3);
a.db.close();console.log('settings-decrypted-empty-history');"""
    result = command(['docker', 'run', '--rm', '--network', 'none', '--user', '0', '--entrypoint', 'node',
                      '--mount', 'type=bind,src=' + str(target.parent) + ',dst=/restore',
                      metadata['images']['sub2api-operations-center']['id'], '-e', script])
    if 'settings-decrypted-empty-history' not in result:
        raise BackupError('Application could not restore conversation settings')
    return {'policies_decrypted': True, 'conversation_records': 0}


def verify(archive, config, restore=False):
    os.umask(0o077)
    archive = archive.resolve()
    log('verification_started', archive=archive.name, restore=restore)
    expected = archive.with_name(archive.name + '.sha256').read_text().split()[0]
    if digest(archive) != expected:
        raise BackupError('Archive checksum mismatch')
    with tempfile.TemporaryDirectory(prefix='verify-', dir=config['work_root']) as temporary:
        work = Path(temporary)
        payload = work / 'payload'
        payload.mkdir()
        unpack(archive, payload)
        log('archive_unpacked', archive=archive.name)
        metadata = json.loads((payload / 'manifest.private.json').read_text())
        if metadata.get('schema') != 2 or metadata.get('conversation_records_included') is not False:
            raise BackupError('Expected a schema-2 backup without conversation bodies')
        actual_files = {str(p.relative_to(payload)) for p in payload.rglob('*') if p.is_file() and not p.is_symlink()}
        expected_files = set(metadata['sha256']) | {'manifest.private.json'}
        if actual_files != expected_files:
            raise BackupError('Archive inventory differs from its manifest')
        verify_payload_paths(actual_files | set(metadata.get('symlinks', {})))
        for relative, checksum in metadata['sha256'].items():
            if digest(payload / relative) != checksum:
                raise BackupError('Payload checksum mismatch')
        log('payload_hashes_verified', files=len(metadata['sha256']))
        for relative, link in metadata.get('symlinks', {}).items():
            if not (payload / relative).is_symlink() or os.readlink(payload / relative) != link:
                raise BackupError('Payload symlink mismatch')
        sqlite_count = 0
        for relative in metadata['sha256']:
            path = payload / relative
            with path.open('rb') as stream:
                header = stream.read(16)
            if header == b'SQLite format 3\0':
                with contextlib.closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)) as db:
                    if db.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
                        raise BackupError('Payload SQLite integrity failure')
                sqlite_count += 1
                log('sqlite_verified', database=path.name)
        settings = payload / 'conversation-settings' / 'operations-center'
        with contextlib.closing(sqlite3.connect((settings / 'policies.sqlite').as_uri() + '?mode=ro', uri=True)) as db:
            tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if not tables <= set(POLICY_TABLES):
                raise BackupError('Conversation body table found in settings backup')
        for image_id, image in metadata['image_artifacts'].items():
            relative = Path(image['archive'])
            if relative.is_absolute() or '..' in relative.parts or relative.parts[0] != 'images':
                raise BackupError('Unsafe image artifact reference')
            if digest(archive.parent / relative) != image['sha256']:
                raise BackupError('Image artifact checksum mismatch')
            if restore:
                load_image_artifact(archive.parent / relative, image_id)
            log('image_artifact_verified', image=image_id.removeprefix('sha256:')[:12], loaded=restore)
        report = {'archive': archive.name, 'sha256': expected, 'hashed_files': len(metadata['sha256']),
                  'sqlite_checked': sqlite_count, 'conversation_records_included': False,
                  'postgres': {}, 'redis': {}, 'restore_verified': False}
        if restore:
            for container, database in config['postgres'].items():
                report['postgres'][database] = restore_postgres(payload, metadata, container, database)
                log('postgres_restore_verified', database=database, **report['postgres'][database])
            for container in config['redis']:
                report['redis'][container] = restore_redis(payload, metadata, container)
                log('redis_restore_verified', container=container, **report['redis'][container])
            report['conversation_settings'] = verify_settings_with_application(payload, metadata, work)
            log('conversation_settings_verified', **report['conversation_settings'])
            report['restore_verified'] = True
            write_json(archive.with_name(archive.name + '.restore-verified.json'), report)
        log('verification_completed', **report)
        return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('archive', type=Path)
    parser.add_argument('--config', default='/etc/sub2api-online-backup.json')
    parser.add_argument('--restore', action='store_true')
    args = parser.parse_args()
    try:
        verify(args.archive, load_config(args.config), args.restore)
    except Exception as error:
        log('verification_failed', error=type(error).__name__, reason=str(error) if isinstance(error, BackupError) else 'Private diagnostic required')
        raise SystemExit(1)
