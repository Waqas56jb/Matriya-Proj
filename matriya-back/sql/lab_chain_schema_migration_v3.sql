-- =============================================================================
-- MIGRATION v3 — lab chain schema
-- Approved by David Shoshan, 2026-04-09
-- Adds: FSCTM fields, workflow_state, OVAT fields, operator_name,
--       prep_location, recommended_material, capacity_ratings,
--       failure_signature, stability_classification, mechanism_tag
-- Safe to run multiple times (IF NOT EXISTS / conditional guards).
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- formulation_materials: add recommended_material for substitution tracking
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE formulation_materials
  ADD COLUMN IF NOT EXISTS recommended_material TEXT NULL;

COMMENT ON COLUMN formulation_materials.recommended_material
  IS 'Previous or recommended material name (col 1 in detail sheet). NULL when absent.';

-- ─────────────────────────────────────────────────────────────────────────────
-- production_runs: add operator_name, prep_location
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE production_runs
  ADD COLUMN IF NOT EXISTS operator_name TEXT NULL;

COMMENT ON COLUMN production_runs.operator_name
  IS 'Name of person who produced the batch. Required for REAL runs (enforced at API layer).';

ALTER TABLE production_runs
  ADD COLUMN IF NOT EXISTS prep_location TEXT NULL;

COMMENT ON COLUMN production_runs.prep_location
  IS 'Where the batch was prepared (e.g. מעבדה = laboratory). Optional.';

-- ─────────────────────────────────────────────────────────────────────────────
-- production_runs: workflow state machine
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE production_runs
  ADD COLUMN IF NOT EXISTS workflow_state TEXT NOT NULL DEFAULT 'HISTORICAL';

COMMENT ON COLUMN production_runs.workflow_state
  IS 'State machine: HISTORICAL | DRAFT | SUBMITTED | REVIEWED | APPROVED | INGESTED | LOCKED';

-- Backfill: all existing runs are historical
UPDATE production_runs
  SET workflow_state = 'HISTORICAL'
  WHERE run_origin = 'HISTORICAL'
    AND workflow_state = 'HISTORICAL';

-- ─────────────────────────────────────────────────────────────────────────────
-- production_runs: OVAT and experiment design fields
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE production_runs
  ADD COLUMN IF NOT EXISTS baseline_run_id          UUID  NULL REFERENCES production_runs(id),
  ADD COLUMN IF NOT EXISTS declared_changed_variable TEXT  NULL,
  ADD COLUMN IF NOT EXISTS hypothesis                TEXT  NULL,
  ADD COLUMN IF NOT EXISTS run_type                  TEXT  NULL;

COMMENT ON COLUMN production_runs.baseline_run_id
  IS 'Reference run for OVAT comparison. Required for REAL runs before Submitted.';

COMMENT ON COLUMN production_runs.declared_changed_variable
  IS 'Single field name the operator intends to change vs baseline (e.g. mixing_speed_rpm).';

COMMENT ON COLUMN production_runs.hypothesis
  IS 'Short text: expected effect of the declared change on the outcome.';

COMMENT ON COLUMN production_runs.run_type
  IS 'Computed at approval: CONTROLLED_OVAT | NON_CONTROLLED | REPLICATION | NO_BASELINE | HISTORICAL_REFERENCE';

-- ─────────────────────────────────────────────────────────────────────────────
-- production_runs: FSCTM — K (Load)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE production_runs
  ADD COLUMN IF NOT EXISTS load_type       TEXT  NULL,
  ADD COLUMN IF NOT EXISTS load_conditions JSONB NULL;

COMMENT ON COLUMN production_runs.load_type
  IS 'K — Load type: THERMAL | MOISTURE | MECHANICAL | CHEMICAL | CYCLIC';

COMMENT ON COLUMN production_runs.load_conditions
  IS 'K — Structured load parameters. E.g. {"temperature_c": 550, "duration_min": 30}';

-- ─────────────────────────────────────────────────────────────────────────────
-- outcomes: FSCTM — C (Capacity), B (Failure signature), L (Stability)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE outcomes
  ADD COLUMN IF NOT EXISTS capacity_ratings       JSONB NULL,
  ADD COLUMN IF NOT EXISTS failure_signature      TEXT  NULL,
  ADD COLUMN IF NOT EXISTS stability_classification TEXT NULL,
  ADD COLUMN IF NOT EXISTS mechanism_tag          TEXT  NULL,
  ADD COLUMN IF NOT EXISTS conclusion_status      TEXT  NULL;

