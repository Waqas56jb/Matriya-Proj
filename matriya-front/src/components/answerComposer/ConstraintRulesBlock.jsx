import React from 'react';

/**
 * Constraint Engine (ISM-001, …) — separate from Evidence and external_context.
 * Renders only when API provides non-empty constraint_rules.
 */
export default function ConstraintRulesBlock({ items }) {
  const list = Array.isArray(items) ? items.filter((x) => x && x.matched) : [];
  if (!list.length) return null;

  return (
    <section className="ac-constraint-block" aria-labelledby="ac-constraint-heading">
      <h3 id="ac-constraint-heading" className="ac-block-title">
        Suggested Experiments (Constraint Engine)
      </h3>
      <p className="ac-constraint-disclaimer">
        Analytical follow-up only. Does not change decision status and is not part of Evidence.
      </p>
      <ul className="ac-constraint-list">
        {list.map((rule) => (
          <li key={rule.rule_id} className="ac-constraint-item">
            <div className="ac-constraint-ruleid">
              <span className="ac-constraint-label">rule_id</span>{' '}
              <code className="ac-mono">{String(rule.rule_id)}</code>
              {typeof rule.confidence === 'number' ? (
                <span className="ac-constraint-confidence">
                  {' '}
                  (confidence {rule.confidence})
                </span>
              ) : null}
            </div>
            {Array.isArray(rule.recommended_experiments) && rule.recommended_experiments.length ? (
              <div className="ac-constraint-experiments">
                <div className="ac-constraint-subtitle">Recommended experiments</div>
                <ul>
                  {rule.recommended_experiments.map((ex) => (
                    <li key={ex.id != null ? ex.id : ex.line}>
                      {typeof ex.line === 'string' ? ex.line : JSON.stringify(ex)}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {rule.expected_failure_pattern ? (
              <div className="ac-constraint-pattern">
                <div className="ac-constraint-subtitle">Expected failure pattern</div>
                <p className="ac-constraint-pattern-text">{String(rule.expected_failure_pattern)}</p>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
