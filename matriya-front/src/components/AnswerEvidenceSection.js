import React from 'react';
import './AnswerEvidenceSection.css';

/**
 * Shows file_search / RAG excerpts returned with an answer (filename + quote).
 * @param {{ sources: { filename?: string, excerpt?: string, text?: string }[], title: string, hint?: string }} props
 */
function AnswerEvidenceSection({ sources, title, hint }) {
    if (!Array.isArray(sources) || sources.length === 0) return null;
    return (
        <section className="matriya-evidence" aria-label={title}>
            <h4 className="matriya-evidence__title">{title}</h4>
            {hint ? <p className="matriya-evidence__hint">{hint}</p> : null}
            <ul className="matriya-evidence__list">
                {sources.map((s, i) => {
                    const label = s.document_name || s.filename || '—';
                    const body = s.preview || s.excerpt || s.text || '';
                    const key = s.source_id != null ? String(s.source_id) : `${label}-${i}`;
                    return (
                        <li key={key} className="matriya-evidence__card">
                            <div className="matriya-evidence__file">
                                <span key={`file-${key}`}>{label}</span>
                            </div>
                            <blockquote className="matriya-evidence__quote">
                                <span key={`quote-${key}`}>{body}</span>
                            </blockquote>
                        </li>
                    );
                })}
            </ul>
        </section>
    );
}

export default AnswerEvidenceSection;
