-- Up Migration
-- ADR-090: a queued message whose alerts resolved before delivery is dropped, not sent.

ALTER TABLE notifications DROP CONSTRAINT notifications_status_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_status_check
  CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'dropped'));
DROP INDEX notifications_finished_idx;
CREATE INDEX notifications_finished_idx ON notifications (created_at)
  WHERE status IN ('sent', 'failed', 'dropped');
