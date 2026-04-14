/**
 * MATRIYA → Lab Chain bridge (Milestone 1 routing; Milestone 2 continuation).
 *
 * When flow=lab, MATRIYA proxies structured queries to management-back /api/lab/query
 * only. Document RAG is never invoked for this path.
 *
 * Successful and error paths return only the Answer Composer JSON contract (no legacy merge fields).
 *
 * Env: MANAGEMENT_BACK_URL — base URL of management-back (e.g. http://localhost:8001)
 */

import axios from 'axios';
import { composeAnswer } from '../services/answerComposer.js';

/** Always set on flow=lab HTTP responses alongside composeAnswer fields (David: stable contract). */
export const LAB_FLOW_ROUTING = 'LAB_BRIDGE_ONLY';

function withLabFlowRouting(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  return { ...body, routing: LAB_FLOW_ROUTING };
}

export function getManagementBackBaseUrl() {
  const u = (process.env.MANAGEMENT_BACK_URL || process.env.MATRIYA_MANAGEMENT_BACK_URL || '').trim();
  return u.replace(/\/$/, '');
}

/**
 * Extract bridge query params from GET query or POST body (flat keys).
 */
export function labBridgeParamsFromRequest(req) {
  const b = req.body || {};
  const q = req.query || {};
  const pick = (k) => {
    const v = b[k] ?? q[k];
    if (v === undefined || v === null) return null;
    if (typeof v === 'string') return v.trim() || null;
    return v;
  };
  return {
    type: pick('lab_query_type') || pick('type'),
    run_id: pick('run_id'),
    baseline_run_id: pick('baseline_run_id'),
    base_id: pick('base_id'),
    version_a: pick('version_a'),
    version_b: pick('version_b'),
    id_a: pick('id_a'),
    id_b: pick('id_b'),
    metric: pick('metric') || 'viscosity',
  };
}

/**
 * Deterministic human-readable summary — facts from contract only, no LLM.
 */
export function buildDeterministicLabReply(contract) {
  if (!contract || typeof contract !== 'object') {
    return 'NO_ANSWER: invalid lab contract.';
  }
  const lines = [];
  lines.push(`[LAB_BRIDGE] query_type=${contract.query_type}`);
  lines.push(`data_grade=${contract.data_grade}`);
  if (contract.conclusion_status != null) {
    lines.push(`conclusion_status=${contract.conclusion_status}`);
  }
  if (contract.run_type != null) lines.push(`run_type=${contract.run_type}`);
  if (Array.isArray(contract.source_run_ids) && contract.source_run_ids.length) {
    lines.push(`source_run_ids=${contract.source_run_ids.join(',')}`);
  } else {
    lines.push('source_run_ids=(none)');
  }
  if (contract.baseline_run_id) {
    lines.push(`baseline_run_id=${contract.baseline_run_id}`);
  }
  if (contract.blocked_reason) {
    lines.push(`blocked_reason=${contract.blocked_reason}`);
  }
  if (contract.delta_summary && typeof contract.delta_summary === 'object') {
    const ds = contract.delta_summary;
    if (ds.max_delta_pct != null) lines.push(`max_delta_pct=${ds.max_delta_pct}`);
    if (Array.isArray(ds.channels)) {
      for (const ch of ds.channels) {
        if (ch && ch.status === 'COMPARED' && ch.delta_pct != null) {
          lines.push(`${ch.channel}: run=${ch.run_value} baseline=${ch.baseline_value} delta_pct=${ch.delta_pct}`);
        }
      }
    }
    if (ds.ph_delta != null) lines.push(`ph_delta=${ds.ph_delta}`);
  }
  if (contract.detail?.changed_variables?.length) {
    lines.push(`changed_variables=${contract.detail.changed_variables.join(',')}`);
  }
  if (contract.detail?.material_delta?.changed_materials?.length) {
    const n = contract.detail.material_delta.changed_materials.length;
    lines.push(`material_changes_count=${n}`);
  }
  return lines.join('\n');
}

function internalMatriyaBaseUrl() {
  const u = (process.env.MATRIYA_INTERNAL_BASE_URL || process.env.MATRIYA_BASE_URL || '').trim();
  if (u) return u.replace(/\/$/, '');
  const port = parseInt(process.env.API_PORT || '8000', 10) || 8000;
  return `http://127.0.0.1:${port}`;
}

