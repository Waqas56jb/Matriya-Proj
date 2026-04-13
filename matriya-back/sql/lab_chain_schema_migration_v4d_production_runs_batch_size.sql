-- =============================================================================
-- MIGRATION v4d — production_runs.batch_size_g (OVAT / D3)
-- Idempotent.
-- =============================================================================

ALTER TABLE production_runs ADD COLUMN IF NOT EXISTS batch_size_g NUMERIC(14,4) NULL;

COMMENT ON COLUMN production_runs.batch_size_g IS 'Batch size in grams when recorded (OVAT comparison).';
