-- =============================================================================
-- MIGRATION v4 — outcomes: short viscosity column names (v6, v12, v30, v60)
-- Aligns DB with labChainRoutes / MATRIYA bridge (computeViscosityDelta).
-- Idempotent. Safe to run multiple times.
-- =============================================================================

ALTER TABLE outcomes ADD COLUMN IF NOT EXISTS v6  INTEGER NULL;
ALTER TABLE outcomes ADD COLUMN IF NOT EXISTS v12 INTEGER NULL;
ALTER TABLE outcomes ADD COLUMN IF NOT EXISTS v30 INTEGER NULL;
ALTER TABLE outcomes ADD COLUMN IF NOT EXISTS v60 INTEGER NULL;

-- Backfill from legacy INTUMESCENT column names when present
UPDATE outcomes
SET v6 = COALESCE(v6, viscosity_6rpm_cps)
WHERE v6 IS NULL AND viscosity_6rpm_cps IS NOT NULL;

UPDATE outcomes
SET v12 = COALESCE(v12, viscosity_12rpm_cps)
WHERE v12 IS NULL AND viscosity_12rpm_cps IS NOT NULL;

UPDATE outcomes
SET v30 = COALESCE(v30, viscosity_30rpm_cps)
WHERE v30 IS NULL AND viscosity_30rpm_cps IS NOT NULL;

UPDATE outcomes
SET v60 = COALESCE(v60, viscosity_60rpm_cps)
WHERE v60 IS NULL AND viscosity_60rpm_cps IS NOT NULL;

COMMENT ON COLUMN outcomes.v6 IS 'Brookfield viscosity at 6 RPM (cP), bridge + FSCTM delta channel';
