# 2026-11-17 backup repair

All times below use Asia/Shanghai. This change was explicitly authorized after
the 03:00 backup incident. No application image upgrade, source push or release
was performed.

## Cause and cleanup

The legacy `/root/syncthing/scripts/backup-all.sh` forwarded to
`/usr/local/libexec/vps-full-backup.py`. The executor stopped business containers,
copied conversation history and old backups, and exhausted available storage.
Its recovery attempted container startup before deleting temporary data, so
startup failed. There was no corresponding host or Docker daemon reboot.

Sources included 20.13 GiB of live conversation archives, 28.94 GiB of historical
maintenance backups and 6.44 GiB of other files, before database/image exports.
This exceeded the approximately 38 GiB available at the time.

After checking live mounts and open files, 60 historical items were removed only
from `/root/sub2api-deploy/backups`, `/root/sub2api-extra/backups` and
`/root/syncthing/backups`. Physical free space increased by approximately 61 GiB
after XFS completed reclamation. Existing live conversation history, its key,
financial databases, volumes and application configuration were preserved.

Cleanup evidence and the original small control files are retained under
`/root/vps-backup-maintenance-20261117`. Previously documented historical backup
paths under the three cleanup roots must no longer be treated as recovery points.
The four containers left stopped by the incident were started before establishing
the baseline for the online backup.

## Installed policy

The sole cron job runs at 03:00 with `CRON_TZ=Asia/Shanghai`; it starts
`sub2api-online-backup.service`. Both the legacy executor entry and QuickEnv now
forward to this shared integration. Syncthing synchronizes the resulting backup
set and does not run another independent full backup.

The installed inventory is `/etc/sub2api-online-backup.json`; it lists sixteen
containers and three native services. The executor never stops business services.
It excludes conversation records/history/push jobs, nested backups, logs, caches
and raw PostgreSQL data. Only encrypted conversation policies and their original
key are retained, so recovery intentionally starts with an empty conversation
history. PostgreSQL, Redis and other SQLite databases use online snapshots.

The job reserves 10 GiB for business data and checks space during copying and
compression. Its independent finalizer removes abandoned staging before checking
and starting unexpectedly stopped required services. Maintenance exemptions are
explicit. Retention targets seven successful daily archives and 40 GiB, while
preserving the last successful recovery point.

## Acceptance evidence

Windows and server Linux each passed all twelve focused tests. The three modified
QuickEnv shell scripts passed Linux `bash -n`; Python compilation, installed
systemd unit validation and scoped whitespace checks passed.

The first online trial safely failed on a continually changing large SQLite
source: no successful archive was published, staging was cleaned and services
remained healthy. A fixed WAL read transaction resolved the copy restarts; the
source snapshot is released as soon as copying finishes.

The corrected full run completed from 05:23:16 to 05:32:04:

- Archive: `vps-online-20261117-052316-BJT.tar.zst`, 2,334,134,025 bytes.
- Archive SHA-256: `2a54b5a1fd75a6f652506675a2618baf01c28fe78cae481da3c5df8fcc275e6f`.
- Inventory: 1,092 hashed payload files and eleven online SQLite snapshots.
- Shared image artifacts: sixteen immutable images, 1,287,019,470 bytes in total.
- Manifest and report: `conversation_records_included=false`.
- All sixteen business container IDs, image IDs and start times matched baseline;
  final health checks needed no recovery starts.

The archive and all sixteen referenced images reached
`E:\syncthing-windows-amd64-v2.0.16\server-backup` through Syncthing. Every local
archive/image SHA-256 matched the server report; synchronization had zero pending
files or errors.

The independent restore verification completed from 05:34:10 to 05:47:54:

- All 1,092 payload hashes, twelve SQLite databases (including the policy-only
  database), forbidden-path checks and sixteen loaded image identities passed.
- PostgreSQL `sub2api` restored with 109 application tables; `new-api` restored
  with 37 application tables. Role exports and both native dumps restored without
  ignored SQL errors.
- Both Redis RDB snapshots loaded successfully.
- The deployed operations-center image decrypted the original policy settings;
  its newly initialized conversation archive contained zero records.
- Test containers used `--network none` with no published host ports. All test
  containers and extracted staging directories were removed after verification.

The resulting `.restore-verified.json` report also reached the Windows receive
folder. At 05:49:05 all sixteen business container identities/start times still
matched baseline, all required containers/native services and the Sub2API health
endpoint were healthy, no temporary work remained, and root free space was
94.65 GiB. Detailed final checks are in the server maintenance directory's
`final-acceptance.json`. The next scheduled backup is 2026-11-18 at 03:00.

This verifies database recovery and artifact integrity, not a complete replacement
host boot. Snapshots are consistent per database rather than one shared global
transaction; follow the recovery procedure and reconcile operator state against
native financial records before resuming jobs on a replacement host.
