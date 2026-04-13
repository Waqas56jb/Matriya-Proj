import React from 'react';

/**
 * Pure display: decision_status + answer text. No branching on business rules beyond CSS class from status string.
 */
export default function DecisionHeader({ decisionStatus, answer }) {
  const status = decisionStatus ?? '';
  const text = answer ?? '';
  return (
    <header className="ac-decision-header" data-decision-status={status}>
      <div className="ac-decision-header__bar" aria-hidden="true" />
      <div className="ac-decision-header__body">
        <div className="ac-decision-header__status-row">
          <span className="ac-decision-header__label">Decision</span>
          <span className="ac-decision-header__status">{status}</span>
        </div>
        <div className="ac-decision-header__answer">{text}</div>
      </div>
    </header>
  );
}
