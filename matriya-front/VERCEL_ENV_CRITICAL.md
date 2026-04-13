# CRITICAL: Vercel Environment Variables Setup

## The Problem

If you see errors like:
```
POST https://matriya-front.vercel.app/REACT_APP_API_BASE_URL=https:/matriya-back.vercel.app/auth/login
```

This means the environment variable is **NOT** being read correctly in Vercel.

## Why This Happens

React environment variables (those starting with `REACT_APP_`) are **embedded at BUILD TIME**, not runtime. This means:

1. ✅ The variable must be set **BEFORE** the build runs
2. ✅ The variable must be set in **Vercel Dashboard**, not just in code
3. ❌ Setting it after deployment won't work - you must **redeploy**

## Solution

### Step 1: Set Environment Variable in Vercel Dashboard

1. Go to **Vercel Dashboard** → Your Project (`matriya-front`)
2. Click **Settings** → **Environment Variables**
3. Click **Add New**
4. Set:
   - **Key**: `REACT_APP_API_BASE_URL`
   - **Value**: `https://matriya-back.vercel.app`
   - **Environment**: Select **ALL** (Production, Preview, Development)
5. Click **Save**

### Step 2: Redeploy

**IMPORTANT**: After setting the environment variable, you MUST redeploy:

1. Go to **Deployments**
2. Click **"..."** on the latest deployment
3. Click **Redeploy**
4. Wait for the build to complete

### Step 3: Verify

After redeploying, check the browser console. You should see API calls going to:
```
https://matriya-back.vercel.app/auth/login
```

NOT:
```
https://matriya-front.vercel.app/REACT_APP_API_BASE_URL=...
```

## Common Mistakes

❌ **Setting the variable but not redeploying** - The variable is only available in NEW builds
❌ **Setting it only for Production** - Set it for all environments
❌ **Using wrong variable name** - Must be exactly `REACT_APP_API_BASE_URL` (case-sensitive)
❌ **Adding trailing slash** - Use `https://matriya-back.vercel.app` not `https://matriya-back.vercel.app/`

## Verification

To verify the variable is set correctly:
1. Check Vercel Dashboard → Settings → Environment Variables
2. Make sure `REACT_APP_API_BASE_URL` is listed
3. Make sure it's set for all environments
4. Redeploy and check the build logs - it should show the variable is available