/**
 * Handle flow=lab on research search — bridge only, no RAG. Response body = composeAnswer(...) only.
 */
async function composeAnswerSafe(query, labResult, externalData, opts) {
  try {
    return await composeAnswer(query, labResult, externalData, opts);
  } catch (e) {
    const msg = e?.message || String(e);
    try {
      return await composeAnswer(query, null, null, {
        ...opts,
        skipExternalFetch: true,
        bridgeFailureReason: `Answer composer error: ${msg}`,
      });
    } catch {
      return {
        answer: `Lab flow error: ${msg}`,
        decision_status: 'INSUFFICIENT_DATA',
        evidence: {
          run_ids: [],
          baseline_run_id: null,
          data_grade: 'HISTORICAL_REFERENCE',
          delta_summary: {},
          threshold: null,
        },
        external_context: [],
        blocked_reason: `Answer composer error: ${msg}`,
        next_step: 'Review server logs and lab contract; verify MANAGEMENT_BACK_URL and management POSTGRES_URL.',
        constraint_rules: [],
        routing: LAB_FLOW_ROUTING,
      };
    }
  }
}

export async function handleLabBridgeFlow(req, res, { query, userId: _userId }) {
  const skipExt = process.env.ANSWER_COMPOSER_SKIP_EXTERNAL === '1';
  const internalApi = internalMatriyaBaseUrl();

  const composerOpts = {
    internalBaseUrl: internalApi,
    skipExternalFetch: skipExt,
  };

  const base = getManagementBackBaseUrl();
  if (!base) {
    const body = await composeAnswerSafe(query, null, null, {
      ...composerOpts,
      skipExternalFetch: true,
      bridgeFailureReason:
        'Lab bridge is not configured: set MANAGEMENT_BACK_URL to the management-back base URL.',
    });
    return res.status(503).json(withLabFlowRouting(body));
  }

  const params = labBridgeParamsFromRequest(req);
  if (!params.type) {
    const body = await composeAnswerSafe(query, null, null, {
      ...composerOpts,
      skipExternalFetch: true,
      bridgeFailureReason:
        'When flow=lab, provide lab_query_type (or type) plus required fields for that query type.',
    });
    return res.status(400).json(withLabFlowRouting(body));
  }

  const qs = {
    type: params.type,
    ...(params.run_id && { run_id: params.run_id }),
    ...(params.baseline_run_id && { baseline_run_id: params.baseline_run_id }),
    ...(params.base_id && { base_id: params.base_id }),
    ...(params.version_a && { version_a: params.version_a }),
    ...(params.version_b && { version_b: params.version_b }),
    ...(params.id_a && { id_a: params.id_a }),
    ...(params.id_b && { id_b: params.id_b }),
    ...(params.metric && { metric: params.metric }),
  };

  try {
    const { data, status } = await axios.get(`${base}/api/lab/query`, {
      params: qs,
      timeout: 60000,
      validateStatus: () => true,
    });

    if (status >= 400) {
      const detail =
        typeof data === 'object' && data && data.error != null ? String(data.error) : '';
      const body = await composeAnswerSafe(query, null, null, {
        ...composerOpts,
        skipExternalFetch: true,
        bridgeFailureReason: `Lab bridge upstream returned HTTP ${status}${detail ? `: ${detail}` : ''}.`,
      });
      if (status === 503) return res.status(503).json(withLabFlowRouting(body));
      if (status === 400) return res.status(400).json(withLabFlowRouting(body));
      return res.status(502).json(withLabFlowRouting(body));
    }

    const contract = data;
    const body = await composeAnswerSafe(query, contract, null, composerOpts);
    return res.json(withLabFlowRouting(body));
  } catch (e) {
    const msg = e.response?.data?.error || e.message || 'bridge request failed';
    const body = await composeAnswerSafe(query, null, null, {
      ...composerOpts,
      skipExternalFetch: true,
      bridgeFailureReason: `Lab bridge request failed: ${msg}`,
    });
    return res.status(502).json(withLabFlowRouting(body));
  }
}
