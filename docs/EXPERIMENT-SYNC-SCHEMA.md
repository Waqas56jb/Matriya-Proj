# סכמה אחידה לניסויים – מערכת המעבדה ↔ MATRIYA

מסמך זה מגדיר את החוזה בין מערכת המעבדה (מנהל ניסויים) ל-MATRIYA כשהתקשורת מתבצעת דרך API ו-DB נפרדים.

## 1. שדות ניסוי (כשמעבירים ל-MATRIYA)

ה-API שמעביר ניסויים ל-MATRIYA (למשל `POST /sync/experiments`) צריך לכלול את השדות הבאים:

| שדה | סוג | חובה | תיאור |
|-----|-----|------|--------|
| `experiment_id` | string | כן | מזהה ייחודי של הניסוי במערכת המעבדה |
| `technology_domain` | string | כן | תחום טכנולוגי |
| `formula` | string | לא | פורמולציה (טקסט חופשי) |
| `materials` | array/object | לא | חומרים |
| `percentages` | array/object | לא | אחוזים |
| `results` | string/object | לא | תוצאות |
| `experiment_outcome` | string | כן | תוצאת הניסוי (ראה למטה) |
| `is_production_formula` | boolean | לא | סימון פורמולציית ייצור (פקעות שעובדות) |

### ערכי `experiment_outcome`

- `success` – ניסוי הצליח
- `failure` – ניסוי נכשל
- `partial` – הצלחה חלקית
- `production_formula` – פורמולציית ייצור (עובדת בפועל)

מטריאה יכולה ללמוד גם מניסויי פיתוח (success/failure/partial) וגם מפורמולציות ייצור (`is_production_formula: true` או `experiment_outcome: 'production_formula'`).

---

## 2. ניתוח פורמולציה לפני ניסוי

**Endpoint:** `POST /analysis/formula`

מערכת המעבדה שולחת פורמולציה לניתוח (למשל לפני הרצת ניסוי).

### Request body

```json
{
  "domain": "string",
  "materials": [],
  "percentages": {}
}
```

### Response

```json
{
  "status": "ok",
  "warnings": [],
  "similar_experiments": [
    {
      "experiment_id": "...",
      "technology_domain": "...",
      "formula": "...",
      "experiment_outcome": "success",
      "is_production_formula": true
    }
  ]
}
```

- `status` – סטטוס הניתוח (למשל `ok`, `warning`)
- `warnings` – רשימת אזהרות (מחרוזות)
- `similar_experiments` – ניסויים דומים מהמערכת (למטריאה ללמוד מהם)

---

## 3. סנכרון תקופתי של ניסויים

**Endpoint:** `POST /sync/experiments`

מערכת המעבדה שולחת snapshot של ניסויים כדי שמטריאה תוכל ללמוד מהם (פיתוח + פורמולציות ייצור).

### Request body

```json
{
  "experiments": [
    {
      "experiment_id": "uuid-or-string",
      "technology_domain": "...",
      "formula": "...",
      "materials": [],
      "percentages": {},
      "results": "...",
      "experiment_outcome": "success",
      "is_production_formula": false
    }
  ]
}
```

### Response

```json
{
  "synced": 10,
  "errors": []
}
```

- `synced` – מספר הניסויים שנשמרו/עודכנו
- `errors` – רשימת שגיאות (אם היו)

---

## 4. Endpoints ב-MATRIYA (סיכום)

| Method | Path | תיאור |
|--------|------|--------|
| POST | `/analysis/formula` | ניתוח פורמולציה לפני ניסוי; מחזיר אזהרות וניסויים דומים |
| POST | `/sync/experiments` | סנכרון snapshot ניסויים ללמידה |
