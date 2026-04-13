# Gate Evidence – Scope Production (הוכחות מערכתיות)

מסמך זה מספק **outputs אמיתיים** (קוד, schema, פקודות, תוצאות) לסגירת הסקופ לפני הפעלה מבצעית של SharePoint.

---

## 🔴 A. Hardening (Scope 1)

### A1. Idempotency — הערה: במערכת הנוכחית משתמשים ב־session_id

**מה קיים בפועל:**

- אין טבלה בשם `processed_decisions` ואין עמודה `trigger_id` ב־matriya-back.
- החלטות Gate נשמרות ב־**`decision_audit_log`** (מפתח: `session_id` + `created_at`).
- Idempotency מובנית:
  - **Research run:** נעילה לפי session – רק ריצה אחת בו־זמנית לכל `session_id` (ראה A2).
  - **RAG:** כתיבה אידמפוטנטית (מחיקה לפי filename לפני הוספה) – `ragService.js`.

**טבלה רלוונטית:** `decision_audit_log` (אין UNIQUE על trigger_id כי אין trigger_id).

**פקודת psql להרצה (לאחר חיבור ל־DB):**

```bash
psql "<connection_string>" -c "\d decision_audit_log"
```

**Output סכמה מהקובץ (supabase_setup_complete.sql):**

```
CREATE TABLE IF NOT EXISTS decision_audit_log (
    id SERIAL PRIMARY KEY,
    session_id UUID NOT NULL REFERENCES research_sessions(id) ON DELETE CASCADE,
    stage VARCHAR(10) NOT NULL,
    decision VARCHAR(20) NOT NULL,
    response_type VARCHAR(50),
    request_query TEXT,
    inputs_snapshot JSONB,
    details JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
-- + Kernel Amendment: confidence_score, basis_count, model_version_hash, complexity_context, human_feedback
```

**curl – דוגמאות לפי הממשק הקיים (session_id):**

```bash
# יצירת session חדש → 200 + session_id
curl -s -X POST http://localhost:8000/research/session -H "Content-Type: application/json" -d "{}"

# חיפוש בלי session_id עם generate_answer=true → 400 (session_id required)
curl -s "http://localhost:8000/search?query=test&stage=K&generate_answer=true" 
# Expected: 400, "session_id is required ..."

# stage חסר או לא חוקי → 400
curl -s "http://localhost:8000/search?query=test&session_id=<valid-uuid>&generate_answer=true"
# (בלי stage) Expected: 400, "stage is required and must be one of: K, C, B, N, L"
```

---

### A2. Parallel lock — researchRunLocks

**קוד (קובץ + שורה):**

- **server.js** שורות 198, 621–626:

```javascript
// Line 198
const researchRunLocks = new Map();

// Lines 621–626 (inside POST /api/research/run when use_4_agents)
const prev = researchRunLocks.get(sessionId) || Promise.resolve();
const runPromise = prev
  .then(() => runLoop(sessionId, query.trim(), getRagService(), filterMetadata, runOptions))
  .finally(() => { if (researchRunLocks.get(sessionId) === runPromise) researchRunLocks.delete(sessionId); });
researchRunLocks.set(sessionId, runPromise);
const result = await runPromise;
```

**curl/test – שתי קריאות מקבילות לאותו session_id:**

```bash
# 1) צור session
SID=$(curl -s -X POST http://localhost:8000/research/session -H "Content-Type: application/json" -d "{}" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).session_id")

# 2) הרץ שני research runs במקביל – שתיהן מסתיימות, אחת אחרי השנייה (serialized)
curl -s -X POST http://localhost:8000/api/research/run -H "Content-Type: application/json" -d "{\"session_id\":\"$SID\",\"query\":\"parallel test\",\"use_4_agents\":true}" &
curl -s -X POST http://localhost:8000/api/research/run -H "Content-Type: application/json" -d "{\"session_id\":\"$SID\",\"query\":\"parallel test 2\",\"use_4_agents\":true}" &
wait
# Expected: שני ה-responses עם run_id/outputs; הריצות מסתנכרנות ב־lock.
```

---

### A3. Gate enforcement

**מעבר שלב ללא gate / stage לא חוקי → 400 + הודעה ברורה.**

**איפה נאכף:**  
- **researchGate.js:** `validateAndAdvance()` (שורות 94–120 בערך) – בודק session, stage מותר, violation.  
- **server.js:** שורות 406–442 – קורא ל־`validateAndAdvance`; אם `!gate.ok` מחזיר 400 עם `error` ו־`research_stage_error: true`.

