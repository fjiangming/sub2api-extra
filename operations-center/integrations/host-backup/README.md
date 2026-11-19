# Online host backup

One host executor, installed by QuickEnv or directly from this directory. Source,
health rules and policy export live in the operations center. It does not require
rebuilding or restarting the application images.

Deployment and acceptance evidence: [2026-11-17 repair](PRODUCTION-20261117.md).

The schema-2 backup deliberately excludes **all conversation records**, their
metadata, history and pending push jobs. Only encrypted `cl_policies` and
`cl_push_policies` plus the original 32-byte `archive.key` are exported. This is
not a conversation history backup. Restoring settings creates an empty archive;
the application initializes its event tables and fresh push cursor on startup.

Old maintenance backups, nested backup directories, application/Docker log
archives, caches and live PostgreSQL directories are excluded before opening
files. A second payload check refuses to publish forbidden paths. Financial
databases, native PostgreSQL exports, Redis RDBs, application configuration,
keys, certificates and the actual Sub2API executable remain recoverable.

## Installation

Review `server-config.example.json` against the actual host inventory first.
The example describes the sixteen-container deployment on 2026-11-17; required
services/paths must not be silently omitted on another host.

```sh
python3 install.py --config server-config.example.json
python3 /usr/local/libexec/sub2api-online-backup/vps_backup.py plan
python3 /usr/local/libexec/sub2api-online-backup/vps_backup.py health
systemctl start sub2api-online-backup.service
journalctl -u sub2api-online-backup.service
```

The installer replaces only the existing backup cron entry with 03:00
Asia/Shanghai and a wrapper starting the oneshot service. No second timer is
installed. `ExecStopPost` checks services and cleans abandoned staging even if
the main process was killed. It can start an unexpectedly stopped required
service; it never restarts a running/unhealthy database or application. Declare
intentional maintenance in `/run/sub2api-backup-maintenance.json` as a JSON array
of container/systemd names. Remove the file when maintenance ends.

PostgreSQL uses consistent online `pg_dump`; SQLite uses its online backup API;
Redis uses BGSAVE. These are per-database snapshots, not a global transaction.
Ordinary files must remain stable during their individual copy. Container
identity/image/start times must remain unchanged during the backup. CPU/IO are
limited by systemd; online backup still consumes shared storage resources.

The space budget includes staging, incompressible output, exports and image
artifacts plus a 10 GiB business reserve. Space is checked during database/file
copy and compression. Failed jobs publish no success report. Seven successful
daily archives and a 40 GiB budget are targets; retention never removes the last
successful recovery point merely to satisfy the budget. Backup failures appear
as a failed systemd unit with structured journal events.

## Archive and verification

`vps-online-*.tar.zst`, `.sha256` and `.report.json` are stored in the Syncthing
backup folder. `images/<image-id>.tar.zst` is saved once per immutable image and
referenced by the daily manifest. **Copy the images directory as well as the
daily archive**. Syncthing already shares their common parent. No daily Docker
commit or export of the running writable layer occurs. The actual updated main
binary is separately saved under `runtime/sub2api.binary`.

```sh
python3 /usr/local/libexec/sub2api-online-backup/verify_backup.py ARCHIVE --restore
```

Verification checks archive/file/image hashes, SQLite integrity and forbidden
paths. `--restore` loads both PostgreSQL dumps and Redis RDBs in disposable,
network-isolated containers without host ports, then uses the deployed
operations-center image to decrypt policy-only settings with an empty history.
Only containers with the generated `vps-online-verify-` prefix are removed.

## Disaster recovery

1. Verify the archive and its image artifacts; install matching Docker, Python,
   pysqlite3 (SQLite >= 3.37) and zstd. Preserve the entire source backup folder.
2. Decompress each required `images/<id>.tar.zst` and pipe it into `docker load`.
   The manifest records original image IDs, configured names and repo digests.
3. Extract the archive into a private staging directory. Use its deployment
   files and container mount inventory to create the original named volumes.
   Restore `files/` under their original absolute paths with ownership/modes.
   Live PostgreSQL directories were intentionally not copied.
4. Initialize empty PostgreSQL data directories. Restore the corresponding
   `database/*-globals.private.sql`, create the original databases and restore
   `database/*.dump` with `pg_restore --exit-on-error`. Restore Redis RDB files
   to the original configured data directories before starting Redis.
5. Restore the actual Sub2API binary from `runtime/sub2api.binary` at the recorded
   runtime path. Preserve fork image channels; do not switch to upstream images.
6. Restore conversation settings into a **new empty** conversation directory:

   ```sh
   python3 vps_backup.py restore-conversation-settings \
     --source PAYLOAD/conversation-settings/operations-center \
     --target NEW_OPERATIONS_VOLUME/conversation-logs
   ```

7. Start databases and applications with the original environment, ownership,
   keys and mounts. Reconcile operator jobs against the native financial state;
   do not directly modify balances. Check health, configure the sole schedule
   and verify off-host synchronization. Historical conversation bodies and
   their pending delivery jobs are intentionally unavailable from this backup.

Do not run an old-server copy of business jobs concurrently with the recovered
host. An old `.tar.gz` or schema-1 `vps-full-*.tar.zst` requires its legacy
recovery procedure; the new policy-only archive is a different format.

## Tests

```sh
python3 -m unittest discover -s . -p 'test_backup.py' -v
```
