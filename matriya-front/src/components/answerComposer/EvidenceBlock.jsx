import React from 'react';

/**
 * Pure display of evidence object fields only.
 */
export default function EvidenceBlock({ evidence }) {
  const e = evidence && typeof evidence === 'object' ? evidence : {};
  const runIds = Array.isArray(e.run_ids) ? e.run_ids : [];
  const baseline = e.baseline_run_id ?? null;
  const grade = e.data_grade ?? '';
  const threshold = e.threshold;
  const maxDelta = e.delta_summary?.max_delta_pct;

  return (
    <section className="ac-evidence-block" aria-labelledby="ac-evidence-heading">
      <h3 id="ac-evidence-heading" className="ac-block-title">
        Evidence
      </h3>
      <dl className="ac-evidence-dl">
        <dt>run_ids</dt>
        <dd>
          <code className="ac-mono">{runIds.length ? runIds.join(', ') : '(empty)'}</code>
        </dd>
        <dt>baseline_run_id</dt>
        <dd>
          <code className="ac-mono">{baseline != null ? String(baseline) : 'null'}</code>
        </dd>
        <dt>data_grade</dt>
        <dd>{String(grade)}</dd>
        <dt>max_delta_pct</dt>
        <dd>{maxDelta != null && maxDelta !== '' ? String(maxDelta) : '—'}</dd>
        <dt>threshold</dt>
        <dd>{threshold != null ? String(threshold) : 'null'}</dd>
        <dt>delta_summary (raw)</dt>
        <dd>
          <pre className="ac-json-pre">{JSON.stringify(e.delta_summary ?? {}, null, 2)}</pre>
          <p className="ac-evidence-footnote" lang="en">
            Constraint Engine (ISM-001) lives in API root <code>constraint_rules</code>, not in this JSON. When
            present, the UI shows <strong>Suggested Experiments (Constraint Engine)</strong> below this Evidence
            section.
          </p>
        </dd>
      </dl>
    </section>
  );
}
