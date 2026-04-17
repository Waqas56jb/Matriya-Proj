# MATRIYA Monorepo - Claude Context

Operational README for Claude Code and engineers working in this repository.

---

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Repository Layout](#repository-layout)
- [Tech Stack](#tech-stack)
- [Quick Start](#quick-start)
- [Environment Variables](#environment-variables)
- [API Surface](#api-surface)
- [Common Payloads](#common-payloads)
- [Auth and Security](#auth-and-security)
- [Operations and Safety Rules](#operations-and-safety-rules)
- [Troubleshooting](#troubleshooting)
- [Starter `.env` Templates](#starter-env-templates)

---

## Overview

This monorepo contains 4 services:

- `matriya-front` - main MATRIYA UI
- `matriya-back` - MATRIYA API, research gate logic, RAG orchestration
- `managment-front` - management/lab UI
- `managment-back` - management/lab API and integration layer

Naming note:

- Existing names include `managment-*` and `maneger-*`.
- Keep current naming in env keys, routes, and URLs unless running a full migration.

---

## Architecture

### Core Principles

- MATRIYA and Management are separated by service boundaries.
- Integration is API-first.
- Supabase is used for relational storage and buckets.
- RAG flow uses OpenAI file-search and project-specific indexing/sync.
- Research and lab flows are guarded by deterministic gate/integrity logic with audit trails.

### Local Runtime Topology

- MATRIYA backend: `http://localhost:8000`
- Management backend: `http://localhost:8001`
- MATRIYA frontend: `http://localhost:3000`
- Management frontend: `http://localhost:5173`

---

## Repository Layout

```text
matriya-front/     React (CRA) client for MATRIYA
matriya-back/      Express API for MATRIYA
managment-front/   React (Vite) client for management/lab
managment-back/    Express API for management/lab
```

### Important Files

`matriya-back`:

- `server.js` - app bootstrap and route registration
- `authEndpoints.js` - auth and user endpoints
- `adminEndpoints.js` - admin panel APIs
- `researchGate.js` - gate decisions and scoring constraints
- `riskOracle.js` - risk rules
- `stateMachine.js` - state progression
- `ragService.js` - ingestion and retrieval orchestration

`matriya-front`:

- `src/App.js` - app shell and tab routing
- `src/utils/api.js` - API base URL + auth interceptor
- `src/utils/managementApi.js` - management API bridge

`managment-back`:

- `server.js` - API, bridge, uploads, SharePoint/email flows
- `lib/gptRagSync.js` - GPT RAG sync for project files
- `lib/labBridgeQueryRoute.js` - lab query route integration
- `lib/labExperimentParse.js` - experiment file parsing

`managment-front`:

- `src/App.jsx` - main application UI
- `src/api.js` - full client API contract

---

## Tech Stack

### `matriya-front`

- React 18
- CRA (`react-scripts`)
- Axios
- React Toastify
- React Icons

### `matriya-back`

- Node.js 18+ (ESM)
- Express, CORS, Multer
- PostgreSQL + Sequelize + pgvector
- Supabase client
- OpenAI integrations
- `pdf-parse`, `mammoth`, `xlsx`

### `managment-front`

- React 18 + Vite
- Axios
- Supabase JS
- React Router
- React Data Grid

### `managment-back`

- Node.js 18+ (ESM)
- Express + rate limiting
- Supabase client
- Zod validation
- Multer uploads
- OpenAI APIs
- Resend email integration

---

## Quick Start

### 1) Install dependencies

```bash
cd matriya-back && npm install
cd ../managment-back && npm install
cd ../matriya-front && npm install
cd ../managment-front && npm install
```

### 2) Create environment files

Create `.env` per service (see [Starter `.env` Templates](#starter-env-templates)).

### 3) Start services (recommended order)

```bash
cd matriya-back && npm run dev
cd managment-back && npm run dev
cd matriya-front && npm start
cd managment-front && npm run dev
```

### 4) Build check

```bash
cd matriya-front && npm run build
cd managment-front && npm run build
```

---

## Environment Variables

This section lists the high-impact variables used in code. Some are required, some optional/tuning.

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

### `matriya-back` (key groups)

Core:

- `API_PORT`, `API_HOST`, `NODE_ENV`, `LOG_LEVEL`, `JWT_SECRET`, `EXPRESS_BODY_LIMIT`

Data:

- `POSTGRES_URL`, `POSTGRES_PRISMA_URL`, `DATABASE_URL`, `SUPABASE_DB_URL`, `SUPABASE_URL`, `SUPABASE_KEY`/`SUPABASE_SERVICE_ROLE_KEY`

RAG/LLM:

- `OPENAI_API_KEY`, `OPENAI_API_BASE`, `OPENAI_RAG_MODEL`, `LLM_PROVIDER`
- `TOGETHER_API_KEY`, `TOGETHER_MODEL`, `HF_API_TOKEN`, `HF_MODEL`, `EMBEDDING_MODEL`

Gate/integrity tuning:

- `MATRIYA_PRE_LLM_MIN_SIMILARITY`
- `MATRIYA_PRE_LLM_MIN_CHUNKS`
- `MATRIYA_RETRIEVAL_SIMILARITY_THRESHOLD`
- `MATRIYA_MAX_ATTRIBUTION_SOURCES`
- `MATRIYA_DOMAIN_MIN_QUERY_OVERLAP`
- `MATRIYA_GENERATION_MIN_CHUNKS`
- `MATRIYA_GENERATION_MIN_TOPK_SIMILARITY_SUM`
- `MATRIYA_GENERATION_TOPK_SUM_K`
- `B_INTEGRITY_MAX_GROWTH_RATIO`
- `B_INTEGRITY_NO_PROGRESS_CYCLES`
- `B_INTEGRITY_METRIC_CAP`
- `B_INTEGRITY_MAX_DROP_PERCENT`

Integration:

- `MATRIYA_MANAGEMENT_API_URL`
- `MATRIYA_MANAGEMENT_MATERIALS_KEY`
- `MANAGEMENT_BACK_URL`
- `MATRIYA_MANAGEMENT_BACK_URL`
- `MATRIYA_INTERNAL_BASE_URL`

### `managment-back` (key groups)

Core:

- `PORT`, `NODE_ENV`, `PUBLIC_API_BASE_URL`

Data:

- `SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`

Integration:

- `MATRIYA_BACK_URL`
- `MANEGER_MATERIALS_SUMMARY_SERVER_KEY`

OpenAI/GPT RAG:

- `OPENAI_API_KEY`
- `OPENAI_RAG_MODEL`
- `MANEGER_GPT_RAG_WAIT_FOR_INDEXING`
- `MANEGER_GPT_RAG_BATCH_POLL_MAX`
- `MANEGER_GPT_SNIPPET_INDEX_FILTER`
- `GPT_RAG_AUTO_SYNC_DEBOUNCE_MS`

Infra:

- `CORS_ORIGINS`, `CORS_ALLOW_VERCEL_PREVIEWS`
- `AUTH_LOGIN_RATE_LIMIT_MAX`, `DISABLE_AUTH_RATE_LIMIT`
- `UPLOAD_RATE_LIMIT_MAX`, `API_RATE_LIMIT_MAX`

Email/SharePoint:

- `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `RESEND_INBOUND_WEBHOOK_SECRET`, `RESEND_REPLY_DOMAIN`
- `SHAREPOINT_TENANT_ID`, `SHAREPOINT_CLIENT_ID`, `SHAREPOINT_CLIENT_SECRET`

---

## API Surface

Canonical route sources:

- `matriya-back/server.js`
- `matriya-back/authEndpoints.js`
- `matriya-back/adminEndpoints.js`
- `managment-back/server.js`
- `managment-front/src/api.js` (consumer contract)

### MATRIYA API (major groups)

- Auth: `/auth/*`
- Admin: `/admin/*`
- Ingest/files: `/ingest/*`, `/files*`, `/documents`, `/reset`
- Ask/research: `/ask-matriya`, `/api/research/*`, `/research/*`
- Audit/observability: `/api/audit/*`, `/api/observability/*`
- GPT RAG: `/gpt-rag/*`, `/collection/info`
- External layer: `/api/external/*`

### Management API (major groups)

- Auth proxy: `/api/auth/*`
- Projects + members + requests: `/api/projects*`
- Chat: `/api/projects/:id/chat*`
- Email: `/api/projects/:id/emails*`, `/api/webhooks/resend-inbound`
- Tasks/milestones/documents/notes/audit
- Runs and trace
- Materials + Matriya bridge
- Import/experiments/lab analysis
- Files, SharePoint, and bucket upload workflows

For full endpoint list, keep this file synchronized with route declarations in both `server.js` files.

---

## Common Payloads

Auth:

- Login: `{ "username": "string", "password": "string" }`
- Signup: `{ "username": "string", "email": "string", "password": "string", "full_name": "string?" }`

Membership:

- Add member: `{ "username": "string" }`

Chat:

- Send: `{ "body": "string" }`
- Mark read: `{ "read_through": "ISO timestamp?" }`

Files:

- Upload: multipart `file` (+ optional metadata)
- Register ingest: `{ "paths": ["bucket/path/file.ext"] }`
- Import from bucket: `{ "path": "string", "displayName": "string?" }`

Lab:

- Compare percentages: A/B formulation payload
- Parse experiment file: multipart `file`
- Formula intelligence/validation: JSON domain payload

---

## Auth and Security

- JWT bearer authentication across clients.
- `managment-back` proxies auth to MATRIYA auth endpoints.
- Clients clear local token on unauthorized responses.
- Management API applies rate limits for auth, upload, and general routes.
- CORS policy is env-driven and supports local + Vercel patterns.

---

## Operations and Safety Rules

1. Maintain cross-service contract compatibility.
2. Do not hardcode production URLs.
3. Keep external data contextual unless policy explicitly allows evidence usage.
4. Preserve gate/integrity semantics in research conclusions.
5. Before handoff, run:
   - frontend build
   - one auth smoke test
   - one file ingest/retrieval flow
   - one research/lab path

---

## Troubleshooting

### CORS problems

- Verify frontend base URL env values.
- Ensure origin exists in `CORS_ORIGINS` or Vercel preview mode is enabled.

### Auth loops / 401

- Check `MATRIYA_BACK_URL` in `managment-back`.
- Validate `/auth/me` on MATRIYA API.
- Confirm browser token key and interceptor behavior.

### Upload 413 / timeouts

- Use direct-to-bucket flow when available.
- Check upload rate limit and size constraints.
- Avoid increasing limits globally without risk review.

### GPT RAG empty answers

- Verify OpenAI env keys and vector sync status.
- Re-run sync endpoint.
- Confirm files are registered and supported by parser/indexing flow.

---

## Starter `.env` Templates

### `matriya-back/.env`

```env
API_PORT=8000
NODE_ENV=development
JWT_SECRET=replace_with_strong_secret

POSTGRES_URL=postgresql://...
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...

OPENAI_API_KEY=...
OPENAI_API_BASE=https://api.openai.com/v1
OPENAI_RAG_MODEL=gpt-4o-mini

MATRIYA_MANAGEMENT_API_URL=http://localhost:8001
```

### `managment-back/.env`

```env
PORT=8001
NODE_ENV=development

SUPABASE_URL=https://<project>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...

MATRIYA_BACK_URL=http://localhost:8000

OPENAI_API_KEY=...
OPENAI_RAG_MODEL=gpt-4o-mini
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
VITE_SUPABASE_URL=https://<project>.supabase.co
VITE_SUPABASE_ANON_KEY=...
```

---

## Maintenance Notes

- Keep this file synchronized with backend route declarations and env usage.
- If conflicts occur between this document and code, code is source of truth.

