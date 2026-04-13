# MATRIYA – Scopes 1–3 (Unified Hardening, Audit Trail, Observability)

Implementation summary. **MATRIYA only** (no management system changes).

---

## Scope 1 – Unified Hardening

| Item | Implementation |
|------|----------------|
| **Delta hardening** | On ingest, existing chunks for the same filename are deleted before adding new ones (`ragService.ingestFile` → `vectorStore.deleteDocuments` by `filename`, then `addDocuments`). Re-ingesting a file replaces its chunks. |
| **Idempotency at DB** | `rag_documents` uses `ON CONFLICT (id) DO UPDATE`; chunk id is derived from content+filename+chunk_index. Same input → same id → upsert. |
| **Deterministic gate** | Gate in `researchGate.js` uses only DB state (session, `completed_stages`, active violation). No randomness. Comment added in code. |
| **Parallel processes** | One research run per session at a time: `POST /api/research/run` uses a per-session lock (`researchRunLocks` Map); concurrent runs for the same session are serialized. |
| **Staging proof** | `GET /research/staging-proof?session_id=<uuid>` returns `current_stage`, `next_allowed`, `gate_locked`, `violation_id`, `last_snapshot_cycle_index` for verification/automation. |

---

## Scope 2 – Audit Trail

| Item | Implementation |
|------|----------------|
| **decision_audit_log** | New table `decision_audit_log` (session_id, stage, decision, response_type, request_query, inputs_snapshot, details, created_at). Every gate outcome (allow/deny) in `/search` is logged with `inputs_snapshot` for replay. |
| **Snapshot** | Existing `integrity_cycle_snapshots` and `system_snapshots` unchanged. Decision trail is in `decision_audit_log`; session + decisions = replay snapshot. |
| **Replay determinism** | Gate is deterministic; `inputs_snapshot` stores (session_id, stage) so same inputs produce same decision. Read-only endpoints allow replay verification. |
| **Read-only endpoints** | `GET /api/audit/decisions?limit=&offset=` – list decisions; `GET /api/audit/session/:sessionId/decisions?limit=` – decisions for one session. No UI, API only. |

**Schema (run in Supabase):** `policy_audit_log` and `decision_audit_log` plus `research_sessions.enforcement_overridden` are in `supabase_setup_complete.sql` (Step 11b, 11c, and session column comment).

---

## Scope 3 – Observability

| Item | Implementation |
|------|----------------|
| **Metrics** | In-memory counters in `metrics.js`: requests and errors per path, latency samples (last 200 per path). |
| **Latency** | Every request is timed; percentiles (p50, p99) computed from stored samples. |
| **Health endpoint** | `GET /health` extended with `metrics: { total_requests, total_errors, latency_p50_ms, latency_p99_ms }`. No dashboard UI. |

---

## New/updated files

- `server.js` – metrics middleware, health extension, decision logging, run lock, staging-proof, audit endpoints.
- `database.js` – `DecisionAuditLog` model.
- `ragService.js` – delta delete-by-filename before add.
- `researchGate.js` – comment on deterministic gate.
- `metrics.js` – new; request/error counts and latency.
- `supabase_setup_complete.sql` – `policy_audit_log`, `decision_audit_log`, `enforcement_overridden`.
- `docs/MATRIYA-SCOPES-1-2-3.md` – this file.
