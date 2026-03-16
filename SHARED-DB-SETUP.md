# Use the same DB for local and production

So that **Ask Matriya** works the same locally and in production, matriya-back must use the **same** Supabase database (and table) in both environments.

## 1. Use the same env in Vercel as in local

In **Vercel → matriya-back project → Settings → Environment Variables**, set:

| Variable | Value |
|----------|--------|
| `POSTGRES_URL` | **Same** as in your local `.env` (Supabase → Database → Connection string → **Session pooler**, port 6543) |
| `COLLECTION_NAME` | `rag_documents` (same as local default) |

Copy `POSTGRES_URL` and `COLLECTION_NAME` from your local `matriya-back/.env` into Vercel. Do **not** use a different Supabase project or a different connection string for production.

## 2. Verify local and prod use the same DB

After deploying, compare the health response from local and prod:

**Local:**
```bash
curl -s http://localhost:8000/health | jq '.db_fingerprint, .collection_name, .vector_db.document_count'
```

**Production:**
```bash
curl -s https://matriya-back.vercel.app/health | jq '.db_fingerprint, .collection_name, .vector_db.document_count'
```

- **`db_fingerprint`** should be **identical** (e.g. `xxx.pooler.supabase.com`) if both use the same DB.
- **`collection_name`** should be `rag_documents` in both.
- **`document_count`** will be the same number in both once ingest has run.

If `db_fingerprint` differs, production is using a different database. Update Vercel’s `POSTGRES_URL` to match your local `.env` and redeploy.

## 3. After fixing env, re-run ingest for production

From `maneger-back`:

```bash
node scripts/fix-rag-prod.js https://matriya-back.vercel.app
```

Then run the prod check:

```bash
node scripts/check-rag-prod.js https://manegment-back.vercel.app
```