**קוד (server.js 412–442):**

```javascript
if (!stage || !['K', 'C', 'B', 'N', 'L'].includes(stage)) {
  return res.status(400).json({
    error: "stage is required and must be one of: K, C, B, N, L",
    research_stage_required: true
  });
}
// ...
gate = await validateAndAdvance(sessionId, stage, userId);
// ...
if (!gate.ok) {
  await logDecisionAudit(...);
  return res.status(400).json({
    error: gate.error,
    research_stage_error: true,
    ...
  });
}
```

**curl – שלב לא מותר (למשל דילוג מ־K ל־B):**

```bash
# צור session, בצע חיפוש ב־K, ואז נסה שלב B בלי C → 400
SID=$(curl -s -X POST http://localhost:8000/research/session -H "Content-Type: application/json" -d "{}" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).session_id")
curl -s "http://localhost:8000/search?query=test&session_id=$SID&stage=B&generate_answer=true&n_results=2"
# Expected: 400, error כמו "stage is required and must be one of..." או הודעת gate (next allowed)
```

(המערכת מחזירה **400** כשהשלב לא מותר; לא 422.)

---

### A4. stateMachine.js

**מצב:** **לא מסומן כ־deprecated** בקוד הנוכחי. אין commit שמסמן אותו כ־deprecated.

**grep – איפה נקרא:**

```bash
cd c:\projects\matriya\matriya-back
rg "stateMachine|stateMachine\.js" --type-add 'src:*.js' -t src .
# או:
grep -Rn "stateMachine" --include="*.js" . | grep -v node_modules
```

**Output (מהפרויקט):**

```
server.js:15:import { StateMachine, Kernel } from './stateMachine.js';
stateMachine.js:89:  constructor(ragService, stateMachine) {
stateMachine.js:91:    this.stateMachine = stateMachine;
...
```

**מסקנה:** `stateMachine.js` עדיין בשימוש ב־server.js (שורה 15) וב־Kernel; לא קיים סימון deprecated ב־commit history שנבדק.

---

### A5. Staging proof — GET /research/staging-proof

**curl + output מלא (דוגמה):**

```bash
# עם session_id תקף (החלף <SESSION_ID> ב־UUID אמיתי)
curl -s "http://localhost:8000/research/staging-proof?session_id=<SESSION_ID>"
```

**דוגמת JSON (מהקוד):**

```json
{
  "session_id": "<uuid>",
  "current_stage": "K",
  "completed_stages": ["K"],
  "next_allowed": "C",
  "gate_locked": false,
  "violation_id": null,
  "last_snapshot_cycle_index": 0
}
```

**מה בודק:**  
- **קובץ:** server.js שורות 728–759.  
- **לוגיקה:** טוען session לפי `session_id`, מחשב `next_allowed` מ־`researchGate.getNextAllowedStage(completed_stages)`, בודק אם יש violation פעיל (`getActiveViolation`) → `gate_locked`, ואם יש IntegrityCycleSnapshot – מחזיר `last_snapshot_cycle_index`.

---

### A6. Transaction integrity

**מצב:**  
- **decision_audit_log:** נכתב ב־`logDecisionAudit()` כ־**create בודד** (server.js 140–159). כישלון רק נרשם ב־log, לא מעיף exception.  
- **Delta (RAG):** מתבצע ב־ragService (מחיקה לפי filename ואז הוספה) – לא באותו transaction עם ה־DB של Supabase.  
- **אין transaction אחד** שמאחד decision + delta + audit ב־DB אחד; ה־audit הוא רשומה נפרדת.  
- אם רוצים להראות "אם אחד נכשל – הכל מתבטל": כרגע כישלון ב־DecisionAuditLog.create רק נרשם ב־logger ולא מבטל את שאר הזרימה.

**קוד (server.js 140–159):**

```javascript
async function logDecisionAudit(sessionId, stage, decision, responseType, requestQuery, inputsSnapshot, details = null, opts = {}) {
  if (!DecisionAuditLog) return;
  const gateCtx = getGateObservabilityContext();
  try {
    await DecisionAuditLog.create({
      session_id: sessionId,
      stage,
      decision,
      response_type: responseType || null,
      request_query: requestQuery != null ? String(requestQuery).slice(0, 4000) : null,
      inputs_snapshot: inputsSnapshot || null,
      details: details || null,
      confidence_score: opts.confidence_score != null ? opts.confidence_score : gateCtx.confidence_score,
      basis_count: opts.basis_count != null ? opts.basis_count : gateCtx.basis_count,
      model_version_hash: opts.model_version_hash || gateCtx.model_version_hash,
      complexity_context: opts.complexity_context || null
    });
  } catch (e) {
    logger.warn(`Decision audit log failed: ${e.message}`);
  }
}
```

