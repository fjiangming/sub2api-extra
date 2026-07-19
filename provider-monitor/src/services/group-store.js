const crypto = require('crypto');
const { stringifyJson } = require('../db');

function upsertGroups(db, connectionId, groups, capturedAt, { complete = false } = {}) {
  const seen = [];
  const statement = db.prepare(`
    INSERT INTO remote_groups(
      id, connection_id, remote_id, group_type, name, ratio, status,
      metadata_json, first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(connection_id, group_type, remote_id) DO UPDATE SET
      name = excluded.name, ratio = excluded.ratio, status = excluded.status,
      metadata_json = excluded.metadata_json, last_seen_at = excluded.last_seen_at
  `);

  for (const group of groups) {
    const remoteId = String(group.remoteId);
    seen.push(remoteId);
    statement.run(
      crypto.randomUUID(),
      connectionId,
      remoteId,
      group.type || 'key_route_group',
      group.name || remoteId,
      group.ratio ?? null,
      group.status || 'active',
      stringifyJson(group.metadata || {}),
      capturedAt,
      capturedAt
    );
  }

  if (!complete) return;
  if (seen.length === 0) {
    db.prepare("UPDATE remote_groups SET status = 'missing' WHERE connection_id = ?").run(connectionId);
    return;
  }
  const placeholders = seen.map(() => '?').join(',');
  db.prepare(`
    UPDATE remote_groups SET status = 'missing'
    WHERE connection_id = ? AND remote_id NOT IN (${placeholders})
  `).run(connectionId, ...seen);
}

module.exports = { upsertGroups };
