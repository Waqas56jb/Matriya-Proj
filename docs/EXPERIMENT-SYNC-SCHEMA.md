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
| `is_production_formula` | boolean | כן | סימון פורמולציית ייצור (פקעות שעובדות) |
| `source_file_reference` | string | לא | הפניה למסמך המקורי ב-SharePoint |
| `experiment_version` | string | לא | גרסת הניסוי (למעקב עדכונים לאורך זמן) |
| `experiment_batch_id` | number | לא | קישור לסדרת ניסויים (research session) |

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

## 4. Import מקבצי SharePoint

**Endpoint:** `POST /import/sharepoint-file`

מקבל קובץ מקור (path) ורשימת ניסויים, מעדכן את טבלת הניסויים ורושם כל רשומה ל-**Import Log**.

### Request body (JSON)

```json
{
  "source_file": "SharePoint path or file name",
  "source_type": "sharepoint",
  "experiments": [ /* same schema as sync/experiments */ ],
  "experiment_batch_id": 1
}
```

### Response

- `synced`, `errors`, `source_file` – כמו ב-sync; בנוסף כל ניסוי שנוצר/עודכן נרשם ב-import_log.

---

## 5. Sync Validation

ב-`/sync/experiments` ו-`/import/sharepoint-file` נדרשים תמיד: `technology_domain`, `experiment_outcome`, `is_production_formula`. השדות `materials` ו-`percentages` נשמרים אם נשלחו (אחרת null).

---

## 6. Import Log

טבלה `import_log`: שומרת מאיזה קובץ הגיע הדאטה ומה נוצר או עודכן.

- `source_file` – קובץ מקור (למשל path ב-SharePoint)
- `source_type` – סוג (sharepoint, lab_system)
- `created_entity_type` – experiment / experiment_batch
- `created_entity_id` – מזהה הישות
- `status` – success / failure / partial
- `details` – JSON נוסף

**Endpoint:** `GET /api/import-log?limit=50&offset=0` – רשימת רשומות אחרונות.

---

## 7. סדרות ניסויים (Research Sessions / Batches)

טבלה `experiment_batches`: קיבוץ ניסויים לאותה סדרת ניסויים מחקרית.

- **GET /api/experiment-batches** – רשימת סדרות
- **POST /api/experiment-batches** – יצירת סדרה `{ name?, description? }`
- בשדה `experiment_batch_id` בניסוי (ב-sync או import) מקשרים ניסוי לסדרה.

---

## 8. Material Library (ספריית חומרים)

טבלה `material_library`: חומרי גלם מרכזיים – מאפשרת ל-analysis להבין תפקידים (role) של חומרים בפורמולציות.

- **GET /api/materials** – רשימת חומרים
- **POST /api/materials** – הוספת חומר `{ name, role?, description? }`
- **POST /analysis/formula** – כשנשלחים `materials`, התשובה כוללת `materials_info` (name, role, description) מהספרייה.

---

## 9. Endpoints ב-MATRIYA (סיכום)

| Method | Path | תיאור |
|--------|------|--------|
| POST | `/analysis/formula` | ניתוח פורמולציה; מחזיר similar_experiments + materials_info |
| POST | `/sync/experiments` | סנכרון ניסויים (validation לשדות חובה) |
| POST | `/import/sharepoint-file` | import מקבץ + רישום ב-import_log |
| GET | `/api/import-log` | רשימת רשומות import |
| GET/POST | `/api/experiment-batches` | סדרות ניסויים |
| GET/POST | `/api/materials` | ספריית חומרים |
