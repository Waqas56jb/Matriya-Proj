# שלב 1 – סגור לפי Checklist

**מטרה:** מערכת שאי אפשר לעבוד איתה לא נכון. אי אפשר לקבל תשובה כשאסור לקבל תשובה.

---

## 1. Research Session כיישות אמיתית

- **יצירה ושמירה של session_id:** `POST /research/session` יוצר session ומחזיר `session_id`.
- **כל שאלה מחויבת ב־session_id + stage:** ב־`GET /search` עם `generate_answer=true` נדרשים `session_id` ו־`stage`. חסר → 400.
- **ללא Session תקף → אין טיפול:** אם `session_id` חסר או לא קיים ב-DB → 400, לא נוצרת session אוטומטית בבקשה.

---

## 2. FSCTM Gate לפני כל קריאה ל-LLM

- **K/C:** מותר רק מידע קיים; תשובה עוברת הסרת הצעות (`stripSuggestions`). אין פתרונות/רעיונות.
- **B:** Hard Stop מוחלט – לא מפעיל LLM, מחזיר תגובה קבועה בלבד.
- **N:** מותר רק אם קיים B קודם באותו session (FSM).
- **L:** מותר רק אם קיים N קודם באותו session (FSM).
- **אם התנאים לא מתקיימים:** שגיאה ברורה (400) עם הודעת מעבר שלבים.

---

## 3. Hard Stop במצב B

- בשלב B מוחזרת תגובה קבועה (JSON ברור), ללא קריאה ל-LLM.
- אין ניסוח יצירתי ואין "עזרה" – גם על "אז מה כן?" המערכת עוצרת עם אותו Hard Stop.

---

## 4. אכיפת מעברי שלבים (FSM)

- מותרים רק: **K → C → B → N → L** (כולל חזרה על שלב שכבר בוצע).
- דילוג (למשל K→B או C→N): נחסם, מוחזרת הודעת שגיאה ברורה.

---

## 5. Audit Log

- לכל שאלה נרשם: `session_id`, `stage`, `timestamp`, `response_type`.
- `response_type`: `info_only` / `hard_stop` / `full_answer` / `blocked`.
- טבלה: `research_audit_log`. ייצוא: `GET /research/session/:id`.

---

## 6. דוגמת Session (K → C → B)

לאחר ביצוע שאלה אחת ב-K, אחת ב-C ואחת ב-B באותו session, ייצוא `GET /research/session/:id` יכול להחזיר:

```json
{
  "session_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "completed_stages": ["K", "C", "B"],
  "created_at": "2025-02-06T12:00:00.000Z",
  "audit_log": [
    { "stage": "K", "response_type": "info_only", "request_query": "מה כתוב במסמך?", "created_at": "2025-02-06T12:00:01.000Z" },
    { "stage": "C", "response_type": "info_only", "request_query": "איזה נתונים יש?", "created_at": "2025-02-06T12:00:10.000Z" },
    { "stage": "B", "response_type": "hard_stop", "request_query": "אז מה כן?", "created_at": "2025-02-06T12:00:20.000Z" }
  ]
}
```

---

**שלב 1 סגור לפי Checklist.**  
בלי MOP, בלי סוכנים, בלי הרחבות בשלב הזה.