COMMENT ON COLUMN outcomes.capacity_ratings IS
  'C — Capacity vector (FSCTM). JSON shape:
   {
     "A": {"value": ..., "scale": "raw|score_0_10", "unit": "..."},
     "D": {"value": ..., "scale": "raw|score_0_10", "unit": "..."},
     "G": {"value": ..., "scale": "raw|score_0_10", "unit": "..."},
     "R": {"value": ..., "scale": "raw|score_0_10", "unit": "..."},
     "T": {"value": ..., "scale": "raw|score_0_10", "unit": "..."}
   }
   A=Adhesion, D=Durability, G=Growth/intumescent expansion,
   R=Reaction class/char efficiency, T=Thermal resistance/insulation.
   No mixing raw/score without labeling the scale field.';

COMMENT ON COLUMN outcomes.failure_signature IS
  'B — Failure signature: observed failure mode.
   E.g. DELAMINATION | CRACKING | INSUFFICIENT_EXPANSION | COLOR_LOSS | NONE';

COMMENT ON COLUMN outcomes.stability_classification IS
  'L — Stability over time classification.
   E.g. STABLE | DEGRADING | IMPROVING | INSUFFICIENT_DATA';

COMMENT ON COLUMN outcomes.mechanism_tag IS
  'Computed mechanism tag (not operator-entered).
   E.g. thickener_network_activation | defoamer_air_release_improvement |
        pigment_dispersion_effect | UNCLASSIFIED';

COMMENT ON COLUMN outcomes.conclusion_status IS
  'Scientific conclusion state for this outcome:
   VALID_CONCLUSION | INCONCLUSIVE | INVALID_EXPERIMENT |
   INSUFFICIENT_DATA | STRUCTURAL_INCOMPLETE | REFERENCE_ONLY';

-- ─────────────────────────────────────────────────────────────────────────────
-- Indexes for new fields
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_runs_workflow_state ON production_runs (workflow_state);
CREATE INDEX IF NOT EXISTS idx_runs_run_type       ON production_runs (run_type);
CREATE INDEX IF NOT EXISTS idx_runs_baseline       ON production_runs (baseline_run_id);
CREATE INDEX IF NOT EXISTS idx_outcomes_conclusion ON outcomes (conclusion_status);
CREATE INDEX IF NOT EXISTS idx_outcomes_mechanism  ON outcomes (mechanism_tag);

-- ─────────────────────────────────────────────────────────────────────────────
-- Validation view: FSCTM completeness check
-- Returns all REAL runs with missing K/C/B/L fields
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_fsctm_completeness AS
SELECT
  pr.id                     AS run_id,
  pr.batch_id,
  pr.run_origin,
  pr.workflow_state,
  pr.run_type,
  pr.load_type              IS NULL                   AS k_missing,
  o.capacity_ratings        IS NULL                   AS c_missing,
  o.failure_signature       IS NULL                   AS b_missing,
  o.stability_classification IS NULL                  AS l_missing,
  CASE
    WHEN pr.load_type IS NULL
      OR o.capacity_ratings IS NULL
      OR o.failure_signature IS NULL
      OR o.stability_classification IS NULL
    THEN 'STRUCTURAL_INCOMPLETE'
    ELSE 'FSCTM_COMPLETE'
  END                                                  AS fsctm_status
FROM production_runs pr
LEFT JOIN measurements m  ON m.production_run_id = pr.id
LEFT JOIN outcomes o      ON o.measurement_id = m.id
WHERE pr.run_origin = 'REAL';

-- ─────────────────────────────────────────────────────────────────────────────
-- Validation view: OVAT check for approved runs
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_ovat_status AS
SELECT
  pr.id           AS run_id,
  pr.batch_id,
  pr.workflow_state,
  pr.run_type,
  pr.baseline_run_id,
  pr.declared_changed_variable,
  pr.hypothesis,
  CASE
    WHEN pr.baseline_run_id IS NULL THEN 'NO_BASELINE'
    WHEN pr.run_type = 'CONTROLLED_OVAT' THEN 'ELIGIBLE_FOR_CONCLUSION'
    WHEN pr.run_type = 'NON_CONTROLLED' THEN 'CONCLUSION_BLOCKED'
    WHEN pr.run_type = 'REPLICATION' THEN 'REPRODUCIBILITY_ONLY'
    ELSE 'UNCLASSIFIED'
  END AS ovat_status
FROM production_runs pr
WHERE pr.run_origin = 'REAL';
