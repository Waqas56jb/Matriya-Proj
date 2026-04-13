-- =============================================================================
-- MIGRATION v4c — outcomes.test_date (mirrors measurement test_date for API)
-- Idempotent.
-- =============================================================================

ALTER TABLE outcomes ADD COLUMN IF NOT EXISTS test_date DATE NULL;

COMMENT ON COLUMN outcomes.test_date IS 'Test date for this outcome row (aligned with measurement.test_date).';
