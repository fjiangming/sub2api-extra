#!/usr/bin/env python3
"""Online host backup. Conversation bodies are never copied or snapshotted."""
import argparse
import contextlib
import datetime
import fnmatch
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.request

try:
    import pysqlite3 as sqlite3
except ImportError:
    import sqlite3

GIB = 1024 ** 3
POLICY_TABLES = ('cl_policies', 'cl_push_policies')
DENIED_DIRS = {'backups', 'backup', 'conversation-logs', 'logs', 'log', '__pycache__',
               'sqlite-tmp', '.cache', '.stversions', 'index-v0.14.0.db'}
DENIED_FILES = ('archive.sqlite*', 'archive-before.sqlite*', '*.log', '*.log.gz',
                '*.log.zst', '*-wal', '*-shm', 'vps-full-*', '*.partial')


class BackupError(RuntimeError):
    pass


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def log(event, **fields):
    print(json.dumps({'at': now(), 'event': event, **fields}), flush=True)


def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def write_json(path, value):
    path = Path(path)
    temporary = path.with_name(path.name + '.partial')
    with temporary.open('w', encoding='utf-8') as stream:
        json.dump(value, stream, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)


def write_checksum(path, checksum, filename):
    path = Path(path)
    temporary = path.with_name(path.name + '.partial')
    with temporary.open('w') as stream:
        stream.write(checksum + '  ' + filename + '\n')
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def command(args, output=None, stdin=None, timeout=300, guard=None):
    # Never include argv/stderr in exceptions: Docker metadata can contain secrets.
    process = subprocess.Popen(args, stdin=stdin, stdout=output or subprocess.PIPE,
                               stderr=subprocess.PIPE, start_new_session=os.name != 'nt')
    try:
        deadline = time.monotonic() + timeout
        while True:
            if guard:
                guard.check()
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise BackupError('Command exceeded its time budget')
            try:
                stdout, _ = process.communicate(timeout=min(1, remaining))
                break
            except subprocess.TimeoutExpired:
                continue
    except BaseException:
        if os.name != 'nt':
            with contextlib.suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGKILL)
        else:
            process.kill()
        process.communicate()
        raise
    if process.returncode:
        raise BackupError(Path(args[0]).name + ' failed (' + str(process.returncode) + ')')
    return '' if output else stdout.decode('utf-8', 'replace')


def inspect_containers():
    ids = command(['docker', 'ps', '-aq']).split()
    return json.loads(command(['docker', 'inspect'] + ids)) if ids else []


def name_of(obj):
    return obj['Name'].lstrip('/')


def excluded(path, config):
    path = Path(path)
    if any(part in DENIED_DIRS for part in path.parts):
        return True
    if any(fnmatch.fnmatch(path.name, pattern) for pattern in DENIED_FILES):
        return True
    for item in config.get('exclude_paths', []):
        base = Path(item)
        if path == base or base in path.parents:
            return True
    return False


def inventory(roots, config):
    files, total = [], 0
    for root in roots:
        root = Path(root)
        if excluded(root, config) or not root.exists():
            continue
        candidates = []
        if root.is_file() or root.is_symlink():
            candidates = [root]
        else:
            for parent, directories, names in os.walk(root, followlinks=False):
                directories[:] = [d for d in directories if not excluded(Path(parent) / d, config)]
                candidates.extend(Path(parent) / n for n in names)
                candidates.extend(Path(parent) / d for d in directories if (Path(parent) / d).is_symlink())
        for path in candidates:
            if excluded(path, config):
                continue
            if path.is_symlink() or path.is_file():
                files.append(path)
                if not path.is_symlink():
                    total += path.stat().st_size
    return sorted(set(files)), total


class SpaceGuard:
    def __init__(self, path, reserve):
        self.path, self.reserve = Path(path), reserve

    def check(self, additional=0):
        if shutil.disk_usage(self.path).free < self.reserve + additional:
            raise BackupError('Business disk reserve would be consumed')


