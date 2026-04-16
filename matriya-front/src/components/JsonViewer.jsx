import React from 'react';
import './JsonViewer.css';

/**
 * Read-only JSON for debug / advanced users. Always LTR — never inherit page RTL.
 */
export default function JsonViewer({ value, maxHeight }) {
  const text =
    typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2);
  const mh = maxHeight ?? 'min(50vh, 420px)';
  return (
    <div className="json-viewer" dir="ltr" lang="en">
      <pre
        className="json-viewer__pre"
        style={{ maxHeight: mh }}
        role="code"
        tabIndex={0}
        aria-label="JSON"
      >
        {text}
      </pre>
    </div>
  );
}
