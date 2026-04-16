import React from 'react';

/**
 * Constraint rules — Hebrew UI; content lines may stay in English if returned by API.
 */
export default function ConstraintRulesBlock({ items }) {
  const list = Array.isArray(items) ? items.filter((x) => x && x.matched) : [];
  if (!list.length) return null;

  return (
    <section className="ac-constraint-block" aria-labelledby="ac-constraint-heading">
      <h3 id="ac-constraint-heading" className="ac-block-title">
        ניסויים מוצעים (מנוע אילוצים)
      </h3>
      <p className="ac-constraint-disclaimer">
        המלצות אנליטיות בלבד — אינן משנות את סטטוס ההחלטה ואינן חלק מחבילת הראיות המאומתת.
      </p>
      <ul className="ac-constraint-list">
        {list.map((rule) => (
          <li key={rule.rule_id} className="ac-constraint-item">
            <div className="ac-constraint-ruleid">
              <span className="ac-constraint-label">כלל</span>{' '}
              <strong className="ac-rule-name">{String(rule.rule_id)}</strong>
              {typeof rule.confidence === 'number' ? (
                <span className="ac-constraint-confidence"> · רמת התאמה {rule.confidence}</span>
              ) : null}
            </div>
            {rule.hypothesis ? <p className="ac-constraint-hypothesis">היפותזה: {String(rule.hypothesis)}</p> : null}
            {Array.isArray(rule.recommended_experiments) && rule.recommended_experiments.length ? (
              <div className="ac-constraint-experiments">
                <div className="ac-constraint-subtitle">ניסויים מומלצים</div>
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
                <div className="ac-constraint-subtitle">דפוס כשל צפוי</div>
                <p className="ac-constraint-pattern-text">{String(rule.expected_failure_pattern)}</p>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