def sqlite_backup(source, destination, guard, timeout=600):
    started = time.monotonic()
    last_report = started
    log('sqlite_snapshot_started', database=Path(source).name)

    def progress(status, remaining, total):
        nonlocal last_report
        guard.check()
        if time.monotonic() - started > timeout:
            raise BackupError('Online SQLite backup exceeded its time budget')
        if time.monotonic() - last_report >= 20:
            log('sqlite_copy_progress', database=Path(source).name, remaining_pages=remaining, total_pages=total)
            last_report = time.monotonic()

    with contextlib.closing(sqlite3.connect(Path(source).as_uri() + '?mode=ro', uri=True, timeout=1)) as src:
        # A WAL read snapshot lets writers commit while preventing repeated restarts
        # of a large incremental backup when another connection changes the source.
        if src.execute('PRAGMA journal_mode').fetchone()[0].lower() == 'wal':
            src.execute('BEGIN')
            src.execute('SELECT rootpage FROM sqlite_master LIMIT 1').fetchone()
        with contextlib.closing(sqlite3.connect(destination)) as dst:
            src.backup(dst, pages=256, progress=progress, sleep=0.05)
            src.rollback()
            log('sqlite_copy_completed', database=Path(source).name)
            if dst.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
                raise BackupError('Copied SQLite database failed integrity check')
    log('sqlite_snapshot_completed', database=Path(source).name)


def copy_file(source, destination, guard):
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if source.is_symlink():
        destination.symlink_to(os.readlink(source))
        return 'symlink'
    with source.open('rb') as stream:
        sqlite = stream.read(16) == b'SQLite format 3\0'
    if sqlite:
        sqlite_backup(source, destination, guard)
    else:
        for attempt in range(3):
            before = source.stat()
            with source.open('rb') as src, destination.open('wb') as dst:
                for block in iter(lambda: src.read(1024 * 1024), b''):
                    guard.check(len(block))
                    dst.write(block)
            after = source.stat()
            if (before.st_ino, before.st_size, before.st_mtime_ns) == (after.st_ino, after.st_size, after.st_mtime_ns):
                break
        else:
            raise BackupError('A configuration file kept changing during backup')
    shutil.copystat(source, destination)
    os.chown(destination, source.stat().st_uid, source.stat().st_gid) if os.name != 'nt' else None
    return 'sqlite' if sqlite else 'file'


def export_conversation_settings(directory, destination):
    """Read only two small policy tables; never clone or scan cl_records."""
    directory, destination = Path(directory), Path(destination)
    source, key = directory / 'archive.sqlite', directory / 'archive.key'
    if not source.exists() or not key.exists() or key.stat().st_size != 32:
        raise BackupError('Conversation policy database/key is missing')
    destination.mkdir(parents=True, mode=0o700)
    with contextlib.closing(sqlite3.connect(source.as_uri() + '?mode=ro', uri=True, timeout=1)) as src:
        src.execute('PRAGMA query_only=ON')
        src.execute('BEGIN')
        rows = {}
        for table in POLICY_TABLES:
            present = src.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone()
            if not present:
                if table == 'cl_policies':
                    raise BackupError('Conversation policy schema is not recognized')
                continue
            values = src.execute('SELECT version,body,at FROM ' + table + ' ORDER BY version').fetchall()
            if sum(len(row[1]) for row in values) > 1024 * 1024:
                raise BackupError('Unexpectedly large conversation configuration')
            rows[table] = values
        src.rollback()
    with contextlib.closing(sqlite3.connect(destination / 'policies.sqlite')) as dst:
        for table, values in rows.items():
            dst.execute('CREATE TABLE ' + table + '(version INTEGER PRIMARY KEY,body BLOB NOT NULL,at INTEGER NOT NULL)')
            dst.executemany('INSERT INTO ' + table + ' VALUES(?,?,?)', values)
        dst.commit()
    shutil.copyfile(key, destination / 'archive.key')
    ownership = {}
    for name, path in (('directory', directory), ('archive.sqlite', source), ('archive.key', key)):
        stat = path.stat()
        ownership[name] = [stat.st_uid, stat.st_gid]
    write_json(destination / 'ownership.json', ownership)
    for path in destination.iterdir():
        os.chmod(path, 0o600)
    return {table: len(values) for table, values in rows.items()}


