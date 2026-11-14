-- Up Migration
-- Wrong second-factor codes per account (security review SR-6). The 2FA step allowed five
-- codes per pending sign-in and nothing counted across them, so with the password an
-- attacker could try about 100 codes every 15 minutes. Failures now count per account,
-- persisted; from the 10th the account's 2FA step locks, longer each time, and a right
-- code resets the count. Cloud only: Community has no 2FA, so these stay 0 and null.
ALTER TABLE users
  ADD COLUMN mfa_failures integer NOT NULL DEFAULT 0,
  ADD COLUMN mfa_locked_until timestamptz;
