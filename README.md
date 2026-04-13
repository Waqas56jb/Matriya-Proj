# Matriya monorepo (four apps)

All project code for this product lives in these folders:

| Folder | What it is | Typical dev command |
|--------|------------|---------------------|
| `matriya-back/` | MATRIYA API (Express, RAG, lab bridge, Answer Composer) | `cd matriya-back` then `npm install` / `npm run dev` |
| `managment-back/` | Management backend (lab data, uploads, etc.) | `cd managment-back` then `npm install` / `npm start` |
| `managment-front/` | Management frontend | `cd managment-front` then `npm install` / `npm start` |
| `matriya-front/` | MATRIYA React UI | `cd matriya-front` then `npm install` / `npm start` |

**Lab chain:** run `managment-back` (e.g. port 8001) and point MATRIYA `MANAGEMENT_BACK_URL` at it; run inner `matriya-back` (e.g. port 8000); run `matriya-front` with `REACT_APP_API_BASE_URL` pointing at MATRIYA.

Each folder has its own `package.json` and dependencies.
