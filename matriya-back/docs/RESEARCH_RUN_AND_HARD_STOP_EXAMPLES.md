# דוגמאות תשובות API – Research Run ו־Hard Stop (Violation)

## 1. דוגמת JSON אמיתית מ־POST /api/research/run

**בקשה:**
```http
POST /api/research/run
Content-Type: application/json

{
  "session_id": "<uuid-from-POST-/research/session>",
  "query": "מהי ההשפעה של X על Y?",
  "use_4_agents": true
}
```

**תשובה מוצלחת (200):**
```json
{
  "run_id": 1,
  "outputs": {
    "analysis": "השאלה בודקת קשר סיבתי בין X ל-Y. יש לבחון מחקרים אמפיריים.",
    "research": "במסמכים נמצא כי X משפיע על Y בתנאים מסוימים. הממצאים מראים מתאם חיובי.",
    "critic": "חשוב להבחין בין מתאם לסיבתיות. חלק מהמקורות אינם עדכניים.",
    "synthesis": "לסיכום: קיימת עדות להשפעה של X על Y, עם צורך במחקר נוסף להבחנה סיבתית."
  },
  "justifications": [
    {
      "agent": "research",
      "reason": "output_changed",
      "label": "שינוי בפלט",
      "description": "הפלט השתנה ביחס לשלב הקודם.",
      "previous_snippet": "השאלה בודקת קשר סיבתי...",
      "created_at": "2026-02-18T12:00:00.000Z"
    }
  ]
}
```

**שדות:**
- `run_id` – מזהה הריצה (או null אם שמירת הריצה נכשלה).
- `outputs` – פלט כל אגנט: `analysis`, `research`, `critic`, `synthesis`.
- `justifications` – מערך הצדקות (למשל כשהפלט משתנה בין אגנטים).

**תשובת שגיאה (500):**
```json
{
  "error": "Agent research failed: LLM not available",
  "outputs": { "analysis": "..." },
  "justifications": []
}
```

---

## 2. הוכחה ש־Hard Stop (Violation) עובד

כשיש **הפרת B-Integrity פעילה** לסשן, השער ננעל. קריאה ל־**GET /search** עם `session_id` + `stage` מחזירה תשובת Hard Stop (אין תשובה חכמה, רק הודעת נעילה).

**בקשה (לאחר שיש violation פעיל לסשן):**
```http
GET /search?query=test&session_id=<session-with-active-violation>&stage=K
```

**תשובה (400) – Hard Stop בגלל violation:**
```json
{
  "error": "Session locked due to B-Integrity violation (growth). Use Recovery API to resolve.",
  "research_stage_error": true,
  "research_gate_locked": true,
  "violation_id": 42
}
```

**הסבר:**
- `research_gate_locked: true` – השער נעול בגלל violation.
- `violation_id` – מזהה ההפרה; ניתן לשחרר דרך `PATCH /admin/recovery/violations/:id` (resolve).
- `error` – מסביר שהסשן נעול ומפנה ל־Recovery API.

**איך ליצור violation (לצורכי בדיקה):**
- הפעלת כללי Integrity (למשל כללי growth/decrease) שיוצרים violation דרך `integrityMonitor` + `integrityRulesEngine`.
- לאחר שנוצרת violation לסשן, כל קריאת `/search` עם אותו `session_id` תחזיר את התשובה למעלה עד ל־resolve ב־Recovery API.

**שחרור הנעילה:**
```http
PATCH /admin/recovery/violations/42
Authorization: Bearer <admin-token>
Content-Type: application/json

{ "resolve_note": "טופל ידנית" }
```

לאחר resolve, קריאות `/search` עם אותו `session_id` ימשיכו כרגיל (בלי Hard Stop).
