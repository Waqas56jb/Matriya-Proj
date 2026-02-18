/**
 * Justification templates: resolve reason_code to label/description for research loop justifications.
 * Templates can define template_text with placeholders {{agent}}, {{previous_snippet}}.
 */
import { JustificationTemplate } from './database.js';

let cache = null;
let cacheTime = 0;
const CACHE_TTL_MS = 60000; // 1 minute

async function loadTemplates() {
  if (cache && Date.now() - cacheTime < CACHE_TTL_MS) return cache;
  if (!JustificationTemplate) return {};
  try {
    const rows = await JustificationTemplate.findAll();
    cache = rows.reduce((acc, r) => {
      acc[r.reason_code] = {
        label: r.label,
        description: r.description,
        template_text: r.template_text
      };
      return acc;
    }, {});
    cacheTime = Date.now();
    return cache;
  } catch (e) {
    return {};
  }
}

function interpolate(text, context) {
  if (!text || typeof text !== 'string') return text;
  let out = text;
  for (const [key, value] of Object.entries(context || {})) {
    out = out.replace(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g'), String(value ?? ''));
  }
  return out;
}

/**
 * Get display fields for a justification from the template for reason_code.
 * @param {string} reasonCode - e.g. 'output_changed'
 * @param {object} context - { agent, previous_snippet }
 * @returns {Promise<{ label?: string, description?: string }>}
 */
export async function getJustificationDisplay(reasonCode, context = {}) {
  const templates = await loadTemplates();
  const t = templates[reasonCode];
  if (!t) return {};
  const label = t.label ? interpolate(t.label, context) : undefined;
  const description = t.description ? interpolate(t.description, context) : undefined;
  const templateText = t.template_text ? interpolate(t.template_text, context) : undefined;
  return {
    ...(label && { label }),
    ...(description && { description }),
    ...(templateText && { template_text: templateText })
  };
}

/**
 * Invalidate cache (call after admin create/update/delete template).
 */
export function invalidateCache() {
  cache = null;
}
