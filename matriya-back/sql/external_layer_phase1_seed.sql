-- =============================================================================
-- EXTERNAL LAYER — Phase 1 seed (standards, suppliers, climate, patents, docs)
-- Run after external_layer_phase1.sql
-- Re-runnable: uses ON CONFLICT DO NOTHING on source_registry.code
-- =============================================================================

INSERT INTO external_ctx.source_registry
  (source_type, code, display_name, authority_uri, notes, stale_after_hours, freshness_status, provenance_stub)
VALUES
  ('standard_body', 'ISO-TC92', 'ISO / TC 92 Fire safety', 'https://www.iso.org/committee/54500.html',
   'Context only — standard titles for UI cross-reference', 720, 'FRESH',
   '{"ingested_by":"external_layer_seed","ingested_at":"2026-04-12","method":"manual_curated","license_note":"Directory metadata only"}'),
  ('standard_body', 'ASTM-E84', 'ASTM International — E84 family', 'https://www.astm.org/',
   'Surface burning characteristics — reference pointer', 720, 'FRESH',
   '{"ingested_by":"external_layer_seed","ingested_at":"2026-04-12","method":"manual_curated"}'),
  ('supplier', 'SUP-ACME-RESIN', 'Acme Resins Ltd. (illustrative supplier)', NULL,
   'Supplier directory row — not a batch certificate', 168, 'FRESH',
   '{"ingested_by":"external_layer_seed","relationship":"non-binding_directory"}'),
  ('supplier', 'SUP-GLOBAL-FILL', 'Global Fillers Cooperative (illustrative)', NULL,
   'Mineral filler catalog metadata', 168, 'FRESH',
   '{"ingested_by":"external_layer_seed"}'),
  ('climate_provider', 'NASA-POWER', 'NASA POWER / SSEDER community dataset', 'https://power.larc.nasa.gov/',
   'Climate normals — illustrative row', 8760, 'FRESH',
   '{"ingested_by":"external_layer_seed","attribution":"NASA POWER","usage":"context_only"}'),
  ('patent_office', 'EPO-OPS', 'European Patent Office bibliographic data', 'https://www.epo.org/',
   'Patent meta pointers — no legal conclusions', 2160, 'FRESH',
   '{"ingested_by":"external_layer_seed"}'),
  ('document_host', 'MATRIYA-EXT-DOCS', 'MATRIYA external document index', NULL,
   'Host for linked external_document rows', 720, 'FRESH',
   '{"ingested_by":"external_layer_seed"}')
ON CONFLICT (code) DO NOTHING;

-- Documents (linked to sources by subquery)
INSERT INTO external_ctx.external_document (source_id, title, document_kind, canonical_uri, retrieved_at, content_fingerprint, full_provenance, freshness_status)
SELECT s.id, 'ISO 834-1:1999 Fire-resistance tests — general requirements', 'standard_index',
  'https://www.iso.org/standard/17400.html', now() AT TIME ZONE 'utc',
  'sha256:placeholder-iso834',
  jsonb_build_object(
    'source_code','ISO-TC92',
    'retrieval_method','manual_seed',
    'retrieved_at', to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'uri_resolved', true,
    'license','metadata_only',
    'does_not_imply_lab_compliance', true
  ), 'FRESH'
FROM external_ctx.source_registry s WHERE s.code = 'ISO-TC92'
AND NOT EXISTS (SELECT 1 FROM external_ctx.external_document d WHERE d.title LIKE 'ISO 834%' LIMIT 1);

INSERT INTO external_ctx.external_document (source_id, title, document_kind, canonical_uri, retrieved_at, content_fingerprint, full_provenance, freshness_status)
SELECT s.id, 'Supplier datasheet — Acme FR binder TDS rev 3', 'supplier_datasheet',
  NULL, now() AT TIME ZONE 'utc', 'sha256:placeholder-acme-tds',
  jsonb_build_object(
    'source_code','SUP-ACME-RESIN',
    'retrieval_method','manual_seed',
    'document_version','rev_3_illustrative',
    'does_not_replace_COA', true
  ), 'FRESH'
FROM external_ctx.source_registry s WHERE s.code = 'SUP-ACME-RESIN'
AND NOT EXISTS (SELECT 1 FROM external_ctx.external_document d WHERE d.title LIKE 'Supplier datasheet — Acme%' LIMIT 1);

-- Claims
INSERT INTO external_ctx.external_claim (source_id, document_id, claim_domain, claim_text, qualifier, full_provenance, retrieved_at, freshness_status)
SELECT s.id, d.id, 'standard',
  'Fire-resistance test methods may reference furnace time-temperature curves per ISO 834 family.',
  'context_only_not_project_specific',
  jsonb_build_object('source_code','ISO-TC92','linked_document_title', d.title, 'no_causal_link_to_batch', true),
  now() AT TIME ZONE 'utc', 'FRESH'
