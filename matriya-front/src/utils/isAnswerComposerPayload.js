/**
 * Detects Answer Composer (composeAnswer) API shape — used only to choose the AnswerView renderer.
 * Does not transform the payload.
 */
export function isAnswerComposerPayload(data) {
  return (
    data &&
    typeof data === 'object' &&
    typeof data.decision_status === 'string' &&
    data.evidence &&
    typeof data.evidence === 'object' &&
    Array.isArray(data.evidence.run_ids) &&
    Array.isArray(data.external_context) &&
    typeof data.answer === 'string' &&
    Object.prototype.hasOwnProperty.call(data, 'blocked_reason') &&
    typeof data.next_step === 'string' &&
    (data.constraint_rules === undefined || Array.isArray(data.constraint_rules))
  );
}
