/**
 * Lab ↔ Management integration (build-time env on CRA / Vercel).
 * Same Matriya JWT is accepted by the management API (forwarded to Matriya /auth/me).
 */

function trimUrl(v) {
  if (v == null || typeof v !== 'string') return '';
  const s = v.trim();
  return s ? s.replace(/\/$/, '') : '';
}

/** Management backend (Express), e.g. https://manegment-back.vercel.app */
export const MANAGEMENT_API_URL = trimUrl(process.env.REACT_APP_MANAGEMENT_API_URL);

/** Management UI (Vite/React), e.g. https://manegment-front.vercel.app */
export const MANAGEMENT_FRONT_URL = trimUrl(process.env.REACT_APP_MANAGEMENT_FRONT_URL);

export function isManagementLabConfigured() {
  return Boolean(MANAGEMENT_API_URL && MANAGEMENT_FRONT_URL);
}
