-- Matriya: Kernel v1.6 – persist breakdown / shutdown flags on research_sessions.
-- Run in Supabase SQL editor if the column is missing (Sequelize sync uses alter: false).

ALTER TABLE research_sessions
  ADD COLUMN IF NOT EXISTS kernel_context jsonb DEFAULT '{}'::jsonb;

COMMENT ON COLUMN research_sessions.kernel_context IS 'FSCTM v1.6: possibility_shutdown, breakdown_reasons, l_validated, document_mode_n, etc.';
