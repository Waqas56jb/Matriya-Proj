import React from 'react';
import { labelDecisionStatus } from '../../utils/decisionLabels';

/**
 * Decision strip — Hebrew labels, status from API for styling only.
 */
export default function DecisionHeader({ decisionStatus, answer }) {
  const status = decisionStatus ?? '';
  const text = answer ?? '';
  const labelHe = labelDecisionStatus(status);
  return (
    <header className="ac-decision-header" data-decision-status={status}>
      <div className="ac-decision-header__bar" aria-hidden="true" />
      <div className="ac-decision-header__body">
        <div className="ac-decision-header__status-row">
          <span className="ac-decision-header__label">סטטוס החלטה</span>
          <span className="ac-decision-header__status" title={status || undefined}>
            {labelHe}
          </span>
        </div>
        <div className="ac-decision-header__answer">{text}</div>
      </div>
    </header>
  );
}