def restore_conversation_settings(source, target):
    source, target = Path(source), Path(target)
    if target.exists() and any(target.iterdir()):
        raise BackupError('Conversation settings restore requires an empty target directory')
    with contextlib.closing(sqlite3.connect((source / 'policies.sqlite').as_uri() + '?mode=ro', uri=True)) as db:
        tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if not tables <= set(POLICY_TABLES) or 'cl_policies' not in tables:
            raise BackupError('Settings backup contains unexpected tables')
    if (source / 'archive.key').stat().st_size != 32:
        raise BackupError('Invalid conversation key')
    target.mkdir(parents=True, exist_ok=True, mode=0o700)
    shutil.copyfile(source / 'policies.sqlite', target / 'archive.sqlite')
    shutil.copyfile(source / 'archive.key', target / 'archive.key')
    for path in target.iterdir():
        os.chmod(path, 0o600)
    ownership_file = source / 'ownership.json'
    if os.name != 'nt' and ownership_file.exists():
        ownership = json.loads(ownership_file.read_text())
        os.chown(target, *ownership['directory'])
        for name in ('archive.sqlite', 'archive.key'):
            os.chown(target / name, *ownership[name])


def redis_args(obj):
    env = dict(v.split('=', 1) for v in obj['Config'].get('Env', []) if '=' in v)
    password = env.get('REDISCLI_AUTH') or env.get('REDIS_PASSWORD')
    args = obj['Config'].get('Cmd') or []
    if len(args) >= 3 and args[0] in ('sh', '/bin/sh', 'bash', '/bin/bash') and args[1] == '-c':
        args = shlex.split(args[2])
    if not password and '--requirepass' in args:
        password = args[args.index('--requirepass') + 1]
    return ['docker', 'exec'] + (['-e', 'REDISCLI_AUTH=' + password] if password else []) + [name_of(obj), 'redis-cli', '--raw']


def redis_snapshot(obj, destination):
    args, started = redis_args(obj), time.monotonic()

    def info():
        return dict(line.split(':', 1) for line in command(args + ['INFO', 'persistence'], timeout=15).splitlines() if ':' in line and not line.startswith('#'))

    while info().get('rdb_bgsave_in_progress') == '1':
        if time.monotonic() - started > 120:
            raise BackupError('Redis background snapshot timed out')
        time.sleep(1)
    response = command(args + ['BGSAVE'], timeout=15).strip()
    if response != 'Background saving started':
        raise BackupError('Redis refused the background snapshot')
    while True:
        state = info()
        if state.get('rdb_bgsave_in_progress') == '0':
            if state.get('rdb_last_bgsave_status') != 'ok':
                raise BackupError('Redis background snapshot failed')
            break
        if time.monotonic() - started > 120:
            raise BackupError('Redis background snapshot timed out')
        time.sleep(1)
    directory = command(args + ['CONFIG', 'GET', 'dir']).splitlines()
    filename = command(args + ['CONFIG', 'GET', 'dbfilename']).splitlines()
    if len(directory) != 2 or len(filename) != 2 or '/' in filename[1]:
        raise BackupError('Redis snapshot location is not recognized')
    command(['docker', 'cp', name_of(obj) + ':' + directory[1].rstrip('/') + '/' + filename[1], str(destination)])


def health(config, repair=False, wait=0):
    maintenance = set()
    maintenance_file = Path(config.get('maintenance_file', '/run/sub2api-backup-maintenance.json'))
    if maintenance_file.exists():
        maintenance = set(json.loads(maintenance_file.read_text()))
    repaired = set()
    deadline = time.monotonic() + wait
    while True:
        objects = {name_of(o): o for o in inspect_containers()}
        failures = []
        for name in config['expected_containers']:
            if name in maintenance:
                continue
            obj = objects.get(name)
            if not obj:
                failures.append(name + ':missing')
            elif not obj['State']['Running']:
                if repair and name not in repaired and obj['State']['Status'] in ('exited', 'created'):
                    command(['docker', 'start', name], timeout=60)
                    repaired.add(name)
                failures.append(name + ':stopped')
            elif obj['State'].get('Health', {}).get('Status', 'healthy') != 'healthy':
                failures.append(name + ':unhealthy')
        for unit in config.get('expected_units', []):
            if unit in maintenance:
                continue
            result = subprocess.run(['systemctl', 'is-active', '--quiet', unit], check=False)
            if result.returncode:
                if repair and unit not in repaired:
                    command(['systemctl', 'start', unit], timeout=60)
                    repaired.add(unit)
                failures.append(unit + ':inactive')
        for url in config.get('health_urls', []):
            try:
                with urllib.request.urlopen(url, timeout=3) as response:
                    if response.status != 200:
                        failures.append('http:unhealthy')
            except Exception:
                failures.append('http:unreachable')
        if not failures or time.monotonic() >= deadline:
            return {'healthy': not failures, 'failures': failures, 'repaired': sorted(repaired), 'maintenance': sorted(maintenance)}
        time.sleep(2)


