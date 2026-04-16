-- MATRIYA External Layer Schema v1.0 (David)
-- Run once in Supabase SQL Editor against the project used by matriya-back (public schema).
-- If tables already exist, do NOT re-run the CREATE blocks — use INSERT/SELECT tests only.

CREATE TABLE external_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_code TEXT NOT NULL,
  trust_grade TEXT NOT NULL CHECK (trust_grade IN ('C','D')),
  url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE external_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID REFERENCES external_sources(id),
  title TEXT NOT NULL,
  document_type TEXT NOT NULL,
  url TEXT NOT NULL,
  retrieved_at TIMESTAMPTZ NOT NULL,
  publication_date DATE,
  version_label TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE external_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID REFERENCES external_documents(id),
  claim_type TEXT NOT NULL CHECK (claim_type IN ('MECHANISM','TEST_REQUIREMENT','DOSAGE_GUIDANCE')),
  evidence_grade TEXT NOT NULL CHECK (evidence_grade IN ('C','D')),
  review_status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (review_status IN ('PENDING','VERIFIED','REJECTED')),
  claim_text TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE external_material_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id UUID REFERENCES external_claims(id),
  material_name TEXT NOT NULL,
  match_type TEXT NOT NULL
    CHECK (match_type IN ('EXACT','FAMILY','SUPPLIER_EQUIVALENT')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE external_standard_requirements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID REFERENCES external_documents(id),
  standard_code TEXT NOT NULL,
  metric_name TEXT NOT NULL,
  target_value NUMERIC,
  unit TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE external_climate_series (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_code TEXT NOT NULL,
  location_name TEXT NOT NULL,
  variable_code TEXT NOT NULL,
  value NUMERIC,
  unit TEXT,
  period_start DATE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE external_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  query_text TEXT NOT NULL,
  external_document_ids UUID[],
  used_external_as_context_only BOOLEAN NOT NULL
    CHECK (used_external_as_context_only = TRUE),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- PASS test (after tables exist):
-- INSERT INTO external_claims (claim_type, evidence_grade, claim_text)
-- VALUES ('MECHANISM', 'C', 'test claim');
-- SELECT * FROM external_claims;
