from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
import sys
from unittest.mock import patch

import vps_backup as backup


class NoLimit:
    def check(self, additional=0):
        pass


class BackupTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def test_exclusion_before_any_conversation_file_read(self):
        source = self.root / 'business'
        for name in ('conversation-logs/archive.sqlite', 'conversation-logs/archive.key',
                     'backups/old/archive-before.sqlite', 'logs/request.log', 'data/ok.txt',
                     'billing-recovery/state.sqlite', 'config.env'):
            path = source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'fixture')
        files, size = backup.inventory([str(source)], {})
        actual = {str(p.relative_to(source)).replace('\\', '/') for p in files}
        self.assertEqual(actual, {'data/ok.txt', 'billing-recovery/state.sqlite', 'config.env'})
        self.assertEqual(size, 21)

    def test_configured_raw_postgres_directory_is_excluded(self):
        source = self.root / 'business'
        raw = source / 'postgres_data'
        raw.mkdir(parents=True)
        (raw / 'sensitive').write_text('raw')
        (source / 'compose.yaml').write_text('config')
        files, _ = backup.inventory([str(source)], {'exclude_paths': [str(raw)]})
        self.assertEqual([p.name for p in files], ['compose.yaml'])

    def test_policy_only_export_and_restore_keeps_ciphertext_and_key(self):
        source = self.root / 'conversation-logs'
        source.mkdir()
        key = os.urandom(32)
        (source / 'archive.key').write_bytes(key)
        with closing(sqlite3.connect(source / 'archive.sqlite')) as db, db:
            for table in backup.POLICY_TABLES:
                db.execute('CREATE TABLE ' + table + '(version INTEGER PRIMARY KEY,body BLOB,at INTEGER)')
                db.execute('INSERT INTO ' + table + ' VALUES(7,?,10)', (b'ciphertext-fixture',))
            db.execute('CREATE TABLE cl_records(original BLOB,masked BLOB)')
            db.execute('INSERT INTO cl_records VALUES(?,?)', (b'NEVER-BACK-UP-THIS-BODY', b'NEVER-BACK-UP-THIS-BODY'))
        destination = self.root / 'settings'
        backup.export_conversation_settings(source, destination)
        self.assertNotIn(b'NEVER-BACK-UP-THIS-BODY', (destination / 'policies.sqlite').read_bytes())
        restored = self.root / 'restored'
        backup.restore_conversation_settings(destination, restored)
        self.assertEqual((restored / 'archive.key').read_bytes(), key)
        with closing(sqlite3.connect(restored / 'archive.sqlite')) as db:
            self.assertEqual({r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}, set(backup.POLICY_TABLES))
            self.assertEqual(db.execute('SELECT body FROM cl_policies').fetchone()[0], b'ciphertext-fixture')
        with self.assertRaises(backup.BackupError):
            backup.restore_conversation_settings(destination, restored)

    def test_online_sqlite_backup_reads_committed_wal_without_stopping_writer(self):
        source = self.root / 'business.sqlite'
        with closing(sqlite3.connect(source)) as db, db:
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('CREATE TABLE payments(id INTEGER PRIMARY KEY, amount INTEGER)')
            db.execute('INSERT INTO payments VALUES(1,100)')
            db.commit()
            destination = self.root / 'snapshot.sqlite'
            backup.sqlite_backup(source, destination, NoLimit())
            db.execute('INSERT INTO payments VALUES(2,200)')
            db.commit()
            with closing(sqlite3.connect(destination)) as restored:
                self.assertEqual(restored.execute('SELECT * FROM payments').fetchall(), [(1, 100)])

    def test_space_protection_aborts_sqlite_copy(self):
        source = self.root / 'business.sqlite'
        with closing(sqlite3.connect(source)) as db, db:
            db.execute('CREATE TABLE example(value TEXT)')
        class Full:
            def check(self, additional=0):
                raise backup.BackupError('disk reserve')
        with self.assertRaises(backup.BackupError):
            backup.sqlite_backup(source, self.root / 'failed.sqlite', Full())

    def test_wal_writer_commits_during_backup_without_changing_its_snapshot(self):
        source = self.root / 'active.sqlite'
        with closing(sqlite3.connect(source)) as writer, writer:
            writer.execute('PRAGMA journal_mode=WAL')
            writer.execute('CREATE TABLE events(value BLOB)')
            writer.executemany('INSERT INTO events VALUES(?)', [(b'x' * 4096,)] * 400)
            writer.commit()
            class WriterGuard:
                committed = False
                def check(self, additional=0):
                    if not self.committed:
                        writer.execute('INSERT INTO events VALUES(?)', (b'new-during-backup',))
                        writer.commit()
                        self.committed = True
            guard = WriterGuard()
            destination = self.root / 'stable.sqlite'
            backup.sqlite_backup(source, destination, guard)
            self.assertTrue(guard.committed)
            self.assertEqual(writer.execute('SELECT count(*) FROM events').fetchone()[0], 401)
            with closing(sqlite3.connect(destination)) as snapshot:
                self.assertEqual(snapshot.execute('SELECT count(*) FROM events').fetchone()[0], 400)

    def test_payload_gate_rejects_body_and_nested_backup_paths(self):
        for path in ('files/volume/conversation-logs/archive.sqlite', 'files/app/backups/config',
                     'files/volume/archive-before.sqlite', 'files/app/logs/request.log'):
            with self.assertRaises(backup.BackupError):
                backup.verify_payload_paths([path])
        backup.verify_payload_paths(['conversation-settings/operations-center/policies.sqlite', 'runtime/sub2api.binary'])

    def test_retention_preserves_last_recovery_point_and_its_image(self):
        root = self.root
        (root / 'images').mkdir()
        (root / 'images' / 'needed.tar.zst').write_bytes(b'image')
        for index in range(3):
            name = 'vps-online-000' + str(index) + '.tar.zst'
            (root / name).write_bytes(b'archive')
            (root / (name + '.sha256')).write_text('sum')
            backup.write_json(root / (name + '.report.json'), {'completed': True, 'archive': name,
                              'image_artifacts': {'id': {'archive': 'images/needed.tar.zst'}}})
        backup.prune(root, 7, 1)
        self.assertEqual(len(list(root.glob('*.tar.zst'))), 1)
        self.assertTrue((root / 'vps-online-0002.tar.zst').exists())
        self.assertTrue((root / 'images' / 'needed.tar.zst').exists())

    def test_health_never_starts_a_maintenance_container(self):
        maintenance = self.root / 'maintenance.json'
        maintenance.write_text(json.dumps(['intentionally-stopped']))
        config = {'expected_containers': ['intentionally-stopped'], 'maintenance_file': str(maintenance)}
        with patch.object(backup, 'inspect_containers', return_value=[]), patch.object(backup, 'command') as command:
            result = backup.health(config, repair=True)
        self.assertTrue(result['healthy'])
        command.assert_not_called()

    def test_redis_uses_background_snapshot_and_copies_its_configured_path(self):
        calls = []
        def execute(args, **kwargs):
            calls.append(args)
            if args[-2:] == ['INFO', 'persistence']:
                return 'rdb_bgsave_in_progress:0\nrdb_last_bgsave_status:ok\n'
            if args[-1] == 'BGSAVE':
                return 'Background saving started\n'
            if args[-3:] == ['CONFIG', 'GET', 'dir']:
                return 'dir\n/data\n'
            if args[-3:] == ['CONFIG', 'GET', 'dbfilename']:
                return 'dbfilename\nsnapshot.rdb\n'
            return ''
        obj = {'Name': '/redis', 'Config': {'Env': [], 'Cmd': []}}
        with patch.object(backup, 'command', side_effect=execute):
            backup.redis_snapshot(obj, self.root / 'redis.rdb')
        self.assertTrue(any(args[-1] == 'BGSAVE' for args in calls))
        self.assertFalse(any(args[-1] == 'SAVE' for args in calls))
        self.assertEqual(calls[-1][2], 'redis:/data/snapshot.rdb')

    def test_command_timeout_terminates_the_child(self):
        with self.assertRaises(backup.BackupError):
            backup.command([sys.executable, '-c', 'import time;time.sleep(30)'], timeout=0.1)

    def test_interrupted_image_checksum_is_rebuilt_then_reused(self):
        identity = 'a' * 64
        root, work = self.root / 'output', self.root / 'work'
        (root / 'images').mkdir(parents=True)
        work.mkdir()
        artifact = root / 'images' / (identity + '.tar.zst')
        artifact.write_bytes(b'incomplete')
        artifact.with_name(artifact.name + '.sha256').write_text('')
        def compress(args, destination, guard):
            Path(destination).write_bytes(b'image-fixture')
        with patch.object(backup, 'compression', side_effect=compress) as compression:
            first = backup.save_images([{'Image': 'sha256:' + identity}], root, work, NoLimit())
            second = backup.save_images([{'Image': 'sha256:' + identity}], root, work, NoLimit())
        self.assertEqual(compression.call_count, 1)
        self.assertEqual(first, second)
        self.assertEqual(artifact.read_bytes(), b'image-fixture')


if __name__ == '__main__':
    unittest.main()
