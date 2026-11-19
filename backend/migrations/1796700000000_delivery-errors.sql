-- Up Migration
-- Telegram messages that were delivered and recorded as refused (0.9.8, ADR-218). Until
-- 0.9.8 only the first 500 characters of a provider's answer were read, and Telegram's answer
-- to a sent message is longer, so its "ok": true could not be read: the message was in the
-- chat, the row said "Telegram sendMessage answered 200: …", and the sender tried again, up to
-- 8 times. The sender now reads the whole answer; this settles the rows already written.
--
-- 1. Such a message was delivered: no further attempt, and its resolve may follow (ADR-090).
UPDATE notifications
   SET status = 'sent',
       sent_at = LEAST(next_attempt_at, now()),
       error = NULL,
       lease_until = NULL
 WHERE error LIKE 'Telegram sendMessage answered 2__:%'
   AND status IN ('pending', 'sending', 'failed');

-- The channel worked: its last "error" was a delivery (or a test that arrived).
UPDATE alert_channels
   SET last_sent_at = GREATEST(last_sent_at, last_error_at),
       verified_at = COALESCE(verified_at, last_error_at),
       last_error = NULL,
       last_error_at = NULL
 WHERE last_error LIKE 'Telegram sendMessage answered 2__:%';

-- 2. Errors recorded before 0.9.8 quoted the provider's answer as it came: a webhook server's
--    own text, a Telegram answer with its chat and people, an SMTP reply with addresses. Only
--    the provider and its status stay; the next delivery or test writes the new wording.
UPDATE alert_channels
   SET last_error = regexp_replace(last_error, '^((Slack|Webhook) answered [0-9]{3}):.*$', '\1.')
 WHERE last_error ~ '^(Slack|Webhook) answered [0-9]{3}:';
UPDATE notifications
   SET error = regexp_replace(error, '^((Slack|Webhook) answered [0-9]{3}):.*$', '\1.')
 WHERE error ~ '^(Slack|Webhook) answered [0-9]{3}:';

-- Telegram's own description ("Forbidden: bot was blocked by the user") names nobody and
-- stays; a raw body in its place does not.
UPDATE alert_channels
   SET last_error = regexp_replace(last_error, '^(Telegram [A-Za-z]+ answered [0-9]{3}):\s*[{<[].*$', '\1.')
 WHERE last_error ~ '^Telegram [A-Za-z]+ answered [0-9]{3}:\s*[{<[]';
UPDATE notifications
   SET error = regexp_replace(error, '^(Telegram [A-Za-z]+ answered [0-9]{3}):\s*[{<[].*$', '\1.')
 WHERE error ~ '^Telegram [A-Za-z]+ answered [0-9]{3}:\s*[{<[]';

UPDATE alert_channels
   SET last_error = 'The mail server did not accept the message.'
 WHERE last_error LIKE 'SMTP: %';
UPDATE notifications
   SET error = 'The mail server did not accept the message.'
 WHERE error LIKE 'SMTP: %';

-- "<host> unreachable: <reason>": the reason could quote the address that was called.
UPDATE alert_channels
   SET last_error = regexp_replace(last_error, '^(\S+) unreachable: .*$', 'Could not reach \1.')
 WHERE last_error ~ '^\S+ unreachable: ';
UPDATE notifications
   SET error = regexp_replace(error, '^(\S+) unreachable: .*$', 'Could not reach \1.')
 WHERE error ~ '^\S+ unreachable: ';
