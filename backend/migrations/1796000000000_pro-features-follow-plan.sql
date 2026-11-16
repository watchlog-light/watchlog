-- Up Migration
-- Pro features follow the plan (0.8.1, ADR-205). `entitlements.pro_features` was written
-- separately from `plan`, so staff could leave an org on Free with Pro features (the admin
-- panel's checkbox stayed ticked when a Pro org was moved to Free): the sidebar said Free while
-- What changed, which is gated on `pro_features` (ADR-195), said Pro. From now on Free has no
-- Pro features and Pro and Enterprise have them. Rows that disagree take their plan's value
-- (the plan is what the sidebar, Plan & billing and the bill show), and a CHECK keeps them
-- equal. An org that loses Pro features this way is a downgrade for What changed: the
-- anomaly-worker stops scoring it at once and keeps its baselines 30 days (ADR-198). In
-- Community the table has no rows that disagree.
UPDATE entitlements SET pro_features = (plan <> 'free') WHERE pro_features <> (plan <> 'free');
ALTER TABLE entitlements
  ADD CONSTRAINT entitlements_pro_features_follow_plan CHECK (pro_features = (plan <> 'free'));

