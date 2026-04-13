# Environment Variables Setup

## Required Environment Variable

The frontend requires the `REACT_APP_API_BASE_URL` environment variable to connect to the backend.

## Local Development

1. **Create a `.env` file** in the `front` directory (same level as `package.json`)

2. **Add the following line**:
   ```
   REACT_APP_API_BASE_URL=http://localhost:8000
   ```

3. **Restart the development server**:
   ```bash
   npm start
   ```

### Example `.env` file for local development:
```
REACT_APP_API_BASE_URL=http://localhost:8000
```

## Production (Vercel)

### Option 1: Set in Vercel Dashboard (Recommended)

1. Go to **Vercel Dashboard** → Your Project → **Settings** → **Environment Variables**
2. Click **Add New**
3. Set:
   - **Key**: `REACT_APP_API_BASE_URL`
   - **Value**: `https://matriya-back.vercel.app`
   - **Environment**: Production, Preview, Development (select all)
4. Click **Save**
5. Redeploy your application

### Option 2: Set in `vercel.json` (Already configured)

The `vercel.json` file already has the environment variable set:
```json
{
  "env": {
    "REACT_APP_API_BASE_URL": "https://matriya-back.vercel.app"
  }
}
```

## Important Notes

- ⚠️ **React requires environment variables to start with `REACT_APP_`** to be accessible in the browser
- ⚠️ **After changing `.env`, you MUST restart the development server**
- ⚠️ **The `.env` file should NOT be committed to git** (it's already in `.gitignore`)
- ✅ **For production**, set the environment variable in Vercel Dashboard or `vercel.json`

## Troubleshooting

### Error: "REACT_APP_API_BASE_URL is not set"
- Make sure you created a `.env` file in the `front` directory
- Make sure the variable name is exactly `REACT_APP_API_BASE_URL` (case-sensitive)
- Restart the development server after creating/editing `.env`

### Still not working?
1. Check that `.env` file is in the correct location (`front/.env`)
2. Verify the variable name is correct (must start with `REACT_APP_`)
3. Make sure there are no spaces around the `=` sign
4. Restart the development server completely
