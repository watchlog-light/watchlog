-- Up Migration
-- An org that staff moved from Free to Pro kept Free's limits (0.9.6, ADR-177 amended): the
-- admin form filled in the limits the org had and sent them with the new plan, so the row
-- said Pro with 1 cluster, 5 nodes, 1 user and 3 days of data. The staff route no longer
-- keeps the old plan's defaults across a plan change; this repairs the rows already written.
-- Only the exact signature is touched: a staff-set Pro or Enterprise row whose four limits
-- are all Free's defaults, which nobody sets on purpose. The retention change is recorded as
-- every tier change is (reads keep merging the old tier until its 3 days have run out).
UPDATE entitlements
   SET clusters = NULL,
       nodes = NULL,
       users = CASE plan WHEN 'pro' THEN 10 ELSE NULL END,
       retention_days = 30,
       previous_retention_days = 3,
       retention_changed_at = now(),
       grace_until = NULL
 WHERE source = 'staff'
   AND plan IN ('pro', 'enterprise')
   AND clusters = 1 AND nodes = 5 AND users = 1 AND retention_days = 3;