FROM external_ctx.source_registry s
JOIN external_ctx.external_document d ON d.source_id = s.id AND d.title LIKE 'ISO 834%'
WHERE s.code = 'ISO-TC92'
AND NOT EXISTS (SELECT 1 FROM external_ctx.external_claim c WHERE c.claim_text LIKE 'Fire-resistance test methods%' LIMIT 1);

INSERT INTO external_ctx.external_claim (source_id, document_id, claim_domain, claim_text, qualifier, full_provenance, retrieved_at, freshness_status)
SELECT s.id, NULL, 'supplier',
  'Illustrative supplier lists typical solids content range 60–70% for waterborne binder grade X (not your batch).',
  'non_binding_marketing_band',
  jsonb_build_object('source_code','SUP-ACME-RESIN','epistemic_status','illustrative_only'),
  now() AT TIME ZONE 'utc', 'FRESH'
FROM external_ctx.source_registry s WHERE s.code = 'SUP-ACME-RESIN'
AND NOT EXISTS (SELECT 1 FROM external_ctx.external_claim c WHERE c.claim_text LIKE 'Illustrative supplier lists%' LIMIT 1);

-- Climate
INSERT INTO external_ctx.climate_snapshot
  (source_id, region_code, metric_name, value_numeric, unit, period_start, period_end, full_provenance, retrieved_at, freshness_status)
SELECT id, 'IL-HAIFA', 'annual_mean_temp_c', 20.1, 'degC', '1991-01-01', '2020-12-31',
  jsonb_build_object(
    'dataset','illustrative_climate_normal',
    'spatial_resolution','city_scale_illustrative',
    'not_for_fire_curve_substitution', true,
    'ingested_by','external_layer_seed'
  ), now() AT TIME ZONE 'utc', 'FRESH'
FROM external_ctx.source_registry WHERE code = 'NASA-POWER'
AND NOT EXISTS (SELECT 1 FROM external_ctx.climate_snapshot WHERE region_code = 'IL-HAIFA' AND metric_name = 'annual_mean_temp_c' LIMIT 1);

INSERT INTO external_ctx.climate_snapshot
  (source_id, region_code, metric_name, value_numeric, unit, period_start, period_end, full_provenance, retrieved_at, freshness_status)
SELECT id, 'EU-MED', 'heating_degree_days_base18', 1200, 'HDD', '2010-01-01', '2019-12-31',
  jsonb_build_object('dataset','illustrative_energy_norm','context','building_science_reference_only'),
  now() AT TIME ZONE 'utc', 'FRESH'
FROM external_ctx.source_registry WHERE code = 'NASA-POWER'
AND NOT EXISTS (SELECT 1 FROM external_ctx.climate_snapshot WHERE region_code = 'EU-MED' AND metric_name = 'heating_degree_days_base18' LIMIT 1);

-- Patents
INSERT INTO external_ctx.patent_reference
  (source_id, publication_number, title, abstract_excerpt, assignee, full_provenance, retrieved_at, freshness_status)
SELECT id, 'EP-1234567-A1', 'Illustrative intumescent coating composition',
  'Example abstract excerpt for MATRIYA context layer — not examined for FTO.',
  'Example Assignee SA',
  jsonb_build_object(
    'jurisdiction','EP',
    'kind','A1',
    'retrieval_method','manual_seed',
    'no_legal_opinion', true,
    'not_evidence_of_infringement_or_validity', true
  ), now() AT TIME ZONE 'utc', 'FRESH'
FROM external_ctx.source_registry WHERE code = 'EPO-OPS'
ON CONFLICT (source_id, publication_number) DO NOTHING;

-- Tables 7–8: standard_publication, supplier_catalog_item
INSERT INTO external_ctx.standard_publication
  (source_id, standard_ref, title, publication_year, full_provenance, retrieved_at, freshness_status)
SELECT id, 'ISO 834-1:1999', 'Fire-resistance tests — Elements of building construction — Part 1: General requirements', 1999,
  jsonb_build_object(
    'source_name','ISO',
    'retrieval_url','https://www.iso.org/standard/17400.html',
    'retrieval_date', to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD'),
    'context_only', true,
    'does_not_affect_conclusion_status', true
  ), now() AT TIME ZONE 'utc', 'FRESH'
FROM external_ctx.source_registry WHERE code = 'ISO-TC92'
ON CONFLICT (source_id, standard_ref) DO NOTHING;

INSERT INTO external_ctx.supplier_catalog_item
  (source_id, sku_code, product_name, full_provenance, retrieved_at, freshness_status)
SELECT id, 'ACME-FR-BINDER-X', 'Waterborne intumescent binder grade X (illustrative)',
  jsonb_build_object(
    'supplier_display_name','Acme Resins Ltd.',
    'retrieval_date', to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD'),
    'context_only', true,
    'not_a_certificate_of_analysis', true
  ), now() AT TIME ZONE 'utc', 'FRESH'
FROM external_ctx.source_registry WHERE code = 'SUP-ACME-RESIN'
ON CONFLICT (source_id, sku_code) DO NOTHING;
