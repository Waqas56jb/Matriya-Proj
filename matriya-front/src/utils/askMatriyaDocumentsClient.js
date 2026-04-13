/**
 * Shared client for POST /ask-matriya (document text path).
 * Used by Upload «חיפוש במסמכים» and Ask Matriya so identical question + scope hits the same behavior.
 * Cross-tab cache: repeat submit skips the network, waits 3s, returns the previous reply.
 */

import api from './api';

function normalizeAskQuestion(text) {
    return String(text || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function makeAskScopeKey(filenames) {
    return [...new Set((Array.isArray(filenames) ? filenames : []).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b, 'he', { sensitivity: 'base' }))
        .join('\n');
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** @type {{ key: string, reply: string, sources: unknown[] } | null} */
let askMatriyaDocumentsCache = null;

/**
 * Same request body as Upload runAsk: { message, filenames } only.
 * @param {string} message
 * @param {string[]} filenames — order must match Upload (API list order for “all files”)
 * @returns {Promise<{ reply: string, sources: unknown[] }>}
 */
export async function runAskMatriyaDocumentsQuery(message, filenames) {
    const repeatKey = `${normalizeAskQuestion(message)}\n---\n${makeAskScopeKey(filenames)}`;
    if (askMatriyaDocumentsCache && askMatriyaDocumentsCache.key === repeatKey) {
        await sleep(3000);
        return {
            reply: askMatriyaDocumentsCache.reply,
            sources: askMatriyaDocumentsCache.sources
        };
    }
    const res = await api.post('/ask-matriya', { message, filenames }, { timeout: 90000 });
    const reply = res.data?.reply ?? '';
    const sources = Array.isArray(res.data?.sources) ? res.data.sources : [];
    askMatriyaDocumentsCache = { key: repeatKey, reply, sources };
    return { reply, sources };
}

/** For dropdown UI only — same helper as Ask tab; does not affect /ask-matriya payload order. */
export function sortFilenamesForAskMatriyaDisplay(filenames) {
    const list = (Array.isArray(filenames) ? filenames : []).filter((f) => typeof f === 'string' && f.trim());
    const base = (f) => f.split('/').filter(Boolean).pop() || f;
    const isSheet = (f) => /\.xlsx$/i.test(base(f)) || /\.xls$/i.test(base(f));
    return [...new Set(list)].sort((a, b) => {
        const sa = isSheet(a);
        const sb = isSheet(b);
        if (sa !== sb) return sa ? -1 : 1;
        return a.localeCompare(b, 'he', { sensitivity: 'base' });
    });
}
