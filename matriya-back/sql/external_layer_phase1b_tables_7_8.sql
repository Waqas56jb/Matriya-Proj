-- =============================================================================
-- EXTERNAL LAYER — Phase 1b (tables 7–8 of 8)
-- Run after external_layer_phase1.sql (idempotent).
-- standard_publication / supplier_catalog_item: structured context only;
-- same isolation rules as rest of external_ctx (no lab / FSCTM coupling).
-- =============================================================================

CREATE TABLE IF NOT EXISTS external_ctx.standard_publication (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id             UUID NOT NULL REFERENCES external_ctx.source_registry(id) ON DELETE RESTRICT,
  standard_ref          TEXT NOT NULL,
  title                 TEXT NOT NULL,
  publication_year      INTEGER NULL,
  full_provenance       JSONB NOT NULL,
  retrieved_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_freshness_check_at TIMESTAMPTZ NULL,
  freshness_status      TEXT NOT NULL DEFAULT 'UNKNOWN'
                          CHECK (freshness_status IN ('FRESH','STALE','ERROR','UNKNOWN')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT standard_ref_source_uq UNIQUE (source_id, standard_ref)
);

CREATE INDEX IF NOT EXISTS idx_std_pub_ref ON external_ctx.standard_publication (standard_ref);

CREATE TABLE IF NOT EXISTS external_ctx.supplier_catalog_item (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id             UUID NOT NULL REFERENCES external_ctx.source_registry(id) ON DELETE RESTRICT,
  sku_code              TEXT NOT NULL,
  product_name          TEXT NOT NULL,
  full_provenance       JSONB NOT NULL,
  retrieved_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_freshness_check_at TIMESTAMPTZ NULL,
  freshness_status      TEXT NOT NULL DEFAULT 'UNKNOWN'
                          CHECK (freshness_status IN ('FRESH','STALE','ERROR','UNKNOWN')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT supplier_sku_source_uq UNIQUE (source_id, sku_code)
);

CREATE INDEX IF NOT EXISTS idx_supplier_sku ON external_ctx.supplier_catalog_item (sku_code);

COMMENT ON TABLE external_ctx.standard_publication IS
  'Normative / bibliographic standard pointers — context only; not used in FSCTM or conclusion_status.';

COMMENT ON TABLE external_ctx.supplier_catalog_item IS
  'Supplier product-line directory — context only; not a COA and not lab evidence.';

ALTER TABLE external_ctx.freshness_job ADD COLUMN IF NOT EXISTS standards_updated INTEGER NOT NULL DEFAULT 0;
ALTER TABLE external_ctx.freshness_job ADD COLUMN IF NOT EXISTS suppliers_updated INTEGER NOT NULL DEFAULT 0;