---

## 🟠 B. Audit Trail (Scope 2)

### B1. decision_audit_log — schema

**הרצה ב־psql:**

```bash
psql "<connection_string>" -c "\d decision_audit_log"
```

**הסכמה בפועל (מהקבצים):**

- עמודות מקור: `id`, `session_id`, `stage`, `decision`, `response_type`, `request_query`, `inputs_snapshot` (JSONB), `details` (JSONB), `created_at`.
- תוספות Kernel Amendment v1.2: `confidence_score`, `basis_count`, `model_version_hash`, `complexity_context`, `human_feedback`.

**הערה:** אין `trigger_id`, `input_snapshot` (יש `inputs_snapshot`), אין `fsm_state_at_decision`, `active_laws`, `gate_result`, `engine_version_hash` – יש `stage`, `decision`, `model_version_hash`.

---

### B2. Auto-creation + GET audit לפי session

**צעדים:**

1. צור session ו־decision (חיפוש עם stage ו־generate_answer).
2. GET audit לפי session_id.

```bash
# 1) צור session
SID=$(curl -s -X POST http://localhost:8000/research/session -H "Content-Type: application/json" -d "{}" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).session_id")

# 2) צור decision (חיפוש עם stage)
curl -s "http://localhost:8000/search?query=test&session_id=$SID&stage=K&generate_answer=true&n_results=2"

# 3) GET decisions לפי session
curl -s "http://localhost:8000/api/audit/session/$SID/decisions"
# Expected: { "session_id": "<uuid>", "decisions": [ ... ] } עם רשומה עם inputs_snapshot, model_version_hash, confidence_score
```

---

### B3. Replay

**ה־endpoint:** `GET /api/audit/session/:sessionId/decisions` (לא `/audit/replay/:trigger_id`).

**curl + דוגמת output:**

```bash
curl -s "http://localhost:8000/api/audit/session/<SESSION_ID>/decisions"
```

**דוגמת JSON:**

```json
{
  "session_id": "<uuid>",
  "decisions": [
    {
      "id": 1,
      "session_id": "<uuid>",
      "stage": "K",
      "decision": "allow",
      "response_type": "info_only",
      "request_query": "test",
      "inputs_snapshot": { "session_id": "...", "stage": "K" },
      "details": null,
      "confidence_score": "1.0000",
      "basis_count": 2,
      "model_version_hash": "...",
      "complexity_context": { "document_count": 0, "session_depth": 0 },
      "created_at": "..."
    }
  ]
}
```

---

### B4. Read-only — אין POST/PUT/DELETE על audit

**Routes רלוונטיים (מגrep):**

```
app.get("/api/audit/decisions", ...)           → server.js ~762
app.get("/api/audit/session/:sessionId/decisions", ...) → server.js ~779
```

אין ב־server.js: `app.post("/api/audit/...")`, `app.put("/api/audit/...")`, `app.delete("/api/audit/...")`.

---

## 🟡 C. Observability (Scope 3)

### C1. Health endpoint

**curl:**

```bash
curl -s http://localhost:8000/health
```

**דוגמת output:**

```json
{
  "status": "healthy",
  "vector_db": { "document_count": 0, ... },
  "metrics": {
    "total_requests": 42,
    "total_errors": 0,
    "latency_p50_ms": 12,
    "latency_p99_ms": 89
  }
}
```

**מה בודק:** **Vector DB בלבד** (דרך `getRagService().getCollectionInfo()`). לא בודק Supabase ישירות.  
**מצב degraded:** אם ה־health נכשל (exception) – מחזיר **500** עם `status: "unhealthy"` ו־`error`. אין ערך נפרד `status: "degraded"`; כישלון = unhealthy.

**קוד (server.js 214–234):**

```javascript
app.get("/health", async (req, res) => {
  try {
    const info = await getRagService().getCollectionInfo();
    const metrics = getMetrics();
    return res.json({ status: "healthy", vector_db: info, metrics: { ... } });
  } catch (e) {
    return res.status(500).json({ status: "unhealthy", error: e.message });
  }
});
```

