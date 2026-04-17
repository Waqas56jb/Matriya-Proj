-- Optional link from management FSM runs to External Layer sources (same Supabase / public schema).
-- Ensures external_sources exists (no-op if External Layer v1 already applied). Idempotent.
-- No application changes required: column is nullable; existing inserts/updates unchanged.

CREATE TABLE IF NOT EXISTS external_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_code TEXT NOT NULL,
  trust_grade TEXT NOT NULL CHECK (trust_grade IN ('C','D')),
  url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE runs
  ADD COLUMN IF NOT EXISTS external_source_id UUID REFERENCES external_sources(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS runs_external_source_id_idx ON runs (external_source_id)
  WHERE external_source_id IS NOT NULL;

COMMENT ON COLUMN runs.external_source_id IS 'Optional FK to external_sources for impact measurement (analytics).';
