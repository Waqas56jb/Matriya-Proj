/**
 * Short, user-facing copy for OpenAI / billing errors (Hebrew).
 * Avoids dumping long English API messages into the UI.
 */

function normalizeErrorText(raw) {
  if (raw == null) return '';
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'object' && raw.message) return String(raw.message);
  try {
    return JSON.stringify(raw);
  } catch {
    return String(raw);
  }
}

/**
 * @param {string} text — error body or message
 * @returns {string|null} Hebrew short message, or null to keep caller’s default
 */
export function getOpenAiFriendlyMessage(text) {
  const s = normalizeErrorText(text).toLowerCase();

  if (/incorrect api key|invalid api key|wrong api key|api key provided/i.test(s)) {
    return 'מפתח OpenAI לא תקין. נא להגדיר מפתח תקין בשרת — Please use a valid API key.';
  }

  if (
    /insufficient_quota|quota|rate limit|billing|exceeded your current quota|too many requests|429/.test(s)
  ) {
    return 'מכסת OpenAI או תשלום: בדקו חשבון OpenAI או נסו מאוחר יותר.';
  }

  return null;
}

/**
 * @param {unknown} err — axios error or Error
 * @param {string} fallbackHebrew — if no OpenAI-specific friendly text
 */
export function formatApiErrorForUser(err, fallbackHebrew) {
  const raw =
    err?.response?.data?.error ||
    err?.response?.data?.detail ||
    (typeof err?.response?.data === 'string' ? err.response.data : '') ||
    err?.message ||
    '';
  const friendly = getOpenAiFriendlyMessage(raw);
  if (friendly) return friendly;
  const s = normalizeErrorText(raw).trim();
  return s || fallbackHebrew;
}
