import React from 'react';

/**
 * Collapsible list; items are shown as-is (labels are structural only).
 */
export default function ExternalContextBlock({ items }) {
  const list = Array.isArray(items) ? items : [];
  const count = list.length;

  return (
    <section className="ac-external-block" aria-labelledby="ac-external-heading">
      <details className="ac-external-details">
        <summary className="ac-external-summary" id="ac-external-heading">
          External context (not validated)
          <span className="ac-external-count"> ({count})</span>
        </summary>
        {count === 0 ? (
          <p className="ac-external-empty">No external rows attached.</p>
        ) : (
          <ul className="ac-external-list">
            {list.map((row, i) => (
              <li key={i} className="ac-external-item">
                <pre className="ac-json-pre">{JSON.stringify(row, null, 2)}</pre>
              </li>
            ))}
          </ul>
        )}
      </details>
    </section>
  );
}
