-- Optional DBA-run performance support for an existing core table.
-- Apply only after reviewing the live query plan and storage budget.
-- CONCURRENTLY must run outside a transaction. This module never runs this file.
CREATE INDEX CONCURRENTLY IF NOT EXISTS operations_domain_request_id_idx
    ON sub2api_custom.billing_recovery ((request_snapshot ->> 'request_id'));

-- Rollback (only for this operations-owned index):
-- DROP INDEX CONCURRENTLY IF EXISTS sub2api_custom.operations_domain_request_id_idx;
