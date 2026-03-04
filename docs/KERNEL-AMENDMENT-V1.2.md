# Kernel Amendment v1.2 – Epistemic Integrity Layer (Scope 3)

חובה כחלק מהיישום. התאמות ל־Observability במסגרת Scope 3.

---

## 1. Metrics Dashboard

**Endpoint:** `GET /api/observability/dashboard`

דיווח כולל:
- **False B rate** – שיעור החלטות שסומנו כ־`human_feedback: 'false_b'` (חוסם B שגוי)
- **Missed B rate** – שיעור החלטות שסומנו כ־`human_feedback: 'missed_b'` (החמצת B)
- **Confidence distribution** – התפלגות `confidence_score` ל־Gate ול־stage B (min, max, mean, samples)
- **Complexity context** – דוגמת הקשר מורכבות (document_count, session_depth) שבו נמדד המדד

סימון False B / Missed B: `PATCH /api/observability/decision/:id/feedback` עם `{ "human_feedback": "false_b" }` או `"missed_b"`.

---

## 2. SEM Output

**Endpoint:** `GET /api/observability/sem`

SEM לא מוצג כערך יחיד. התשובה כוללת:
- **component_breakdown** – פירוט רכיבים (gate_checks, with_confidence, by_stage)
- **confidence_range** – טווח confidence (min, max, p50, p99)
- **historical_predictive_accuracy** – מדידת דיוק היסטורי (labeled_count, total, accuracy_note)

---

## 3. Gate Observability

כל Gate שנרשם ב־`decision_audit_log` כולל:
- **confidence_score** – ציון ביטחון (ברירת מחדל 1.0 לשער דטרמיניסטי)
- **basis_count** – מספר בסיסי החלטה (ברירת מחדל 2: בדיקת violation + סדר שלב)
- **model_version_hash** – גרסת Gate (hash של גרסה + סדר שלבים)

**Endpoint:** `GET /api/observability/gates?limit=&offset=` – רשימת החלטות Gate עם השדות לעיל + complexity_context.

---

## 4. Noise Tracking

תשתית לניטור אירועים שסווגו כרעש, לשם re-evaluation אוטומטי לאחר עדכון Kernel.

- **טבלה:** `noise_events` (session_id, decision_id, event_type, kernel_version_at_classification, re_evaluate_after_kernel_version)
- **GET /api/observability/noise** – רשימת אירועי רעש
- **POST /api/observability/noise** – רישום אירוע כרעש (body: session_id, decision_id?, event_type?, re_evaluate_after_kernel_version?)

---

## SQL להרצה ב־DB (אם הטבלאות כבר קיימות)

```sql
ALTER TABLE decision_audit_log ADD COLUMN IF NOT EXISTS confidence_score NUMERIC(5,4);
ALTER TABLE decision_audit_log ADD COLUMN IF NOT EXISTS basis_count INTEGER;
ALTER TABLE decision_audit_log ADD COLUMN IF NOT EXISTS model_version_hash VARCHAR(64);
ALTER TABLE decision_audit_log ADD COLUMN IF NOT EXISTS complexity_context JSONB;
ALTER TABLE decision_audit_log ADD COLUMN IF NOT EXISTS human_feedback VARCHAR(20);

CREATE TABLE IF NOT EXISTS noise_events (
    id SERIAL PRIMARY KEY,
    session_id UUID NOT NULL REFERENCES research_sessions(id) ON DELETE CASCADE,
    decision_id INTEGER REFERENCES decision_audit_log(id) ON DELETE SET NULL,
    event_type VARCHAR(50) NOT NULL DEFAULT 'gate_decision',
    kernel_version_at_classification VARCHAR(64),
    re_evaluate_after_kernel_version VARCHAR(64),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS noise_events_session_id_idx ON noise_events(session_id);
CREATE INDEX IF NOT EXISTS noise_events_decision_id_idx ON noise_events(decision_id);
CREATE INDEX IF NOT EXISTS noise_events_created_at_idx ON noise_events(created_at DESC);
```
