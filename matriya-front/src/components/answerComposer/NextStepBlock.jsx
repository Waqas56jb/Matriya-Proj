import React from 'react';

export default function NextStepBlock({ nextStep }) {
  const t = nextStep != null ? String(nextStep) : '';
  if (!t) return null;
  return (
    <section className="ac-next-block" aria-labelledby="ac-next-heading">
      <h3 id="ac-next-heading" className="ac-block-title">
        Next step
      </h3>
      <div className="ac-next-text">{t}</div>
    </section>
  );
}