---

### C2. Metrics / Dashboard

**curl:**

```bash
curl -s http://localhost:8000/api/observability/dashboard
```

**פורמט:** **JSON** (לא Prometheus).  
**עדכון:** latency / request count / error rate מתעדכנים בזמן אמת (in-memory ב־metrics.js).

**דוגמת output:**

```json
{
  "total_requests": 100,
  "latency_p50": 15,
  "latency_p99": 120,
  "error_count": 0,
  "by_path": { "/search": { "requests": 50, "errors": 0, "latency_p50": 20, "latency_p99": 95 }, ... },
  "false_b_rate": null,
  "missed_b_rate": null,
  ...
}
```

---

### C3. metricsMiddleware

**קובץ + שורות:** metrics.js, שורות 58–67.

```javascript
export function metricsMiddleware(req, res, next) {
  const start = Date.now();
  const path = (req.route && req.route.path) ? req.baseUrl + req.route.path : req.path || req.url?.split('?')[0] || '/';
  res.on('finish', () => {
    const latencyMs = Date.now() - start;
    const isError = res.statusCode >= 400;
    recordRequest(path, latencyMs, isError);
  });
  next();
}
```

**מה מודד:** לכל request – path, latency (ms), וסימון error אם statusCode >= 400; מצטבר ב־byPath (requests, errors, latencies) ומשמש ל־getMetrics() (total_requests, latency_p50/p99, error_count).

---

## 🔵 D. שאלות פתוחות

### D1. enforcement_overridden ב־research_sessions

**כן, קיימת.**  
מ־supabase_setup_complete.sql שורות 77–85:

```sql
CREATE TABLE IF NOT EXISTS research_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id INTEGER,
    completed_stages TEXT[] DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    enforcement_overridden BOOLEAN NOT NULL DEFAULT FALSE
);
```

**פקודה:**

```bash
psql "<connection_string>" -c "\d research_sessions"
```

---

### D2. Phase 1 tables

ב־matriya-back (supabase_setup_complete.sql וקבצי הקוד) **אין** טבלאות:

- `b_events`
- `laws`
- `delta_trigger_log`
- `processed_decisions`

**מסקנה:** **לא קיימות** בסכמה הנוכחית.

---

### D3. Commit history (matriya-back)

**פקודה:**

```bash
cd c:\projects\matriya\matriya-back
git log --oneline -10
```

**Output (דוגמה):**

```
f2f2302 Observability dashboard: add total_requests, latency_p50, latency_p99, error_count
5794c92 Kernel Amendment v1.2: observability dashboard, SEM, gates, noise, DB init non-fatal, test script
40f0c69 Scopes 1-2-3: hardening, audit trail, observability, test script
9a9ef13 Research loop: add source file names to RAG context prompt
cb8a40a Auth: return 503 when DB init fails instead of 500
200a071 RAG: filter by project filenames when asking over all files; add check-vector-files script
17d13b1 Update researchLoop.js
718a0a9 Updates to server, auth, research, config and schema
4a2d90a Fix xlsx ingestion (createRequire), add proposal-milestones-david.txt
2ef1eb9 Kernel lock: gate on research/run, duration_ms, proof script, value-summary duration
```

---

## 📌 סיכום

- **A:** Idempotency מבוססת session_id ו־research run lock; gate נאכף ב־researchGate.js + server.js (400); staging-proof ב־server.js; stateMachine לא deprecated; transaction – audit הוא create בודד, אין transaction משותף עם delta.
- **B:** decision_audit_log עם הסכמה למעלה; יצירה אוטומטית + GET לפי session; replay = GET /api/audit/session/:sessionId/decisions; audit read-only (רק GET).
- **C:** Health בודק vector DB, JSON; dashboard JSON, מתעדכן בזמן אמת; metricsMiddleware ב־metrics.js.
- **D:** enforcement_overridden קיים; b_events, laws, delta_trigger_log, processed_decisions לא קיימות; git log למעלה.

**להרצת כל ה־curl וה־psql:** וודא ש־matriya-back רץ על פורט 8000 וחיבור ל־Supabase תקין.

**הרצת כל ה־checks בפעם אחת (תוצאת terminal):**

```bash
cd matriya-back
node scripts/run-gate-evidence-curls.js
# או שמירה לקובץ:
node scripts/run-gate-evidence-curls.js > gate-evidence-output.txt
```
