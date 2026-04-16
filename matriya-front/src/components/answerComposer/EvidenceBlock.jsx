import React from 'react';

function formatPct(v) {
  if (v == null || v === '') return '—';
  const n = Number(v);
  if (Number.isFinite(n)) return `${n}%`;
  return String(v);
}

/**
 * Evidence — human-readable Hebrew; optional collapsed technical JSON.
 */
export default function EvidenceBlock({ evidence }) {
  const e = evidence && typeof evidence === 'object' ? evidence : {};
  const runIds = Array.isArray(e.run_ids) ? e.run_ids : [];
  const baseline = e.baseline_run_id ?? null;
  const grade = e.data_grade ?? '';
  const threshold = e.threshold;
  const maxDelta = e.delta_summary?.max_delta_pct;
  const channels = Array.isArray(e.delta_summary?.channels) ? e.delta_summary.channels : [];
  const phRun = e.delta_summary?.ph_run;
  const phBase = e.delta_summary?.ph_baseline;

  return (
    <section className="ac-evidence-block" aria-labelledby="ac-evidence-heading">
      <h3 id="ac-evidence-heading" className="ac-block-title">
        ראיות ומדדים
      </h3>
      <dl className="ac-evidence-dl">
        <dt>מזהי ריצות</dt>
        <dd>
          {runIds.length ? (
            <ul className="ac-id-list">
              {runIds.map((id) => (
                <li key={id}>
                  <span className="ac-pill ac-pill--id">{String(id)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <span className="ac-muted">אין</span>
          )}
        </dd>
        <dt>ריצת בסיס</dt>
        <dd>
          {baseline != null ? (
            <span className="ac-pill ac-pill--id">{String(baseline)}</span>
          ) : (
            <span className="ac-muted">—</span>
          )}
        </dd>
        <dt>דירוג נתונים</dt>
        <dd>
          <span className="ac-badge ac-badge--grade">{String(grade || '—')}</span>
        </dd>
        <dt>שינוי מקסימלי (Δ)</dt>
        <dd className="ac-em">{formatPct(maxDelta)}</dd>
        <dt>סף</dt>
        <dd className="ac-em">{threshold != null ? `${threshold}%` : '—'}</dd>
        {(phRun != null || phBase != null) && (
          <>
            <dt>pH (ריצה / בסיס)</dt>
            <dd>
              {phRun != null ? String(phRun) : '—'} / {phBase != null ? String(phBase) : '—'}
            </dd>
          </>
        )}
      </dl>

      {channels.length > 0 && (
        <div className="ac-channels-wrap">
          <h4 className="ac-subtitle">פירוט ערוצים</h4>
          <div className="ac-table-scroll">
            <table className="ac-channel-table">
              <thead>
                <tr>
                  <th scope="col">ערוץ</th>
                  <th scope="col">ערך ריצה</th>
                  <th scope="col">בסיס</th>
                  <th scope="col">Δ%</th>
                  <th scope="col">מצב</th>
                </tr>
              </thead>
              <tbody>
                {channels.map((ch, i) => (
                  <tr key={ch.channel != null ? String(ch.channel) : i}>
                    <td>{ch.channel != null ? String(ch.channel) : '—'}</td>
                    <td>{ch.run_value != null ? String(ch.run_value) : '—'}</td>
                    <td>{ch.baseline_value != null ? String(ch.baseline_value) : '—'}</td>
                    <td>{formatPct(ch.delta_pct)}</td>
                    <td>
                      <span className="ac-badge ac-badge--muted">{ch.status != null ? String(ch.status) : '—'}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <details className="ac-tech-details">
        <summary className="ac-tech-summary">פרטים טכניים (למפתחים)</summary>
        <pre className="ac-json-pre">{JSON.stringify(e.delta_summary ?? {}, null, 2)}</pre>
        <p className="ac-evidence-footnote">
          מנוע האילוצים (ISM וכו׳) מוצג בנפרד למטה כשקיים — לא חלק ממבנה ה-JSON הזה.
        </p>
      </details>
    </section>
  );
}
