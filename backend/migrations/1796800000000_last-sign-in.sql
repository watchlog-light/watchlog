-- Up Migration
-- When a user last signed in (0.9.9, for the Cloud admin's Users page, ADR-179 amended).
-- Until now it could only be read from the sessions, and those are deleted at sign-out, at
-- "sign out everywhere" and when a password is reset, so someone who signs out after use
-- looked as if they had never signed in. The column is set whenever a full session is made
-- (password, GitHub or Google, after the 2FA code, an invite, a reset); it starts from the
-- sessions still there.
ALTER TABLE users ADD COLUMN last_sign_in_at timestamptz;

UPDATE users u
   SET last_sign_in_at = s.at
  FROM (
    SELECT user_id, max(created_at) AS at
      FROM sessions
     WHERE stage = 'full'
     GROUP BY user_id
  ) s
 WHERE s.user_id = u.id;
