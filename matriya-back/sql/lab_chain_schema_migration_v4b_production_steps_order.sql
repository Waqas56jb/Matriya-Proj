-- =============================================================================
-- MIGRATION v4b — production_steps.order_of_addition (OVAT / process delta)
-- Idempotent.
-- =============================================================================

ALTER TABLE production_steps
  ADD COLUMN IF NOT EXISTS order_of_addition INTEGER NULL;

COMMENT ON COLUMN production_steps.order_of_addition IS
  'Optional sequence index for material addition order; used in process delta.';
