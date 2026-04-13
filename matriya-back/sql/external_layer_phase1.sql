-- =============================================================================
-- EXTERNAL LAYER — Phase 1 (David)
-- Schema: external_ctx — read-only context (standards, suppliers, climate,
-- patents, documents, claims). NOT lab evidence; must not feed conclusion_status.
-- Apply against same Postgres as MATRIYA when using POSTGRES_URL.
-- Idempotent where possible (IF NOT EXISTS).
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS external_ctx;

COMMENT ON SCHEMA external_ctx IS
  'External Layer Phase 1: context-only registry. Governance: no writes from this '
  'API to lab decision fields; no causal conclusions from these rows; every row '
  'carries full_provenance JSONB. Consumers must treat responses as context, not evidence.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Freshness job log (cron / manual runs)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS external_ctx.freshness_job (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type              TEXT NOT NULL DEFAULT 'scheduled_tick',
  started_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at           TIMESTAMPTZ NULL,
  status                TEXT NOT NULL DEFAULT 'RUNNING'
                          CHECK (status IN ('RUNNING','SUCCESS','FAILED')),
  documents_updated   INTEGER NOT NULL DEFAULT 0,
  claims_updated        INTEGER NOT NULL DEFAULT 0,
  climate_updated       INTEGER NOT NULL DEFAULT 0,
  patents_updated       INTEGER NOT NULL DEFAULT 0,
  sources_updated       INTEGER NOT NULL DEFAULT 0,
  error_message         TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_freshness_job_started ON external_ctx.freshness_job (started_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- Canonical external sources (standards bodies, suppliers, climate providers, etc.)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS external_ctx.source_registry (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type           TEXT NOT NULL
                          CHECK (source_type IN (
                            'standard_body','supplier','climate_provider',
                            'patent_office','document_host','other'
                          )),
  code                  TEXT NOT NULL UNIQUE,
  display_name          TEXT NOT NULL,
  authority_uri         TEXT NULL,
  notes                 TEXT NULL,
  stale_after_hours     INTEGER NOT NULL DEFAULT 720,
  last_freshness_check_at TIMESTAMPTZ NULL,
  freshness_status      TEXT NOT NULL DEFAULT 'UNKNOWN'
                          CHECK (freshness_status IN ('FRESH','STALE','ERROR','UNKNOWN')),
  provenance_stub       JSONB NOT NULL DEFAULT '{}',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_source_type ON external_ctx.source_registry (source_type);
CREATE INDEX IF NOT EXISTS idx_source_freshness ON external_ctx.source_registry (freshness_status);

-- ─────────────────────────────────────────────────────────────────────────────
-- External documents (standards PDFs, bulletins, etc.) — context only
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS external_ctx.external_document (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id             UUID NOT NULL REFERENCES external_ctx.source_registry(id) ON DELETE RESTRICT,
  title                 TEXT NOT NULL,
  document_kind         TEXT NOT NULL,
  canonical_uri         TEXT NULL,
  retrieved_at          TIMESTAMPTZ NOT NULL,
  content_fingerprint   TEXT NULL,
  full_provenance       JSONB NOT NULL,
  last_freshness_check_at TIMESTAMPTZ NULL,
  freshness_status      TEXT NOT NULL DEFAULT 'UNKNOWN'
                          CHECK (freshness_status IN ('FRESH','STALE','ERROR','UNKNOWN')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_extdoc_source ON external_ctx.external_document (source_id);
CREATE INDEX IF NOT EXISTS idx_extdoc_retrieved ON external_ctx.external_document (retrieved_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- Atomic external claims (never merged into lab conclusion_status)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS external_ctx.external_claim (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id             UUID NOT NULL REFERENCES external_ctx.source_registry(id) ON DELETE RESTRICT,
  document_id           UUID NULL REFERENCES external_ctx.external_document(id) ON DELETE SET NULL,
  claim_domain          TEXT NOT NULL
                          CHECK (claim_domain IN (
                            'standard','supplier','climate','patent_meta','regulatory'
                          )),
  claim_text            TEXT NOT NULL,
  qualifier             TEXT NULL,
  full_provenance       JSONB NOT NULL,
  retrieved_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_freshness_check_at TIMESTAMPTZ NULL,
  freshness_status      TEXT NOT NULL DEFAULT 'UNKNOWN'
                          CHECK (freshness_status IN ('FRESH','STALE','ERROR','UNKNOWN')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_extclaim_source ON external_ctx.external_claim (source_id);
CREATE INDEX IF NOT EXISTS idx_extclaim_domain ON external_ctx.external_claim (claim_domain);

-- ─────────────────────────────────────────────────────────────────────────────
-- Climate context snapshots
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS external_ctx.climate_snapshot (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id             UUID NOT NULL REFERENCES external_ctx.source_registry(id) ON DELETE RESTRICT,
  region_code           TEXT NOT NULL,
  metric_name           TEXT NOT NULL,
  value_numeric         NUMERIC NULL,
  value_text            TEXT NULL,
  unit                  TEXT NULL,
  period_start          DATE NULL,
  period_end            DATE NULL,
  full_provenance       JSONB NOT NULL,
  retrieved_at          TIMESTAMPTZ NOT NULL,
  last_freshness_check_at TIMESTAMPTZ NULL,
  freshness_status      TEXT NOT NULL DEFAULT 'UNKNOWN'
                          CHECK (freshness_status IN ('FRESH','STALE','ERROR','UNKNOWN')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_climate_region ON external_ctx.climate_snapshot (region_code);
CREATE INDEX IF NOT EXISTS idx_climate_source ON external_ctx.climate_snapshot (source_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Patent bibliographic context (not legal opinion; not lab outcome)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS external_ctx.patent_reference (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id             UUID NOT NULL REFERENCES external_ctx.source_registry(id) ON DELETE RESTRICT,
  publication_number    TEXT NOT NULL,
  title                 TEXT NULL,
  abstract_excerpt      TEXT NULL,
  assignee              TEXT NULL,
  full_provenance       JSONB NOT NULL,
  retrieved_at          TIMESTAMPTZ NOT NULL,
  last_freshness_check_at TIMESTAMPTZ NULL,
  freshness_status      TEXT NOT NULL DEFAULT 'UNKNOWN'
                          CHECK (freshness_status IN ('FRESH','STALE','ERROR','UNKNOWN')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT patent_source_pub_uq UNIQUE (source_id, publication_number)
);

CREATE INDEX IF NOT EXISTS idx_patent_pub ON external_ctx.patent_reference (publication_number);
