-- Up Migration
-- "New external destination" keeps one open alert per source (0.12.1, ADR-229): a workload,
-- Compose service, container or server process that talks to 24 new names has one alert that
-- lists them, not 24. Until now each destination had its own alert, fingerprinted
-- "egress:<source>><destination>:<port>"; the grouped one is "egress-new:<source>".
-- The open ones are folded here, per rule, cluster and source: the oldest is kept (so its
-- history and its message thread stay) under the new fingerprint, and the next evaluation
-- fills in its list; the others are resolved quietly, with no message (nothing changed for
-- the person who got the first one). Resolved alerts keep their old fingerprint.
WITH open AS (
  SELECT s.id, s.rule_id, s.cluster_id, s.started_at,
         split_part(substring(s.fingerprint FROM 8), '>', 1) AS source
  FROM alert_states s
  JOIN alert_rules r ON r.id = s.rule_id
  WHERE r.rule_key = 'egress.new_destination'
    AND s.state <> 'resolved'
    AND s.fingerprint LIKE 'egress:%>%'
), ranked AS (
  SELECT id,
         row_number() OVER (PARTITION BY rule_id, cluster_id, source ORDER BY started_at, id) AS n
  FROM open
)
UPDATE alert_states s
SET state = 'resolved', resolved_at = now(), version = s.version + 1
FROM ranked
WHERE s.id = ranked.id AND ranked.n > 1;

UPDATE alert_states s
SET fingerprint = 'egress-new:' || split_part(substring(s.fingerprint FROM 8), '>', 1),
    version = s.version + 1
FROM alert_rules r
WHERE r.id = s.rule_id
  AND r.rule_key = 'egress.new_destination'
  AND s.state <> 'resolved'
  AND s.fingerprint LIKE 'egress:%>%';