def compression(source_args, destination, guard):
    producer = subprocess.Popen(source_args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)
    consumer = None
    try:
        with Path(destination).open('wb') as stream:
            consumer = subprocess.Popen(['zstd', '-T1', '-3', '-q'], stdin=producer.stdout,
                                        stdout=stream, stderr=subprocess.DEVNULL, start_new_session=True)
            producer.stdout.close()
            started = time.monotonic()
            while consumer.poll() is None:
                guard.check()
                if time.monotonic() - started > 900:
                    raise BackupError('Backup compression exceeded its time budget')
                time.sleep(0.5)
            if producer.wait(timeout=15) or consumer.returncode:
                raise BackupError('Backup stream or compression failed')
    finally:
        for process in (producer, consumer):
            if process and process.poll() is None:
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(process.pid, signal.SIGKILL)
                process.wait()


def save_images(objects, root, work, guard):
    target = root / 'images'
    target.mkdir(mode=0o700, exist_ok=True)
    artifacts = {}
    for image_id in sorted({obj['Image'] for obj in objects}):
        identity = image_id.removeprefix('sha256:')
        if len(identity) != 64 or any(c not in '0123456789abcdef' for c in identity):
            raise BackupError('Invalid image identity')
        relative = 'images/' + identity + '.tar.zst'
        destination = root / relative
        checksum_file = destination.with_name(destination.name + '.sha256')
        expected = checksum_file.read_text().split() if checksum_file.exists() else []
        valid = destination.is_file() and bool(expected) and digest(destination) == expected[0]
        if not valid:
            temporary = work / (identity + '.image.partial')
            compression(['docker', 'image', 'save', image_id], temporary, guard)
            checksum = digest(temporary)
            with temporary.open('rb+') as stream:
                os.fsync(stream.fileno())
            os.replace(temporary, destination)
            write_checksum(checksum_file, checksum, destination.name)
            os.chmod(destination, 0o600)
            os.chmod(checksum_file, 0o600)
        artifacts[image_id] = {'archive': relative, 'sha256': digest(destination), 'bytes': destination.stat().st_size}
        log('image_available', image=identity[:12])
    return artifacts


def verify_payload_paths(paths):
    for path in paths:
        parts = Path(path).parts
        if 'conversation-logs' in parts or any(part in ('backups', 'backup', 'logs', 'log') for part in parts):
            raise BackupError('Forbidden data category found in backup payload')
        if any(fnmatch.fnmatch(Path(path).name, pattern) for pattern in DENIED_FILES):
            raise BackupError('Forbidden file found in backup payload')


def prune(root, keep, max_bytes):
    reports = []
    for path in sorted(root.glob('vps-online-*.tar.zst.report.json'), reverse=True):
        data = json.loads(path.read_text())
        if data.get('completed'):
            reports.append((path, data))
    used = sum(p.stat().st_size for p in root.rglob('*') if p.is_file() and not p.is_symlink())
    while len(reports) > 1 and (len(reports) > keep or used > max_bytes):
        report_path, data = reports.pop()
        archive = root / data['archive']
        if archive.parent != root or not archive.name.startswith('vps-online-'):
            raise BackupError('Invalid retention record')
        for suffix in ('', '.sha256', '.restore-verified.json', '.report.json'):
            path = archive.with_name(archive.name + suffix)
            if path.is_file():
                used -= path.stat().st_size
                path.unlink()
    needed = {image['archive'] for _, report in reports for image in report.get('image_artifacts', {}).values()}
    for path in (root / 'images').glob('*.tar.zst'):
        if path.relative_to(root).as_posix() not in needed:
            path.unlink()
            path.with_name(path.name + '.sha256').unlink(missing_ok=True)


def load_config(path):
    config = json.loads(Path(path).read_text(encoding='utf-8'))
    for field in ('backup_root', 'work_root', 'lock_file'):
        p = Path(config[field])
        if not p.is_absolute() or p.is_symlink() or '..' in p.parts or len(p.parts) < 3:
            raise BackupError('Unsafe configured path: ' + field)
    return config


@contextlib.contextmanager
def lock(config):
    import fcntl
    with open(config['lock_file'], 'a') as stream:
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise BackupError('Another backup is already running')
        yield


