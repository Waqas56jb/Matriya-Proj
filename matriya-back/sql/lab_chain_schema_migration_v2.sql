-- =============================================================================
-- MIGRATION v2 — lab chain schema
-- Apply this if the schema was already deployed with the v1 CREATE TABLEs.
-- Safe to run multiple times (uses IF NOT EXISTS / conditional logic).
-- =============================================================================

-- D4: normalized source ID fields
ALTER TABLE formulations
  ADD COLUMN IF NOT EXISTS id_suffix     TEXT         NULL,
  ADD COLUMN IF NOT EXISTS raw_source_id TEXT         NULL;

-- Backfill raw_source_id from source_id for existing rows
UPDATE formulations
  SET raw_source_id = source_id
  WHERE raw_source_id IS NULL;

-- Now enforce NOT NULL
ALTER TABLE formulations
  ALTER COLUMN raw_source_id SET NOT NULL;

-- D2: composition scale field
ALTER TABLE formulations
  ADD COLUMN IF NOT EXISTS composition_scale NUMERIC(4,2) NOT NULL DEFAULT 2.0;

-- Refresh validation view to use composition_scale
CREATE OR REPLACE VIEW v_formulation_composition_check AS
SELECT
  f.source_id,
  f.source_file,
  f.base_id,
  f.version,
  f.composition_scale,
  ROUND(SUM(fm.fraction)::NUMERIC, 6)                   AS total_fraction,
  ABS(SUM(fm.fraction) - f.composition_scale) < 0.005   AS sum_valid
FROM formulations f
JOIN formulation_materials fm ON fm.formulation_id = f.id
GROUP BY f.id, f.source_id, f.source_file, f.base_id, f.version, f.composition_scale;
