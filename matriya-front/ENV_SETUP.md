# Environment Variables Setup

## Backend API URL

The frontend uses the `REACT_APP_API_BASE_URL` environment variable to connect to the backend.

### Local Development

1. Create a `.env` file in the `front` directory (if it doesn't exist)
2. Add the following line:
   ```
   REACT_APP_API_BASE_URL=http://localhost:8000
   ```
3. Restart the development server

### Production (Vercel)

The environment variable is automatically set in `vercel.json`:
```
REACT_APP_API_BASE_URL=https://matriya-back.vercel.app
```

You can also set it manually in Vercel Dashboard:
1. Go to your project → Settings → Environment Variables
2. Add: `REACT_APP_API_BASE_URL` = `https://matriya-back.vercel.app`

### Default Value

If the environment variable is not set, it defaults to:
```
https://matriya-back.vercel.app
```

## Management lab (מעבדה) tab

The **מעבדה (ניהול)** tab embeds the management UI lab for a selected project (same as: management app → project → מעבדה). It uses your **Matriya login JWT** against the management API (maneger-back proxies auth to Matriya).

Set at build time:

| Variable | Example (production) |
|----------|----------------------|
| `REACT_APP_MANAGEMENT_API_URL` | `https://manegment-back.vercel.app` |
| `REACT_APP_MANAGEMENT_FRONT_URL` | `https://manegment-front.vercel.app` |

Local example:

```
REACT_APP_MANAGEMENT_API_URL=http://localhost:8001
REACT_APP_MANAGEMENT_FRONT_URL=http://localhost:5173
```

On **maneger-back**, allow the Matriya front origin in CORS (default list includes `https://matriya-front.vercel.app`; override with `CORS_ORIGINS` if needed).

## Important Notes

- React requires environment variables to start with `REACT_APP_` to be accessible in the browser
- After changing `.env`, you must restart the development server
- The `.env` file should NOT be committed to git (it's in `.gitignore`)