def run(config):
    if sqlite3.sqlite_version_info < (3, 37, 0):
        raise BackupError('SQLite >= 3.37 is required for business databases')
    root, work_root = Path(config['backup_root']), Path(config['work_root'])
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    work_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    guard = SpaceGuard(work_root, int(config.get('reserve_gib', 10) * GIB))
    initial = health(config)
    if not initial['healthy']:
        raise BackupError('Required services are not healthy before backup')
    objects = inspect_containers()
    by_name = {name_of(o): o for o in objects}
    objects = [by_name[name] for name in config['expected_containers']]
    for required in config.get('required_paths', []):
        if not Path(required).exists():
            raise BackupError('A required deployment path is missing')
    roots = list(config['paths'])
    databases = set(config['postgres']) | set(config['redis'])
    for obj in objects:
        if name_of(obj) not in databases:
            roots.extend(m['Source'] for m in obj['Mounts'] if m['Type'] in ('bind', 'volume'))
    roots = sorted({p for p in roots if not any(Path(q) in Path(p).parents for q in roots if q != p)})
    files, size = inventory(roots, config)
    verify_payload_paths([str(p).lstrip('/') for p in files])
    image_sizes = sum(json.loads(command(['docker', 'image', 'inspect', i]))[0]['Size'] for i in {o['Image'] for o in objects})
    # Budget both the raw staging copy and an uncompressible archive, plus exports/images.
    estimate = 2 * size + 2 * int(config.get('export_budget_gib', 4) * GIB) + image_sizes
    guard.check(estimate)
    log('preflight_ok', source_bytes=size, required_extra_bytes=estimate, excluded_conversation_bodies=True)
    stamp = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).strftime('%Y%m%d-%H%M%S-BJT')
    with tempfile.TemporaryDirectory(prefix='run-', dir=work_root) as temporary:
        work = Path(temporary)
        stage = work / 'payload'
        stage.mkdir(mode=0o700)
        for directory in ('database', 'runtime', 'conversation-settings'):
            (stage / directory).mkdir(mode=0o700)
        metadata = {'schema': 2, 'timestamp': stamp, 'started_at': now(), 'consistency': 'per-database-online-snapshots',
                    'conversation_records_included': False, 'containers': objects, 'postgres': {}, 'sqlite': [],
                    'excluded_directories': sorted(DENIED_DIRS), 'images': {}, 'runtime_files': config.get('runtime_files', [])}
        for obj in objects:
            image_id = obj['Image']
            metadata['images'][name_of(obj)] = {'id': image_id, 'configured_image': obj['Config']['Image'],
                                               'repo_digests': json.loads(command(['docker', 'image', 'inspect', image_id]))[0].get('RepoDigests', [])}
        for container, database in config['postgres'].items():
            record = {'started_at': now(), 'container': container}
            with (stage / 'database' / (database + '.dump')).open('wb') as stream:
                command(['docker', 'exec', container, 'sh', '-c',
                         'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -Z1 --lock-wait-timeout=5s'], output=stream, timeout=600, guard=guard)
            with (stage / 'database' / (database + '-globals.private.sql')).open('wb') as stream:
                command(['docker', 'exec', container, 'sh', '-c', 'exec pg_dumpall -U "$POSTGRES_USER" --globals-only'], output=stream)
            with (stage / 'database' / (database + '.dump')).open('rb') as stream:
                command(['docker', 'exec', '-i', container, 'pg_restore', '--list'], stdin=stream)
            record['finished_at'] = now()
            metadata['postgres'][database] = record
            guard.check()
            log('postgres_exported', database=database)
        for container in config['redis']:
            redis_snapshot(by_name[container], stage / 'runtime' / (container + '.rdb'))
            guard.check()
            log('redis_exported', container=container)
        for source in files:
            guard.check()
            if not source.exists() and not source.is_symlink():
                raise BackupError('A selected backup source disappeared')
            relative = 'files/' + str(source).lstrip('/')
            kind = copy_file(source, stage / relative, guard)
            if kind == 'sqlite':
                metadata['sqlite'].append(relative)
        for entry in config.get('conversation_directories', []):
            metadata['conversation_settings'] = export_conversation_settings(entry, stage / 'conversation-settings' / 'operations-center')
        for entry in config.get('runtime_files', []):
            destination = stage / entry['target']
            destination.parent.mkdir(parents=True, exist_ok=True)
            command(['docker', 'cp', '-L', entry['container'] + ':' + entry['path'], str(destination)])
        metadata['image_artifacts'] = save_images(objects, root, work, guard)
        (stage / 'root.crontab').write_text(command(['crontab', '-l']))
        hashes = {}
        links = {}
        for path in stage.rglob('*'):
            relative = str(path.relative_to(stage))
            if path.is_symlink():
                links[relative] = os.readlink(path)
            elif path.is_file():
                hashes[relative] = digest(path)
        verify_payload_paths(list(hashes) + list(links))
        metadata.update({'sha256': hashes, 'symlinks': links, 'finished_at': now()})
        write_json(stage / 'manifest.private.json', metadata)
        archive_name = 'vps-online-' + stamp + '.tar.zst'
        temporary_archive = work / (archive_name + '.partial')
        compression(['tar', '--acls', '--xattrs', '--numeric-owner', '-C', str(stage), '-cf', '-', '.'], temporary_archive, guard)
        checksum = digest(temporary_archive)
        final_health = health(config, wait=10)
        if not final_health['healthy']:
            raise BackupError('Service health check failed after backup')
        current = {name_of(o): o for o in inspect_containers()}
        for obj in objects:
            current_obj = current.get(name_of(obj), {})
            if (current_obj.get('Id'), current_obj.get('Image'), current_obj.get('State', {}).get('StartedAt')) != (obj['Id'], obj['Image'], obj['State']['StartedAt']):
                raise BackupError('A business container changed during the online backup')
        with temporary_archive.open('rb') as stream:
            os.fsync(stream.fileno())
        os.replace(temporary_archive, root / archive_name)
        write_checksum(root / (archive_name + '.sha256'), checksum, archive_name)
        report = {'schema': 2, 'archive': archive_name, 'sha256': checksum, 'bytes': (root / archive_name).stat().st_size,
                  'source_bytes': size, 'hashed_files': len(hashes), 'sqlite_backups': len(metadata['sqlite']),
                  'completed': True, 'services_healthy': True, 'conversation_records_included': False,
                  'image_artifacts': metadata['image_artifacts'], 'started_at': metadata['started_at'], 'finished_at': now()}
        write_json(root / (archive_name + '.report.json'), report)
        prune(root, config.get('keep', 7), int(config.get('max_backup_gib', 40) * GIB))
        log('backup_completed', archive=archive_name, bytes=report['bytes'], conversation_records_included=False)


