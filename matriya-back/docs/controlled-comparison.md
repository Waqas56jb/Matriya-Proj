# השוואה מבוקרת: עם Governance מול בלי

## מטרה
להריץ תרחיש אחד פעמיים – פעם עם Governance (שער B-Integrity פעיל) ופעם בלי – ולהשוות: זמן, יציבות, איכות פלט, סטיות שהתגלו.

## איך להשוות

### א. עם Governance (שער פעיל)
- זרימה: **GET /search** עם `session_id` + `stage` (K/C/B/N/L).
- השער בודק violation פעיל; אם יש – מחזיר **400** עם `research_gate_locked: true` (Hard Stop, בלי תשובה חכמה).
- מדידות: זמן תגובה, האם קיבלת 400, תוכן התשובה (הודעת נעילה בלבד).

### ב. בלי Governance (עקיפת השער)
- זרימה: **POST /api/research/run** עם אותו `session_id` ואותה `query`.
- **כרגע** ה-endpoint הזה **לא** בודק את השער – כלומר מריץ את לולאת 4 האגנטים גם כשיש violation.
- מדידות: זמן תגובה, האם הריצה הצליחה, פלט (outputs + justifications).

### תרחיש מוצע להרצה

1. **יצירת סשן**: POST /research/session → `session_id`.
2. **יצירת violation** (למשל דרך כללי Integrity או ידנית ב-DB) לאותו `session_id`.
3. **עם Governance**: GET /search?query=...&session_id=...&stage=K → צפוי **400**, זמן קצר, בלי תשובה.
4. **בלי Governance**: POST /api/research/run עם אותו `session_id` ו-`query` → צפוי **200**, זמן ארוך יותר (4 אגנטים), פלט מלא.
5. **שחרור**: PATCH /admin/recovery/violations/:id (resolve).
6. **שוב עם Governance**: GET /search עם אותו סשן → צפוי **200** ותשובה מלאה.

### טבלת השוואה (למלא)

| מדד           | עם Governance (שער נעול) | בלי Governance (/api/research/run) |
|---------------|---------------------------|-------------------------------------|
| זמן תגובה     | ___ ms                    | ___ ms                              |
| סטטוס HTTP    | 400                       | 200                                 |
| תשובה/פלט    | הודעת נעילה              | analysis, research, critic, synthesis |
| סטיות         | violation מזוהה, נעילה   | אין בדיקה – ריצה תמיד מתבצעת       |

### הבדל מדיד
- **זמן**: כשהשער נעול, /search מחזיר מהר (בלי קריאות LLM). בלי Governance הריצה תמיד מלאה → זמן גבוה יותר.
- **יציבות**: עם Governance – אין תשובה כשהמצב לא עקבי (violation). בלי – יש תשובה גם במצב לא עקבי.
- **איכות פלט**: עם Governance – במצב נעול אין פלט חכם. בלי – יש פלט תמיד (ללא קשר ל-Integrity).
- **סטיות**: עם Governance – הסטייה (violation) מתועדת ונעילה מונעת המשך. בלי – אין תיעוד ואין עצירה.

## הערה
אם תרצו "בלי Governance" גם ב-/search (אותו endpoint), נדרש מנגנון כיבוי (למשל משתנה סביבה או flag) – כרגע לא מוגדר בקוד.
