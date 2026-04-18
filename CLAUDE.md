# MATRIYA Monorepo — Complete Project Reference

Operational README for Claude Code and engineers working in this repository.
Code is always the source of truth; keep this file synchronized with route and env changes.

---

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Repository Layout](#repository-layout)
- [Tech Stack](#tech-stack)
- [Quick Start](#quick-start)
- [Environment Variables](#environment-variables)
- [Database Models](#database-models)
- [Service Deep-Dives](#service-deep-dives)
  - [matriya-back](#matriya-back-deep-dive)
  - [matriya-front](#matriya-front-deep-dive)
  - [managment-back](#managment-back-deep-dive)
  - [managment-front](#managment-front-deep-dive)
- [API Surface](#api-surface)
- [Common Payloads](#common-payloads)
- [Cross-Service Data Flow](#cross-service-data-flow)
- [Auth and Security](#auth-and-security)
- [Operations and Safety Rules](#operations-and-safety-rules)
- [Troubleshooting](#troubleshooting)
- [Starter `.env` Templates](#starter-env-templates)

---

## Overview

Four services in a monorepo. They communicate over HTTP; no shared in-process modules.

| Service | Description | Runtime | Default port |
|---|---|---|---|
| `matriya-back` | Core RAG + research gate API | Node.js 18+ ESM | 8000 |
| `matriya-front` | MATRIYA end-user UI | React 18 (CRA) | 3000 |
| `managment-back` | Project management + lab API | Node.js 18+ ESM | 8001 |
| `managment-front` | Management/lab UI | React 18 (Vite) | 5173 |

**Naming caveat:** directory names use `managment-*` (one "e"). Environment variable keys use `MANEGER_*` or `MANAGEMENT_*` inconsistently. Do not rename without a full migration — both patterns appear in code.

---

## Architecture

### Core Principles

1. MATRIYA and Management are separated by service boundary; integration is HTTP-only.
2. All RAG answers are grounded exclusively in uploaded documents — no training-data inference allowed.
3. Research queries are guarded by a deterministic Finite-State Machine gate (FSCTM). Stage order K → C → B → N → L is enforced server-side; you cannot skip.
4. B-Integrity monitoring runs on every research cycle. A single unresolved violation locks the gate for that session until explicit recovery.
5. The Lab bridge allows Management-side experiment data to feed into Matriya Answer Composer decisions, but experiment outcome data never leaks into external RAG answers.
6. OpenAI `file_search` (Responses API) is the primary retrieval path when `OPENAI_API_KEY` is set. `pgvector` (Supabase) is the local/fallback path.
7. Temperature is locked to 0 by default (`MATRIYA_LLM_TEMPERATURE`) for deterministic answers.

### Runtime Topology (local dev)

```
matriya-front  :3000 ──► matriya-back  :8000 ──► Supabase PostgreSQL + pgvector
                                        │──────► OpenAI Responses API (file_search)
                                        │──────► Together AI / Hugging Face (local LLM fallback)
managment-front:5173 ──► managment-back:8001 ──► Supabase Storage (buckets)
                                        │──────► OpenAI (project-scoped vector stores)
                                        │──────► Resend (email)
                                        │──────► SharePoint (Microsoft Graph)
                                        │──────► matriya-back:8000 (auth proxy + lab bridge)
```

---

## Repository Layout

```
matriya-back/
  server.js               App bootstrap, CORS, rate limiting, route mounting
  config.js               Settings class — all env variables with defaults
  database.js             Sequelize models (User, FilePermission, SearchHistory, ResearchSession,
                          ResearchAuditLog, PolicyAuditLog, DecisionAuditLog, NoiseEvent,
                          IntegrityCycleSnapshot, Violation, SystemSnapshot, ResearchLoopRun,
                          JustificationTemplate, DoEDesign)
  authEndpoints.js        POST /auth/signup, POST /auth/login, GET /auth/me, GET /auth/users
  adminEndpoints.js       Admin panel: file management, user permissions, integrity recovery,
                          risk oracle, history, FIL layer
  ragService.js           Ingestion pipeline, chunking, pgvector storage, retrieval
  vectorStoreSupabase.js  Embedding generation (@xenova/transformers or API) + pgvector search
  researchGate.js         FSCTM gate: validateAndAdvance(), getOrCreateSession(), stage scoring
  kernelV16.js            Kernel FSCTM v1.6: breakdown/fail-safe/anchor/extrapolation/L-gate helpers
  integrityMonitor.js     B-Integrity monitoring: snapshot recording, violation detection
  integrityRulesEngine.js Configurable rules engine: growth, drop, no-progress, cap conditions
  riskOracle.js           Risk indicator evaluation from recent snapshots/violations (read-only)
  stateMachine.js         Kernel and state-machine helpers for FSM progression
  researchLoop.js         4-agent research chain (analysis → research → critic → synthesis)
  justificationTemplates.js  Justification template CRUD + cache
  filLayer.js             FIL (Failure Indication Layer) warnings
  logger.js               Pino/console logger wrapper
  lib/
    openaiFileSearchMatriya.js     Responses API + file_search wrapper for Matriya
    openaiMatriyaConfig.js         OpenAI config: vector store ID, model, base URL
    matriyaOpenAiSync.js           Manual sync: upload/delete files in OpenAI vector store
    matriyaOpenAiAutoSync.js       Debounced auto-sync triggered after ingest
    domainAndGenerationGate.js     Domain filter (token overlap) + generation readiness check
    ragEvidenceFailSafe.js         Canonical no-evidence message + sanitizer
    answerAttribution.js           Build source citations from retrieval rows
    answerWordingGuard.js          Strip forbidden wording from generated answers
    answerSourceBindingFilter.js   Filter out sources that do not match the answer
    gptRagEligible.js              Determine if a file is eligible for GPT RAG indexing
    filterFileSearchSnippetsToIndex.js  Filter which snippets to include in index
    researchEvidenceGaps.js        Detect evidence gaps in research stage answers
    matriyaLabBridgeFlow.js        Bridge flow: call managment-back lab API from Matriya
    detectStructuredFormulationChunks.js  Detect chunks with structured data (formulas, %)
    uploadAskMaterialsRouter.js    Router: upload files + ask about materials
    davidAskMatriyaAcceptance.js   Acceptance criteria checks for David's Ask Matriya spec
    externalLayerRouter.js         External-layer API route handler
    externalLayerPool.js           Pool of external data providers
    textEncoding.js                UTF-8 / encoding helpers
    excelPercentFormat.js          Format percentage values from Excel data
    vectorMetadataFilenameFilter.js  Filter vector rows by filename metadata
  services/
    answerComposer.js       Lab-only decision engine: VALID_CONCLUSION / INCONCLUSIVE / etc.
    labConstraintRules.js   Constraint rule evaluator for lab results

matriya-front/
  src/
    App.js                  Tab routing: Upload, Search, Ask Matriya, Admin, Info
    utils/
      api.js                Axios client — REACT_APP_API_BASE_URL + JWT interceptor
      managementApi.js      Axios client — REACT_APP_MANAGEMENT_API_URL
      openAiFriendlyError.js  Human-readable OpenAI error messages
      formatBold.js         Parse **bold** segments in answers
      askMatriyaDocumentsClient.js  Client for "ask about materials" via management API
      isAnswerComposerPayload.js    Detect if a response is an Answer Composer JSON payload
    components/
      UploadTab.js / .css   File tree, ingest, OpenAI GPT sync, per-file ask
      SearchTab.js / .css   Query, FSM stages, session, lab mode, agents mode
      AskMatriyaTab.js / .css  Conversational AI chat
      AdminTab.js / .css    Admin panel: files, users, integrity, risk oracle, history
      InfoTab.js / .css     System information display
      GptSyncStatusRow.js   OpenAI sync status per file
      AnswerEvidenceSection.js  Evidence citations section in answers
      AnswerView.js         Renders Answer Composer JSON payload
      JsonViewer.js         Generic JSON viewer component
      answerComposer/       Sub-components for Answer Composer rendering

managment-back/
  server.js               5500+ line monolith: all routes, SharePoint, email, lab, RAG
  lib/
    gptRagSync.js          Sync project files (Supabase buckets) into OpenAI vector stores
    labBridgeQueryRoute.js  GET /api/lab/query — lab data query for Answer Composer
    labExperimentParse.js  Parse Excel/CSV/TXT/JSON experiment files to Markdown tables
    labCompositionCompare.js  Deterministic A vs B composition comparison with Δ
    labEmailImportValidation.js  Validate lab data imports from email attachments
    labConstraintRules.js  Lab constraint rule evaluator
    labExperimentHeatmap.js  Heatmap generation for experiment data
    ragService.js          Local management RAG (management_vector store in Supabase)
    managementRagDelete.js  Delete management vector entries by filename
    inboundProjectRouting.js  Route inbound emails to projects by UUID / Reply-To
    sendLabImportIncompleteEmail.js  Send email when lab import is incomplete
    gptRagQuery.js         Shared GPT RAG query logic (project-scoped)

managment-front/
  src/
    App.jsx               4349-line main component: routing, auth, all sections
    api.js                Full Axios API client — 400+ lines with every endpoint
    strings.js            Hebrew/English i18n string table
    LabExcelSpreadsheet.jsx  React Data Grid spreadsheet for experiment data
    *.css                 Component styles
```

---

## Tech Stack

### `matriya-back`

- Node.js 18+ ESM (all files use `import`/`export`)
- Express.js, CORS, Multer (file uploads to `/tmp` on Vercel or `./uploads` locally)
- PostgreSQL + Sequelize ORM + `pgvector` extension (vector similarity search)
- Supabase client (bucket operations, optional)
- OpenAI SDK / Axios (Responses API + `file_search` RAG)
- `@xenova/transformers` — local embedding model (sentence-transformers/all-MiniLM-L6-v2)
- Together AI and Hugging Face APIs (LLM fallback providers)
- `pdf-parse`, `mammoth`, `xlsx` — document text extraction
- `bcrypt` — password hashing
- `jsonwebtoken` — JWT issuance and verification
- `express-rate-limit`
- `pino` / console logger

### `matriya-front`

- React 18, Create React App (`react-scripts`)
- Axios (with JWT interceptor)
- React Toastify (notifications)
- React Icons
- React Markdown (`remark-gfm` for tables)

### `managment-back`

- Node.js 18+ ESM
- Express.js, CORS, `express-rate-limit`
- Multer (uploads — Supabase bucket or memory storage)
- Supabase JS v2 client (`createClient`)
- Zod (request body validation)
- OpenAI Responses API + `file_search` (per-project vector stores)
- Resend (transactional email + inbound webhook)
- Microsoft Graph / SharePoint (tenant, client-credentials flow)
- `xlsx` (Excel parsing)
- `form-data`, `axios`

### `managment-front`

- React 18, Vite
- React Router v6
- Axios (with JWT interceptor and auto-401 redirect)
- Supabase JS v2 (direct bucket upload)
- `react-data-grid` (Lab spreadsheet)
- React Markdown + `remark-gfm`
- React Icons

---

## Quick Start

### 1. Install

```bash
cd matriya-back && npm install
cd ../managment-back && npm install
cd ../matriya-front && npm install
cd ../managment-front && npm install
```

### 2. Create `.env` files

See [Starter `.env` Templates](#starter-env-templates) below.

### 3. Start services (recommended order)

```bash
# Terminal 1
cd matriya-back && npm run dev

# Terminal 2
cd managment-back && npm run dev

# Terminal 3
cd matriya-front && npm start

# Terminal 4
cd managment-front && npm run dev
```

### 4. Verify

```bash
curl http://localhost:8000/health     # matriya-back
curl http://localhost:8001/health     # managment-back
# Open http://localhost:3000          # matriya-front
# Open http://localhost:5173          # managment-front
```

### 5. Production build check

```bash
cd matriya-front && npm run build
cd ../managment-front && npm run build
```

---

## Environment Variables

### `matriya-front`

| Variable | Required | Purpose |
|---|---|---|
| `REACT_APP_API_BASE_URL` | Yes | Base URL for `matriya-back` |
| `REACT_APP_MANAGEMENT_API_URL` | Optional | Base URL for `managment-back` |
| `REACT_APP_MANAGEMENT_FRONT_URL` | Optional | URL to management frontend |

### `managment-front`

| Variable | Required | Purpose |
|---|---|---|
| `VITE_MANEGER_API_URL` | Yes | Base URL for `managment-back` |
| `VITE_SUPABASE_URL` | Optional | Direct bucket upload support |
| `VITE_SUPABASE_ANON_KEY` | Optional | Direct bucket upload support |

### `matriya-back`

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `JWT_SECRET` | Yes | — | Sign/verify JWT tokens |
| `API_PORT` | No | 8000 | HTTP listen port |
| `API_HOST` | No | 0.0.0.0 | HTTP bind host |
| `EXPRESS_BODY_LIMIT` | No | 15mb | Max JSON body size |
| `POSTGRES_URL` | Yes* | — | Supabase pooler connection string |
| `POSTGRES_PRISMA_URL` | Yes* | — | Alternative pooler URL |
| `SUPABASE_DB_URL` | Yes* | — | Direct DB connection (fallback) |
| `SUPABASE_URL` | No | — | Supabase project URL |
| `SUPABASE_KEY` / `SUPABASE_SERVICE_ROLE_KEY` | No | — | Supabase service key |
| `OPENAI_API_KEY` | Yes (RAG) | — | OpenAI API key for file_search |
| `OPENAI_API_BASE` | No | https://api.openai.com/v1 | Override OpenAI base URL |
| `OPENAI_RAG_MODEL` | No | gpt-4o-mini | Model for RAG completions |
| `MATRIYA_OPENAI_VECTOR_STORE_ID` | No | — | Pre-created vector store ID |
| `LLM_PROVIDER` | No | together | `together` \| `huggingface` |
| `TOGETHER_API_KEY` | No | — | Together AI key |
| `TOGETHER_MODEL` | No | mistralai/Mistral-7B-Instruct-v0.2 | Together model |
| `HF_API_TOKEN` | No | — | Hugging Face token |
| `HF_MODEL` | No | microsoft/phi-2 | HF model |
| `EMBEDDING_MODEL` | No | sentence-transformers/all-MiniLM-L6-v2 | Local embedding model |
| `MATRIYA_LLM_TEMPERATURE` | No | 0 | LLM temperature (0 = deterministic) |
| `UPLOAD_DIR` | No | ./uploads | Upload temp dir (auto → /tmp on Vercel) |
| `MAX_FILE_SIZE` | No | 52428800 (50MB) | Max file upload size bytes |
| `CHUNK_SIZE` | No | 500 | Text chunk token size |
| `CHUNK_OVERLAP` | No | 100 | Chunk overlap tokens |
| `MATRIYA_MANAGEMENT_API_URL` | No | — | managment-back URL (for lab bridge) |
| `MATRIYA_MANAGEMENT_MATERIALS_KEY` | No | — | Shared secret for materials API |
| `MANAGEMENT_BACK_URL` | No | — | Alias for above |
| `MATRIYA_PRE_LLM_MIN_SIMILARITY` | No | — | Min similarity before LLM call |
| `MATRIYA_PRE_LLM_MIN_CHUNKS` | No | — | Min chunk count before LLM call |
| `MATRIYA_RETRIEVAL_SIMILARITY_THRESHOLD` | No | — | pgvector similarity threshold |
| `MATRIYA_MAX_ATTRIBUTION_SOURCES` | No | — | Max citation sources in answer |
| `MATRIYA_DOMAIN_MIN_QUERY_OVERLAP` | No | 2 | Domain filter: min token overlap |
| `MATRIYA_GENERATION_MIN_CHUNKS` | No | — | Min chunks for generation gate |
| `MATRIYA_GENERATION_MIN_TOPK_SIMILARITY_SUM` | No | — | Min sum of top-k similarity scores |
| `MATRIYA_GENERATION_TOPK_SUM_K` | No | — | K value for top-k sum check |
| `B_INTEGRITY_MAX_GROWTH_RATIO` | No | 0.5 | Max document growth ratio per cycle |
| `B_INTEGRITY_NO_PROGRESS_CYCLES` | No | 3 | Cycles with no progress before violation |
| `B_INTEGRITY_METRIC_CAP` | No | 0 (disabled) | Hard cap on metric value |
| `B_INTEGRITY_MAX_DROP_PERCENT` | No | 100 | Max drop % without structural change |
| `KERNEL_V16_STRICT` | No | — | Enable strict KernelV16 validation |

*One of `POSTGRES_URL`, `POSTGRES_PRISMA_URL`, or `SUPABASE_DB_URL` is required.

### `managment-back`

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `PORT` | No | 8001 | HTTP listen port |
| `SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_URL` | Yes | — | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | — | Supabase service key |
| `MATRIYA_BACK_URL` | No | — | URL to matriya-back (auth proxy) |
| `MANEGER_MATERIALS_SUMMARY_SERVER_KEY` | No | — | Server key for materials summary |
| `OPENAI_API_KEY` | Yes (GPT RAG) | — | OpenAI key for project RAG |
| `OPENAI_RAG_MODEL` | No | gpt-4o-mini | GPT model for project RAG |
| `MANEGER_GPT_RAG_WAIT_FOR_INDEXING` | No | — | Wait for OpenAI indexing after sync |
| `MANEGER_GPT_RAG_BATCH_POLL_MAX` | No | — | Max polling attempts after sync |
| `MANEGER_GPT_SNIPPET_INDEX_FILTER` | No | — | Filter for snippets to index |
| `GPT_RAG_AUTO_SYNC_DEBOUNCE_MS` | No | — | Debounce ms for auto-sync |
| `RESEND_API_KEY` | No | — | Resend email API key |
| `RESEND_FROM_EMAIL` | No | onboarding@resend.dev | Sender address |
| `RESEND_INBOUND_WEBHOOK_SECRET` | No | — | Secret for inbound email webhook |
| `RESEND_REPLY_DOMAIN` | No | — | Domain for project Reply-To addresses |
| `PUBLIC_API_BASE_URL` | No | — | Public URL of this API |
| `SHAREPOINT_TENANT_ID` | No | — | Azure AD tenant ID |
| `SHAREPOINT_CLIENT_ID` | No | — | Azure app client ID |
| `SHAREPOINT_CLIENT_SECRET` | No | — | Azure app client secret |
| `CORS_ORIGINS` | No | — | Comma-separated allowed origins |
| `CORS_ALLOW_VERCEL_PREVIEWS` | No | — | Allow `*.vercel.app` origins |
| `AUTH_LOGIN_RATE_LIMIT_MAX` | No | — | Max login attempts per window |
| `DISABLE_AUTH_RATE_LIMIT` | No | — | Disable auth rate limiting |
| `UPLOAD_RATE_LIMIT_MAX` | No | — | Max upload requests per window |
| `API_RATE_LIMIT_MAX` | No | — | Max general API requests per window |
| `POSTGRES_URL` / `DATABASE_URL` | No | — | PostgreSQL URL for lab bridge queries |

---

## Database Models

All models are in `matriya-back/database.js` (Sequelize). Tables belong to Supabase PostgreSQL.

| Model | Table | Purpose |
|---|---|---|
| `User` | `users` | Auth users: `username`, `email`, `hashed_password`, `full_name`, `is_admin`, `is_active`, `last_login` |
| `FilePermission` | `file_permissions` | Which user has access to which filename |
| `SearchHistory` | `search_history` | Every question + answer logged per user |
| `ResearchSession` | `research_sessions` | One session per user research cycle; stores `completed_stages` (array), `kernel_context` (JSONB), `enforcement_overridden` |
| `ResearchAuditLog` | `research_audit_log` | Audit trail: stage, response_type, request_query per session |
| `PolicyAuditLog` | `policy_audit_log` | Policy-level audit entries |
| `DecisionAuditLog` | `decision_audit_log` | Full decision trail: decision, inputs_snapshot, confidence_score, basis_count, model_version_hash, complexity_context, human_feedback |
| `NoiseEvent` | `noise_events` | Noise events flagged for re-evaluation after kernel update |
| `IntegrityCycleSnapshot` | `integrity_cycle_snapshots` | `metric_value` (document count) per stage/cycle — feeds B-Integrity rules |
| `Violation` | `integrity_violations` | Active violations: `type`, `reason`, `session_id`, `resolved_at` (null = active) |
| `SystemSnapshot` | `system_snapshots` | Periodic system-level metric snapshots |
| `ResearchLoopRun` | `research_loop_runs` | 4-agent loop run records |
| `JustificationTemplate` | `justification_templates` | Templates for gate justifications |
| `DoEDesign` | `doe_designs` | Design of Experiment designs |

RAG documents live in `rag_documents` (pgvector extension, not a Sequelize model). Schema defined in `supabase_setup_complete.sql`.

---

## Service Deep-Dives

---

### matriya-back Deep-Dive

#### Bootstrap (`server.js`)

1. Loads `config.js` (reads all env vars, creates upload dir).
2. Configures CORS from env, `express-rate-limit` on API and auth routes.
3. Sets body parser limit from `EXPRESS_BODY_LIMIT` (default 15mb — needed for `/ask-matriya` with hundreds of logical file paths).
4. Mounts routers:
   - `/auth` → `authEndpoints.js`
   - `/admin` → `adminEndpoints.js`
   - All other routes inline in `server.js`

#### Auth (`authEndpoints.js`)

- **`POST /auth/signup`** — creates user with bcrypt-hashed password, returns JWT.
- **`POST /auth/login`** — verifies password, updates `last_login`, returns JWT.
- **`GET /auth/me`** — decodes Bearer token, returns user profile.
- **`GET /auth/users`** — returns all active users (id + username) for member-add dropdown.
- Token format: `Authorization: Bearer <token>` (sub = username).
- `requireAuth` middleware is reused across all protected routes.
- Admin check: `user.is_admin === true` **or** `user.username === "admin"`.

#### Config (`config.js`)

A `Settings` class reads all env vars with safe defaults. Key behaviours:
- `UPLOAD_DIR` auto-routes to `/tmp/matriya-uploads` when `VERCEL=1`.
- `LLM_TEMPERATURE` is clamped to `[0, 2]`; defaults to 0.
- `EXPRESS_BODY_LIMIT` defaults to `15mb` with double-fallback guard.
- All optional API keys default to `null` (not empty string) so downstream `if (key)` checks work correctly.

#### Database (`database.js`)

- Prefers Supabase pooler URL (`pooler.supabase.com:6543`) over direct URL.
- On Vercel, pool `max` is 1 (serverless constraint); prepared statements are disabled for PgBouncer compatibility.
- All models have `timestamps: false`; `created_at` is managed manually.
- `STAGES_ORDER = ['K', 'C', 'B', 'N', 'L']` is exported and used across gate + FSM files.
- `initDb()` is called lazily on first request (critical for Vercel cold starts).

#### RAG Service (`ragService.js`)

The ingestion and retrieval orchestrator.

**Ingest flow** (triggered by `POST /ingest`):
1. Multer saves file to `UPLOAD_DIR`.
2. Text extracted: PDF → `pdf-parse`; DOCX → `mammoth`; XLSX/XLS → `xlsx`; TXT/images → read/base64.
3. Text is split into chunks (`CHUNK_SIZE` tokens, `CHUNK_OVERLAP` overlap).
4. Each chunk gets an embedding via `vectorStoreSupabase.js`.
5. Chunks stored in `rag_documents` table (pgvector).
6. After ingest, auto-sync to OpenAI vector store is triggered (debounced, opt-out via header).

**Retrieval flow** (triggered by `/search` or `/ask-matriya`):
1. Query embedding generated.
2. pgvector similarity search returns top-k chunks.
3. Domain filter applied (`domainAndGenerationGate.js`) — drops chunks with no query-token overlap.
4. If OpenAI is configured and `USE_OPENAI_FILE_SEARCH=true`, call `openaiFileSearchMatriya.js`.
5. Merge vector results + file_search snippets.
6. Generation gate: check minimum chunk count and similarity sum before calling LLM.
7. LLM called (Together AI / HF / OpenAI) with retrieved context.
8. Answer wording guard and source binding filter applied.
9. Response includes citations via `answerAttribution.js`.

**Fail-safe** (`ragEvidenceFailSafe.js`):
- If no supporting evidence found → return canonical message `"אין במערכת מידע תומך לשאלה זו."` only.
- If answer starts with "no support" but continues with advice/lists → truncate to first block only.

#### Research Gate / FSCTM (`researchGate.js`)

The core gate enforcing K → C → B → N → L stage progression.

**Session lifecycle:**
1. Client calls `POST /research/session` → creates a `ResearchSession` row.
2. Every research query includes `session_id` + `stage`.
3. Gate calls `validateAndAdvance(sessionId, stage)`:
   - Checks for active B-Integrity violation → hard stop if exists.
   - Checks `completed_stages` array in DB → rejects out-of-order stages.
   - On pass: records stage in audit log, advances `completed_stages`.
4. Response includes `responseType`: `hard_stop` | `info_only` | `full_answer`.

**Gate rules per stage:**
- **K** — Known information only, no solutions proposed.
- **C** — Confirmed/verified information only.
- **B** — Hard stop stage; enforces breakdown detection via Kernel v1.6.
- **N** — Allowed only after B is completed.
- **L** — Final synthesis stage; L-gate validation runs.

**Kernel v1.6** (`kernelV16.js`):
- `evaluateBreakdown(signals)` — detects model fit failure, OOD error, non-random residuals, change points.
- `evaluateFailSafe(signals)` — detects indistinguishable variables or insufficient data.
- `validateDataAnchors(anchors)` — only `experiment_snapshot`, `similar_experiments`, `failure_patterns` are allowed anchor keys.
- `checkExtrapolationRule(signals)` — flags out-of-domain extrapolation.
- `validateLGate(signals)` — final L-stage validation.
- `isStrictV16()` — reads `KERNEL_V16_STRICT` env flag.

#### B-Integrity System

**Rules engine** (`integrityRulesEngine.js`):
- Configurable conditions: `growth_above_ratio`, `decrease_without_structural_change`, `no_progress_cycles`, `metric_above`, `metric_below`, `drop_percent_above`.
- Context built from last N `IntegrityCycleSnapshot` rows for a session.
- First matching rule triggers action (default: `create_violation`).

**Monitor** (`integrityMonitor.js`):
- Called after each research cycle with current document count.
- Saves new `IntegrityCycleSnapshot`.
- Runs rules engine against recent snapshots.
- Creates `Violation` record if triggered.
- `getActiveViolation(sessionId)` — used by gate to check lock status.

**Recovery**:
- Admin endpoint `POST /admin/integrity/recovery` resolves a violation (sets `resolved_at`).
- After recovery, gate is unlocked for that session.

#### Risk Oracle (`riskOracle.js`)

Read-only. Evaluates risk indicators from recent data:
- `active_violations` — any unresolved violation → `high` severity.
- `potential_growth` — document count growing toward threshold → `medium`/`high`.
- `violation_spike` — more than 2 violations in last 7 days → `medium`.
- `no_progress` — metric unchanged for N cycles → `low`.

Called by admin panel for dashboard display.

#### Research Loop (`researchLoop.js`)

4-agent chain for deep research:
1. **Analysis agent** — analyzes the question and identifies information needs.
2. **Research agent** — retrieves relevant documents and data.
3. **Critic agent** — evaluates quality and completeness of retrieved data.
4. **Synthesis agent** — synthesizes a final answer.

Triggered by `POST /api/research/run` from the SearchTab "agents" mode.

#### Answer Composer (`services/answerComposer.js`)

Lab-only decision engine. Contract:
- `decision_status` comes **only** from `labResult` (never from external context).
- `VALID_CONCLUSION` requires: `data_grade === 'REAL'`, comparable delta, delta ≥ threshold.
- `buildActionRequired(decisionStatus, dataGrade)` → `GO` | `ITERATE` | `STOP`.
  - `REAL` data + `VALID_CONCLUSION` → `GO`.
  - Non-`REAL` data (HISTORICAL_REFERENCE, NO_DATA) → always `STOP`.
  - `INCONCLUSIVE` or `NO_CHANGE` → `ITERATE`.
- `decideEfficacyFromDelta(maxDeltaPct, thresholdPct)` → single source of truth for efficacy.
- `external_context` attached after decision is fixed; never affects `decision_status`.

#### lib/ Module Reference

| File | Purpose |
|---|---|
| `openaiFileSearchMatriya.js` | Wraps OpenAI Responses API; parses file_search_call output items; extracts text + filename from varied API response shapes |
| `openaiMatriyaConfig.js` | Reads vector store ID, model, API base from env; lazy singleton pattern |
| `matriyaOpenAiSync.js` | Manual file upload/delete to OpenAI vector store; tracks file IDs |
| `matriyaOpenAiAutoSync.js` | Debounced auto-sync after ingest; skipped when `X-Matriya-Client-Gpt-Sync: 1` header is sent |
| `domainAndGenerationGate.js` | Two gates: (1) domain filter drops chunks with <2 query-token hits; (2) generation gate checks min chunks + min similarity sum before calling LLM |
| `ragEvidenceFailSafe.js` | Canonical no-evidence message + `sanitizeAnswerWhenNoSupportClaimed()` to strip advice from answers that open with "no support" |
| `answerAttribution.js` | Builds `sources[]` array from retrieval rows for front-end citation display |
| `answerWordingGuard.js` | Strips forbidden phrases and wording patterns from generated answers |
| `answerSourceBindingFilter.js` | Removes sources that do not have text overlap with the final answer |
| `gptRagEligible.js` | Returns true if filename extension is in the GPT-eligible list |
| `filterFileSearchSnippetsToIndex.js` | Filters which file_search snippets to include in structured index |
| `researchEvidenceGaps.js` | Detects missing evidence for a stage (e.g., no prior art, no benchmark) |
| `matriyaLabBridgeFlow.js` | Calls `managment-back /api/lab/query` and maps response to Answer Composer format |
| `detectStructuredFormulationChunks.js` | Detects chunks containing formulation data (percent compositions, tables) to keep them even if domain filter would drop them |
| `uploadAskMaterialsRouter.js` | Route handler: upload files then query materials library |
| `davidAskMatriyaAcceptance.js` | Acceptance checks per David's spec (e.g., no fallback advice in no-evidence replies) |
| `externalLayerRouter.js` | Handles `/api/external/*` routes — external data providers (web, databases) |
| `externalLayerPool.js` | Pool of external data provider instances |
| `textEncoding.js` | UTF-8 encoding detection and conversion helpers |
| `excelPercentFormat.js` | Format Excel cell values as percentages |
| `vectorMetadataFilenameFilter.js` | Filter pgvector result rows by filename in metadata |

---

### matriya-front Deep-Dive

#### App Shell (`src/App.js`)

- Reads JWT from `localStorage` on mount; calls `GET /auth/me` to validate.
- Tab state: Upload | Search | Ask Matriya | Admin (admin-only) | Info.
- Passes `gptRagSyncing` flag as prop to `UploadTab` and `SearchTab` — prevents searches during active sync.

#### UploadTab (`components/UploadTab.js`)

- Fetches file list from `GET /files/detail` on mount.
- Builds a virtual folder tree from filenames containing `/` separators.
- Ingest: `POST /ingest` with `multipart/form-data`; sends `X-Matriya-Client-Gpt-Sync: 1` to suppress auto-sync (UI calls sync explicitly).
- GPT Sync: `POST /gpt-rag/sync` — uploads files to OpenAI vector store.
- Per-file ask: `POST /ask-matriya` with a single-file scope.
- Preview: shows parsed text for PDFs/text files.
- Folder upload: multiple files with virtual folder prefix.

#### SearchTab (`components/SearchTab.js`)

Three modes selectable in UI:
1. **Quick + Research** — `GET /search` with `session_id`, `stage`, `query`, optional `kernel_signals` / `data_anchors` / `methodology_flags` (Kernel v1.6 JSON blocks).
2. **Quick + Lab** — `POST /search` with `flow=lab`; triggers Answer Composer path; expects `labResult`-shaped JSON back.
3. **Agents** — `POST /api/research/run`; triggers 4-agent research chain; slower, deeper.

Session lifecycle:
- On mount: `POST /research/session` → stores `session_id` in state.
- Every research query sends `session_id` + `stage` (K/C/B/N/L picked by user).
- Gate responses with `research_gate_locked: true` show recovery instructions.

Lab fields (visible in Lab mode):
- `labQueryType` (default: `version_comparison`)
- `labBaseId`, `labVersionA`, `labVersionB`, `labIdA`, `labIdB`
- `preJustification` — optional justification text

Kernel v1.6 advanced section (collapsible):
- `kernelSignalsJson` — JSON for breakdown/OOD/residuals signals
- `dataAnchorsJson` — JSON for experiment_snapshot/similar_experiments/failure_patterns
- `methodologyFlagsJson` — JSON for repeated_solution/patches/cost_rising flags

#### AskMatriyaTab (`components/AskMatriyaTab.js`)

- Conversational chat interface.
- `POST /ask-matriya` with `question`, optional `file_filter` (single file scope or all files).
- Renders markdown answers with bold formatting via `formatBold.js`.
- Shows evidence citations via `AnswerEvidenceSection`.
- OpenAI sync status shown via `GptSyncStatusRow`.

#### AdminTab (`components/AdminTab.js`)

Sections (tab-within-tab):
- **Files** — lists all files, delete button per file (calls `DELETE /admin/files/:filename`).
- **Users** — list users, assign file permissions per user.
- **Integrity** — shows active violations; recovery button calls `POST /admin/integrity/recovery`.
- **Risk Oracle** — shows risk indicators from `GET /admin/risk-oracle`.
- **History** — search history table; export CSV.
- **FIL** — FIL layer warnings from `GET /admin/fil-warnings`.

Admin access: only visible when `user.is_admin === true`.

#### InfoTab (`components/InfoTab.js`)

- Fetches system info: collection size, chunk count, embedding model, vector store ID.
- Refresh button; shows loading/empty states.

---

### managment-back Deep-Dive

#### Server (`server.js`)

A ~5500-line single-file Express server. Key sections:

**Auth proxy:**
- `POST /api/auth/login`, `POST /api/auth/signup`, `GET /api/auth/me` — proxied to `matriya-back` via `MATRIYA_BACK_URL`.
- JWT tokens from matriya-back are passed through directly.

**Projects:**
- `GET/POST /api/projects` — list/create projects.
- `GET/PUT/DELETE /api/projects/:id` — single project CRUD.
- `GET /api/projects/:id/access` — check if user has access.
- `POST /api/projects/:id/members` — add member by username (username must exist in matriya-back users).
- `DELETE /api/projects/:id/members/:userId` — remove member.

**Lab:**
- `GET /api/projects/:id/lab` — list experiments (runs).
- `POST /api/projects/:id/lab` — create experiment run.
- `GET/PUT/DELETE /api/projects/:id/lab/:runId` — single run CRUD.
- `POST /api/lab/parse-experiment-file` — parse uploaded Excel/CSV/TXT/JSON → Markdown table.
- `POST /api/projects/:id/lab/:runId/analyze` — analyze experiment with GPT using project RAG context.
- `GET /api/lab/query` — Lab bridge query (see `labBridgeQueryRoute.js`).

**Materials:**
- `GET /api/projects/:id/materials` — list materials.
- `POST /api/projects/:id/materials` — add material.
- `GET/PUT/DELETE /api/projects/:id/materials/:matId` — single material CRUD.
- `GET /api/matriya/projects-with-materials-summary` — summary for Matriya materials bridge (requires `X-Matriya-Materials-Key` or user JWT).

**Files and GPT RAG:**
- `POST /api/projects/:id/files` — upload file to Supabase bucket (multipart).
- `DELETE /api/projects/:id/files/:fileId` — delete file + remove from OpenAI vector store.
- `POST /api/projects/:id/gpt-rag/sync` — sync all project files to OpenAI vector store.
- `POST /api/projects/:id/gpt-rag/query` — query project GPT RAG.

**SharePoint:**
- `GET /api/projects/:id/sharepoint/files` — list SharePoint files.
- `POST /api/projects/:id/sharepoint/import` — import SharePoint file into project.

**Email:**
- `GET /api/projects/:id/emails` — list emails.
- `POST /api/projects/:id/emails` — send email via Resend.
- `POST /api/webhooks/resend-inbound` — inbound email webhook; routes by Reply-To UUID; imports lab attachment if detected.

**Chat:**
- `GET /api/projects/:id/chat` — get messages.
- `POST /api/projects/:id/chat` — post message.
- `PUT /api/projects/:id/chat/read` — mark read.

**Audit / Trace:**
- Audit log entries written on CRUD operations.
- `GET /api/projects/:id/audit` — get audit log.
- `GET /api/projects/:id/trace` — trace run decisions.

#### Lab Bridge (`lib/labBridgeQueryRoute.js`)

- Exposes `GET /api/lab/query` — called by `matriya-back` in `flow=lab` mode.
- Connects directly to PostgreSQL (raw `pg.Pool`, not Sequelize) via `POSTGRES_URL` / `DATABASE_URL`.
- Query types: `version_comparison` (default), `single_version`.
- For `version_comparison`: fetches two run rows by `base_id` + version A/B + date IDs; computes delta.
- Returns Answer Composer-compatible JSON: `{ query_type, source_run_ids, version_a, version_b, delta_summary, data_grade, ... }`.
- `data_grade`: `REAL` (actual experiment), `HISTORICAL_REFERENCE` (old data), `NO_DATA`, `LOGICAL`.
- If no DB connection: returns 503 with `poolConfigHint` explaining the issue.

#### GPT RAG Sync (`lib/gptRagSync.js`)

- Syncs Supabase Storage files (from `sharepoint-files` or `manualy-uploded-sharepoint-files` buckets) into a per-project OpenAI vector store.
- Downloads each eligible file from Supabase bucket → uploads to OpenAI Files API → adds to vector store.
- Eligible extensions: `.pdf .docx .doc .txt .xlsx .xls .pptx .csv .json .md .html .htm`.
- Max 50 files per project, 32MB per file.
- Smart MIME detection: if a `.pdf` file is actually plain text (bytes look UTF-8), uploads as `.txt` to avoid OpenAI parse errors.
- `filterProjectGptSnippetsToIndex()` filters which file_search snippets become structured index entries.

#### Lab Experiment Parsing (`lib/labExperimentParse.js`)

- `parseExperimentBufferToText(buffer, originalName)` — single entry point.
- Excel: `xlsx` library → `labExcelPaddedMatrix()` → Markdown table (max 500 rows, 40 cols, configurable).
- CSV: same path via xlsx.
- TXT/JSON: read as string.
- PDF: calls matriya-back's `/ingest` endpoint (HTTP) to reuse its pdf-parse pipeline.
- `excelRowsToMarkdownTable()` builds GitHub-flavored Markdown tables with pipe escaping.

#### Lab Composition Compare (`lib/labCompositionCompare.js`)

- `parseCompositionFromText(text)` — extracts material→percent map from Markdown table or tab-separated lines.
- `compareCompositionMaps(mapA, mapB)` — produces delta map: `{ material, pctA, pctB, delta }`.
- `compareFromSingleTwoColumnTable(headers, rows)` — detects two-column table with A/B columns.
- `percentagesObjectToMap(obj)` — converts `{ material: "50%" }` objects to float maps.

---

### managment-front Deep-Dive

#### App Shell (`src/App.jsx`)

~4349-line single file. Uses React Router v6 with nested routes.

**Route structure:**
```
/login              Login page
/register           Signup page
/projects           Project list
/project/:id/section/:section
  section = lab         Experiments spreadsheet + analysis
  section = materials   Materials library
  section = rag         Documents + GPT RAG chat
  section = emails      Email inbox + send
  section = settings    Project settings + members
```

**Auth:**
- On app load: reads token from `localStorage` (key: `maneger_token`).
- Calls `GET /api/auth/me` to validate.
- 401 interceptor in `api.js` auto-clears token + redirects to `/login`.

**Sidebar:**
- Shown only when a project is active (when `:id` param exists).
- Navigation links: Projects, Experiments (🧪), Materials (🧱), Documents (📁), Emails (✉️), Settings (⚙️).
- `SidebarProjectContext` shares project name from project detail fetch.

**Lab section:**
- Shows `LabExcelSpreadsheet` component (React Data Grid).
- Columns: experiment metadata + measurements.
- Upload experiment file → parse to rows.
- Analyze with GPT: sends rows + project RAG context.
- Compare mode (A vs B): calls `compareCompositionMaps` logic on front-end.

**RAG/Documents section:**
- Lists project files from Supabase.
- Upload file: `POST /api/projects/:id/files`.
- Sync to GPT: `POST /api/projects/:id/gpt-rag/sync`.
- Ask question: `POST /api/projects/:id/gpt-rag/query`.
- Renders answers as Markdown (with table support via `remark-gfm`).
- Renders comparison tables inline.

**Materials section:**
- CRUD for material records.
- Each material has name, description, properties.
- Materials feed into experiment runs as referenced components.

**Emails section:**
- Inbox: lists emails received (via Resend inbound webhook).
- Compose: sends via Resend.
- Reply-To: per-project address `<project-uuid>@domain` routes inbound replies.
- Lab import: email attachments detected as lab data are auto-imported.

#### API Client (`src/api.js`)

~400-line Axios client. Organized as named export groups:
- `auth` — login, signup, me
- `users` — list
- `projects` — list, get, getAccess, create, update, delete
- `tasks`, `milestones`, `documents`, `notes` — standard CRUD
- `projectFiles` — upload, list, delete
- `rag` — local management RAG (if enabled)
- `gptRag` — sync, query
- `chat` — list, post, markRead
- `emails` — list, send
- `lab` — list runs, create, update, delete, parseFile, analyze, labBridgeQuery
- `auth` — proxied to matriya-back

---

## API Surface

### MATRIYA API (`matriya-back`, port 8000)

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/auth/signup` | Public | Create account |
| POST | `/auth/login` | Public | Get JWT |
| GET | `/auth/me` | Bearer | Current user |
| GET | `/auth/users` | Bearer | List all users |
| POST | `/ingest` | Bearer | Upload + ingest document |
| GET | `/files` | Bearer | List filenames |
| GET | `/files/detail` | Bearer | List files with metadata |
| DELETE | `/files/:filename` | Bearer | Delete file (user) |
| GET | `/documents` | Bearer | List document chunks |
| POST | `/reset` | Admin | Delete all documents |
| POST | `/search` | Bearer | Vector + RAG search |
| POST | `/ask-matriya` | Bearer | Conversational RAG |
| POST | `/research/session` | Bearer | Create research session |
| GET | `/research/session/:id` | Bearer | Get session state |
| POST | `/api/research/search` | Bearer | Research gate query |
| POST | `/api/research/run` | Bearer | 4-agent research chain |
| GET | `/api/audit/decisions` | Bearer | Decision audit log |
| GET | `/api/observability/gate` | Bearer | Gate observability info |
| POST | `/gpt-rag/sync` | Bearer | Sync files to OpenAI vector store |
| GET | `/gpt-rag/status` | Bearer | OpenAI sync status |
| GET | `/collection/info` | Bearer | pgvector collection info |
| GET | `/admin/files` | Admin | List all files |
| DELETE | `/admin/files/:filename` | Admin | Delete file (admin) |
| GET | `/admin/users` | Admin | List users |
| POST | `/admin/users/:id/permissions` | Admin | Set file permissions |
| GET | `/admin/history` | Admin | Search history |
| POST | `/admin/integrity/recovery` | Admin | Resolve B-Integrity violation |
| GET | `/admin/risk-oracle` | Admin | Risk indicators |
| GET | `/admin/fil-warnings` | Admin | FIL layer warnings |
| GET | `/api/external/search` | Bearer | External layer search |
| POST | `/api/external/search` | Bearer | External layer search (POST) |

### Management API (`managment-back`, port 8001)

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/auth/login` | Public | Login (proxied) |
| POST | `/api/auth/signup` | Public | Signup (proxied) |
| GET | `/api/auth/me` | Bearer | Current user (proxied) |
| GET | `/api/users` | Bearer | List users |
| GET | `/api/projects` | Bearer | List projects |
| POST | `/api/projects` | Bearer | Create project |
| GET | `/api/projects/:id` | Bearer | Get project |
| PUT | `/api/projects/:id` | Bearer | Update project |
| DELETE | `/api/projects/:id` | Bearer | Delete project |
| GET | `/api/projects/:id/access` | Bearer | Check access |
| POST | `/api/projects/:id/members` | Bearer | Add member |
| DELETE | `/api/projects/:id/members/:uid` | Bearer | Remove member |
| GET | `/api/projects/:id/lab` | Bearer | List experiment runs |
| POST | `/api/projects/:id/lab` | Bearer | Create run |
| GET/PUT/DELETE | `/api/projects/:id/lab/:runId` | Bearer | Run CRUD |
| POST | `/api/lab/parse-experiment-file` | Bearer | Parse experiment file |
| GET | `/api/lab/query` | Server key or Bearer | Lab bridge query |
| POST | `/api/projects/:id/lab/:runId/analyze` | Bearer | GPT analyze run |
| GET | `/api/projects/:id/materials` | Bearer | List materials |
| POST | `/api/projects/:id/materials` | Bearer | Add material |
| GET/PUT/DELETE | `/api/projects/:id/materials/:matId` | Bearer | Material CRUD |
| GET | `/api/matriya/projects-with-materials-summary` | Key or Bearer | Materials summary |
| GET | `/api/projects/:id/files` | Bearer | List project files |
| POST | `/api/projects/:id/files` | Bearer | Upload file |
| DELETE | `/api/projects/:id/files/:fileId` | Bearer | Delete file |
| POST | `/api/projects/:id/gpt-rag/sync` | Bearer | Sync to OpenAI |
| POST | `/api/projects/:id/gpt-rag/query` | Bearer | GPT RAG query |
| GET | `/api/projects/:id/sharepoint/files` | Bearer | SharePoint file list |
| POST | `/api/projects/:id/sharepoint/import` | Bearer | Import SharePoint file |
| GET | `/api/projects/:id/emails` | Bearer | List emails |
| POST | `/api/projects/:id/emails` | Bearer | Send email |
| POST | `/api/webhooks/resend-inbound` | Webhook secret | Inbound email |
| GET | `/api/projects/:id/chat` | Bearer | Chat messages |
| POST | `/api/projects/:id/chat` | Bearer | Post chat message |
| PUT | `/api/projects/:id/chat/read` | Bearer | Mark chat read |
| GET | `/api/projects/:id/audit` | Bearer | Audit log |
| GET | `/api/projects/:id/tasks` | Bearer | Task list |
| POST | `/api/projects/:id/tasks` | Bearer | Create task |
| GET | `/api/projects/:id/milestones` | Bearer | Milestones |
| GET | `/api/projects/:id/documents` | Bearer | Documents |
| GET | `/api/projects/:id/notes` | Bearer | Notes |
| GET | `/health` | Public | Health check |

---

## Common Payloads

### Auth

```json
// POST /auth/login
{ "username": "alice", "password": "secret" }

// POST /auth/signup
{ "username": "alice", "email": "alice@example.com", "password": "secret", "full_name": "Alice" }

// Response
{ "access_token": "...", "token_type": "bearer", "user": { "id": 1, "username": "alice", "is_admin": false } }
```

### Research session + gate query

```json
// POST /research/session — no body required
// Response: { "session_id": "uuid" }

// POST /api/research/search
{
  "query": "מה ידוע על צמיגות הפורמולה?",
  "session_id": "uuid",
  "stage": "K",
  "file_filter": [],
  "kernel_signals": { "sufficient_data": true },
  "data_anchors": { "experiment_snapshot": { "run_id": "BASE-003" } },
  "methodology_flags": { "repeated_solution": false }
}
```

### Ask Matriya

```json
// POST /ask-matriya
{
  "question": "מה הצמיגות של פורמולה 003?",
  "file_filter": ["path/to/file.pdf"],
  "session_id": "uuid"
}
```

### Lab query (managment-back)

```json
// GET /api/lab/query?base_id=BASE-003&version_a=003.1&version_b=003.2&id_a=27.10.2022&id_b=28.09.2023
// Response (Answer Composer shape):
{
  "query_type": "version_comparison",
  "source_run_ids": ["uuid1", "uuid2"],
  "version_a": "003.1",
  "version_b": "003.2",
  "delta_summary": { "viscosity_cps": 120.5 },
  "data_grade": "REAL",
  "conclusion_status": "VALID_CONCLUSION"
}
```

### GPT RAG query (managment-back)

```json
// POST /api/projects/:id/gpt-rag/query
{ "query": "What is the composition of formulation 003?" }
```

### File upload (multipart)

```
POST /ingest
Content-Type: multipart/form-data
file=@document.pdf
folder_path=lab/2024
```

---

## Cross-Service Data Flow

### Upload → Ingest → Search

```
User uploads PDF in matriya-front UploadTab
  → POST /ingest (matriya-back)
  → multer saves to UPLOAD_DIR
  → pdf-parse extracts text
  → chunked (500 tokens, 100 overlap)
  → embeddings via @xenova/transformers
  → stored in rag_documents (pgvector)
  → auto-sync triggered (debounced) → OpenAI vector store upload

User searches in SearchTab
  → POST /api/research/search (matriya-back)
  → FSCTM gate check (session_id + stage)
  → B-Integrity check (no active violation)
  → vector search (pgvector similarity)
  → domain filter (token overlap)
  → OpenAI file_search (if configured)
  → generation gate (min chunks + similarity)
  → LLM call with retrieved context
  → wording guard + source binding filter
  → response with answer + citations
```

### Management Lab → Matriya Answer Composer

```
User selects Lab mode in SearchTab
  → POST /search?flow=lab (matriya-back)
  → matriyaLabBridgeFlow.js called
  → GET /api/lab/query (managment-back)
  → DB query: fetch version A and B run rows
  → compute delta, data_grade, conclusion_status
  → return Answer Composer JSON
  → matriya-back enriches with external_context (read-only, never affects decision)
  → front-end renders AnswerView component
```

### Email → Lab Import

```
Lab result emailed to <project-uuid>@domain
  → Resend inbound webhook POST /api/webhooks/resend-inbound
  → inboundProjectRouting.js extracts project UUID from Reply-To
  → labEmailImportValidation.js checks attachment structure
  → parseExperimentBufferToText() extracts rows
  → creates new experiment run in DB
  → if incomplete: sendLabImportIncompleteEmail() notifies sender
```

### Management Auth Proxy

```
managment-front login form
  → POST /api/auth/login (managment-back)
  → axios.post(MATRIYA_BACK_URL + '/auth/login')
  → JWT returned from matriya-back
  → managment-back passes JWT through
  → stored in localStorage as maneger_token
```

---

## Auth and Security

- JWT Bearer tokens are used across all four services.
- `managment-back` proxies all auth operations to `matriya-back`; tokens are identical.
- Password hashing: bcrypt (default rounds).
- Admin check: `is_admin === true` OR `username === "admin"` (double guard).
- Rate limiting:
  - Auth routes: configurable via `AUTH_LOGIN_RATE_LIMIT_MAX`.
  - Upload routes: `UPLOAD_RATE_LIMIT_MAX`.
  - General API: `API_RATE_LIMIT_MAX`.
- CORS: configured from `CORS_ORIGINS` env; `CORS_ALLOW_VERCEL_PREVIEWS` enables `*.vercel.app`.
- File permissions: admin assigns per-user access to specific filenames via `file_permissions` table.
- Server-to-server: `X-Matriya-Materials-Key` header (shared secret) for materials summary endpoint.

---

## Operations and Safety Rules

1. **Never skip research gate stages.** K → C → B → N → L order is enforced server-side. Client UI cannot bypass this.
2. **B-Integrity violation = gate locked.** Only admin recovery unblocks a session. Never delete violation records to unlock.
3. **External data is context only.** `external_context` is appended after `decision_status` is fixed. It must never alter the conclusion.
4. **No hardcoded production URLs.** All cross-service URLs come from env vars.
5. **Temperature stays at 0** unless explicitly overridden for a good reason. Reason must be documented.
6. **File uploads on Vercel must go to `/tmp`.** `config.js` enforces this automatically. Never override `UPLOAD_DIR` with a non-`/tmp` path in Vercel.
7. **Supabase pooler (PgBouncer) requires `prepare: false`** in Sequelize dialect options. Already set. Do not remove.
8. **Before any deployment:**
   - Run frontend build (`npm run build` in both frontend dirs).
   - Smoke test: login → upload file → search → admin panel.
   - Verify at least one research gate flow (K → C or K → C → B).
   - Verify lab bridge returns correct Answer Composer shape.
9. **RAG fail-safe cannot be removed.** The `"אין במערכת מידע תומך לשאלה זו."` message is the canonical no-evidence response. Never replace it with advice or speculation.

---

## Troubleshooting

### CORS errors

- Add the origin to `CORS_ORIGINS` in managment-back env.
- For Vercel previews, set `CORS_ALLOW_VERCEL_PREVIEWS=true`.
- Verify `REACT_APP_API_BASE_URL` / `VITE_MANEGER_API_URL` point to the correct backend.

### Auth loop / 401 redirect

- Confirm `MATRIYA_BACK_URL` in managment-back points to live matriya-back.
- Test `GET /auth/me` directly against matriya-back with the token.
- Check token key in `localStorage`: `matriya_token` (matriya-front) vs `maneger_token` (managment-front).

### Upload 413 / timeout

- Raise `EXPRESS_BODY_LIMIT` in matriya-back (default 15mb).
- On Vercel, also raise `client_max_body_size` at the reverse proxy level.
- Consider direct-to-Supabase-bucket upload to bypass API size limits.
- Check `UPLOAD_RATE_LIMIT_MAX` — reduce batch size if rate limited.

### GPT RAG returns "אין במערכת מידע"

- Verify `OPENAI_API_KEY` is set and valid.
- Check OpenAI vector store ID (`MATRIYA_OPENAI_VECTOR_STORE_ID` or auto-created).
- Re-run `POST /gpt-rag/sync` to force re-upload.
- Confirm files have GPT-eligible extensions (`.pdf`, `.docx`, `.txt`, etc.).
- Check `GET /gpt-rag/status` for sync errors.

### Research gate locked

- Check `GET /admin/integrity/recovery` or view active violations in AdminTab.
- Call `POST /admin/integrity/recovery` with violation ID to resolve.

### Lab bridge 503 / empty results

- Confirm `POSTGRES_URL` or `DATABASE_URL` is set in managment-back.
- Ensure it is a `postgresql://` or `postgres://` URI (not `neon://`).
- Do not include the variable name in the value field in Vercel.
- Check that experiment runs exist in DB with matching `base_id` + version + date.

### Database ENOTFOUND / connection error

- Use Supabase pooler URL (`pooler.supabase.com:6543`) not direct URL in production.
- Direct URL can fail if Supabase project is paused or DNS resolves slowly.
- Set `POSTGRES_URL` (pooler) in Vercel; keep `SUPABASE_DB_URL` (direct) only for local dev.

---

## Starter `.env` Templates

### `matriya-back/.env`

```env
API_PORT=8000
NODE_ENV=development
JWT_SECRET=replace_with_strong_32plus_char_secret

# Database — one of these required
POSTGRES_URL=postgresql://postgres.PROJECT:PASSWORD@aws-0-REGION.pooler.supabase.com:6543/postgres
SUPABASE_DB_URL=postgresql://postgres:PASSWORD@db.PROJECT.supabase.co:5432/postgres

# Supabase (optional — for bucket operations)
SUPABASE_URL=https://PROJECT.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...

# OpenAI — required for GPT RAG
OPENAI_API_KEY=sk-...
OPENAI_API_BASE=https://api.openai.com/v1
OPENAI_RAG_MODEL=gpt-4o-mini

# LLM fallback (pick one)
LLM_PROVIDER=together
TOGETHER_API_KEY=...
TOGETHER_MODEL=mistralai/Mistral-7B-Instruct-v0.2

# Integration with managment-back
MATRIYA_MANAGEMENT_API_URL=http://localhost:8001
MATRIYA_MANAGEMENT_MATERIALS_KEY=shared_secret_matches_maneger_back

# Tuning (optional)
MATRIYA_LLM_TEMPERATURE=0
EXPRESS_BODY_LIMIT=15mb
CHUNK_SIZE=500
CHUNK_OVERLAP=100
```

### `managment-back/.env`

```env
PORT=8001
NODE_ENV=development

# Supabase — required
SUPABASE_URL=https://PROJECT.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...

# Auth proxy — point to matriya-back
MATRIYA_BACK_URL=http://localhost:8000

# Shared secret for materials summary endpoint
MANEGER_MATERIALS_SUMMARY_SERVER_KEY=shared_secret_matches_matriya_back

# OpenAI — required for project GPT RAG
OPENAI_API_KEY=sk-...
OPENAI_RAG_MODEL=gpt-4o-mini

# Email (optional)
RESEND_API_KEY=re_...
RESEND_FROM_EMAIL=noreply@yourdomain.com
RESEND_REPLY_DOMAIN=yourdomain.com

# SharePoint (optional)
SHAREPOINT_TENANT_ID=...
SHAREPOINT_CLIENT_ID=...
SHAREPOINT_CLIENT_SECRET=...

# Lab bridge — direct DB access
POSTGRES_URL=postgresql://postgres.PROJECT:PASSWORD@aws-0-REGION.pooler.supabase.com:6543/postgres

# CORS
CORS_ORIGINS=http://localhost:5173,https://your-front.vercel.app
```

### `matriya-front/.env`

```env
REACT_APP_API_BASE_URL=http://localhost:8000
REACT_APP_MANAGEMENT_API_URL=http://localhost:8001
REACT_APP_MANAGEMENT_FRONT_URL=http://localhost:5173
```

### `managment-front/.env`

```env
VITE_MANEGER_API_URL=http://localhost:8001
VITE_SUPABASE_URL=https://PROJECT.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...
```

---

## Maintenance Notes

- Keep this file synchronized with route and env changes in all four `server.js` and `config.js` files.
- When adding new env vars: add to both code AND this doc AND the starter templates.
- When adding new routes: add to the API Surface table AND update the API client in `managment-front/src/api.js` if cross-service.
- Code is always the source of truth when this document conflicts.
- The `managment-*` / `maneger-*` naming inconsistency is intentional legacy. Do not silently rename.
