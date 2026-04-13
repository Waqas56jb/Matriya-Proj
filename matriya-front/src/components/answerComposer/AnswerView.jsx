import React from 'react';
import DecisionHeader from './DecisionHeader';
import EvidenceBlock from './EvidenceBlock';
import ConstraintRulesBlock from './ConstraintRulesBlock';
import ExternalContextBlock from './ExternalContextBlock';
import BlockedReasonBlock from './BlockedReasonBlock';
import NextStepBlock from './NextStepBlock';
import './AnswerView.css';

/**
 * Pure representation of composeAnswer JSON. Pass API response as-is (data prop).
 */
export default function AnswerView({ data }) {
  if (!data || typeof data !== 'object') {
    return null;
  }

  return (
    <article className="answer-view" data-composer-view="1">
      <DecisionHeader decisionStatus={data.decision_status} answer={data.answer} />
      <EvidenceBlock evidence={data.evidence} />
      <ConstraintRulesBlock items={data.constraint_rules} />
      <ExternalContextBlock items={data.external_context} />
      <BlockedReasonBlock blockedReason={data.blocked_reason} />
      <NextStepBlock nextStep={data.next_step} />
    </article>
  );
}
