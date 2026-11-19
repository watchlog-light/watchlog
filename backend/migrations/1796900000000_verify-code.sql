-- Up Migration
-- A code with every verification email (0.9.11, ADR-220): six digits the user types where
-- they are signed in, next to the link that confirms in one step. The code lasts 15 minutes
-- and dies after 5 wrong tries; the link keeps its 24 hours. Stored as a hash, like the link.
ALTER TABLE email_tokens
  ADD COLUMN code_hash bytea,
  ADD COLUMN code_expires_at timestamptz,
  ADD COLUMN code_attempts integer NOT NULL DEFAULT 0;
