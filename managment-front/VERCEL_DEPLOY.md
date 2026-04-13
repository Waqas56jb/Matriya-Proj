# Deploy maneger-front to Vercel

1. **Push to GitHub** and import the repo in [Vercel](https://vercel.com) (or connect the `maneger-front` folder as root).

2. **Build settings** (usually auto-detected):
   - Framework: Vite
   - Build Command: `npm run build`
   - Output Directory: `dist`

3. **Environment variable** (required for production):
   - `VITE_MANEGER_API_URL` = your backend URL (e.g. `https://maneger-back-xxx.vercel.app`)

4. Deploy. The frontend will call the API at `VITE_MANEGER_API_URL`.
