# Vercel Environment Variables Setup

## Important: Set Environment Variables in Vercel Dashboard

The `vercel.json` file does NOT set environment variables for React builds. You MUST set them in the Vercel Dashboard.

## Steps to Set Environment Variables

1. Go to **Vercel Dashboard** → Your Project (`matriya-front`)
2. Click **Settings** → **Environment Variables**
3. Click **Add New**
4. Add the following:

   **Key**: `REACT_APP_API_BASE_URL`  
   **Value**: `https://matriya-back.vercel.app`  
   **Environment**: Select all (Production, Preview, Development)

5. Click **Save**
6. **Redeploy** your application:
   - Go to **Deployments**
   - Click **"..."** on the latest deployment
   - Click **Redeploy**

## Why This is Needed

React environment variables must:
- Start with `REACT_APP_` to be accessible in the browser
- Be set in Vercel Dashboard (not in `vercel.json` for React apps)
- Be set before the build process starts

## Verification

After redeploying, check the browser console. You should see the API calls going to:
```
https://matriya-back.vercel.app/auth/login
```

NOT:
```
https://matriya-front.vercel.app/REACT_APP_API_BASE_URL=...
```

## Local Development

For local development, create a `.env` file in the `front` directory:
```
REACT_APP_API_BASE_URL=http://localhost:8000
```
