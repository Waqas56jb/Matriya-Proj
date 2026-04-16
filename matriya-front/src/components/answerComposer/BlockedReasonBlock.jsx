import React from 'react';

export default function BlockedReasonBlock({ blockedReason }) {
  if (blockedReason == null || blockedReason === '') {
    return null;
  }
  return (
    <section className="ac-blocked-block" aria-labelledby="ac-blocked-heading">
      <h3 id="ac-blocked-heading" className="ac-block-title ac-block-title--blocked">
        סיבת חסימה
      </h3>
      <div className="ac-blocked-text">{String(blockedReason)}</div>
    </section>
  );
}