def finalize(config):
    with lock(config):
        work_root = Path(config['work_root'])
        if work_root.exists():
            for path in work_root.glob('run-*'):
                if path.is_dir() and not path.is_symlink():
                    shutil.rmtree(path)
    result = health(config, repair=True, wait=90)
    log('service_health', **result)
    return 0 if result['healthy'] else 1


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=('run', 'plan', 'health', 'finalize', 'restore-conversation-settings'))
    parser.add_argument('--config', default='/etc/sub2api-online-backup.json')
    parser.add_argument('--source')
    parser.add_argument('--target')
    args = parser.parse_args()
    if args.action == 'restore-conversation-settings':
        restore_conversation_settings(args.source, args.target)
        return 0
    config = load_config(args.config)
    if args.action == 'health':
        result = health(config)
        log('service_health', **result)
        return 0 if result['healthy'] else 1
    if args.action == 'finalize':
        return finalize(config)
    if args.action == 'plan':
        objects = {name_of(o): o for o in inspect_containers()}
        roots = list(config['paths'])
        for name in config['expected_containers']:
            if name not in set(config['postgres']) | set(config['redis']):
                roots.extend(m['Source'] for m in objects[name]['Mounts'])
        roots = sorted({p for p in roots if not any(Path(q) in Path(p).parents for q in roots if q != p)})
        files, size = inventory(roots, config)
        verify_payload_paths([str(p).lstrip('/') for p in files])
        log('backup_plan', files=len(files), source_bytes=size, conversation_records_included=False,
            conversation_policy_tables=list(POLICY_TABLES), excluded_directories=sorted(DENIED_DIRS))
        return 0
    def interrupted(signum, frame):
        raise BackupError('Backup interrupted by signal ' + str(signum))
    signal.signal(signal.SIGTERM, interrupted)
    with lock(config):
        run(config)
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        log('backup_failed', error=type(error).__name__, reason=str(error) if isinstance(error, BackupError) else 'See private service diagnostics')
        sys.exit(1)
