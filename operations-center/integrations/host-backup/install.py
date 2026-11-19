#!/usr/bin/env python3
"""Install the single host backup executor; never restart business containers."""
import argparse
import os
from pathlib import Path
import shutil
import subprocess


def install(source, config, manage_cron=True):
    if os.geteuid() != 0:
        raise RuntimeError('Run the host backup installer as root')
    target = Path('/usr/local/libexec/sub2api-online-backup')
    target.mkdir(parents=True, exist_ok=True, mode=0o700)
    for name in ('vps_backup.py', 'verify_backup.py', 'install.py', 'sub2api-online-backup.service',
                 'README.md', 'PRODUCTION-20261117.md'):
        destination = target / name
        if (source / name).resolve() != destination.resolve():
            shutil.copyfile(source / name, destination)
        os.chmod(destination, 0o600 if name.endswith('.md') else 0o700)
    config_target = Path('/etc/sub2api-online-backup.json')
    if config.resolve() != config_target:
        shutil.copyfile(config, config_target)
    os.chmod(config_target, 0o600)
    shutil.copyfile(source / 'sub2api-online-backup.service', '/etc/systemd/system/sub2api-online-backup.service')
    os.chmod('/etc/systemd/system/sub2api-online-backup.service', 0o644)
    wrapper = Path('/root/syncthing/scripts/backup-all.sh')
    wrapper.parent.mkdir(parents=True, exist_ok=True)
    wrapper.write_text('#!/bin/bash\nset -euo pipefail\nexec systemctl start sub2api-online-backup.service\n')
    os.chmod(wrapper, 0o700)
    legacy = Path('/usr/local/libexec/vps-full-backup.py')
    legacy.write_text('#!/usr/bin/env python3\nimport os\nos.execvp("systemctl", ["systemctl", "start", "sub2api-online-backup.service"])\n')
    os.chmod(legacy, 0o700)
    verifier = Path('/usr/local/libexec/vps-backup-verify.py')
    verifier.write_text('#!/usr/bin/env python3\nimport os,sys\nos.execv("/usr/bin/python3", ["python3", "/usr/local/libexec/sub2api-online-backup/verify_backup.py", "--restore"] + sys.argv[1:])\n')
    os.chmod(verifier, 0o700)
    if manage_cron:
        result = subprocess.run(['crontab', '-l'], stdout=subprocess.PIPE, check=False)
        lines = [line for line in result.stdout.decode().splitlines()
                 if '/root/syncthing/scripts/backup-all.sh' not in line and '/usr/local/libexec/vps-full-backup.py' not in line]
        # Leave other jobs in their existing timezone; scope the timezone to our last job.
        if not lines or lines[-1] != 'CRON_TZ=Asia/Shanghai':
            lines.append('CRON_TZ=Asia/Shanghai')
        lines.append('0 3 * * * /root/syncthing/scripts/backup-all.sh >> /root/syncthing/backups/cron.log 2>&1')
        subprocess.run(['crontab', '-'], input=('\n'.join(lines) + '\n').encode(), check=True)
    subprocess.run(['systemctl', 'daemon-reload'], check=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--no-cron', action='store_true')
    args = parser.parse_args()
    install(Path(__file__).resolve().parent, args.config, not args.no_cron)
