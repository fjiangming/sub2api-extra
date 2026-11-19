#!/usr/bin/env python3
"""Restore this deployment only if the live file still matches its installed hash."""

import fcntl
import hashlib
import json
from pathlib import Path
import runpy
import sys


def main():
    backup = Path(sys.argv[1]).resolve(strict=True)
    allowed = Path('/root/sub2api-deploy/backups').resolve()
    if not backup.is_relative_to(allowed) or not backup.name.startswith('epoint-domain-migration-'):
        raise RuntimeError('Unexpected backup directory')
    helpers = runpy.run_path(str(Path(__file__).with_name('install-nginx.py')))
    with open('/run/lock/yunhop-domain.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        manifest_path = backup / 'manifest.json'
        manifest = json.loads(manifest_path.read_text())
        target = Path(manifest['configuration'])
        if target != helpers['CONFIG']:
            raise RuntimeError('Unexpected rollback target')
        sha = lambda data: hashlib.sha256(data).hexdigest()
        original = backup / 'migrated-services.conf.before'
        if not manifest.get('applied') or sha(target.read_bytes()) != manifest['after_sha256'] or sha(original.read_bytes()) != manifest['before_sha256']:
            raise RuntimeError('Live or backup content changed; do not overwrite subsequent maintenance')
        installed = target.read_bytes()
        helpers['atomic_write'](target, original.read_bytes(), original)
        try:
            helpers['validate']()
        except Exception:
            helpers['atomic_write'](target, installed, original)
            raise
        helpers['run']('systemctl', 'reload', 'nginx')
        manifest['applied'] = False
        manifest['rolled_back'] = True
        manifest_path.write_text(json.dumps(manifest, indent=2))
        print(json.dumps({'rolled_back': True, 'backup': str(backup)}))


if __name__ == '__main__':
    main()
