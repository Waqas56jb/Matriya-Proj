import React, { useState } from 'react';
import api from '../utils/api';
import { toast } from 'react-toastify';
import { formatApiErrorForUser } from '../utils/openAiFriendlyError';
import './RachelUpload.css';

/**
 * טופס העלאת ניסוי (Rachel) — POST /api/experiments/upload
 * שדות: מזהה ניסוי, תאריך, נוסח, תוצאות
 */
export default function RachelUpload() {
    const [experimentName, setExperimentName] = useState('');
    const [date, setDate] = useState('');
    const [formulation, setFormulation] = useState('');
    const [results, setResults] = useState('');
    const [submitting, setSubmitting] = useState(false);

    const handleSubmit = async (e) => {
        e.preventDefault();
        setSubmitting(true);
        try {
            const res = await api.post('/api/experiments/upload', {
                experiment_id: experimentName.trim(),
                date: date.trim(),
                formulation: formulation.trim(),
                results: results.trim()
            });
            if (res.data?.success && res.data?.experiment_id) {
                toast.success(`הניסוי נשמר: ${res.data.experiment_id}`);
                setExperimentName('');
                setDate('');
                setFormulation('');
                setResults('');
            } else {
                toast.error('תשובה לא צפויה מהשרת');
            }
        } catch (err) {
            toast.error(formatApiErrorForUser(err));
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <section className="rachel-upload" dir="rtl" lang="he">
            <h2 className="rachel-upload__title">העלאת ניסוי מעבדה</h2>
            <p className="rachel-upload__hint">
                מזהה הניסוי, תאריך, נוסח והתוצאות נשמרים בטבלת הניסויים (Supabase).
            </p>
            <form className="rachel-upload__form" onSubmit={handleSubmit}>
                <label className="rachel-upload__label">
                    <span className="rachel-upload__label-text">שם / מזהה ניסוי</span>
                    <input
                        className="rachel-upload__input"
                        type="text"
                        name="experiment_id"
                        value={experimentName}
                        onChange={(ev) => setExperimentName(ev.target.value)}
                        placeholder="למשל EXP-2026-042"
                        autoComplete="off"
                        required
                    />
                </label>
                <label className="rachel-upload__label">
                    <span className="rachel-upload__label-text">תאריך</span>
                    <input
                        className="rachel-upload__input"
                        type="date"
                        name="date"
                        value={date}
                        onChange={(ev) => setDate(ev.target.value)}
                        required
                    />
                </label>
                <label className="rachel-upload__label">
                    <span className="rachel-upload__label-text">נוסח (Formulation)</span>
                    <textarea
                        className="rachel-upload__textarea"
                        name="formulation"
                        rows={4}
                        value={formulation}
                        onChange={(ev) => setFormulation(ev.target.value)}
                        placeholder="תיאור הנוסח או הרכיבים"
                        required
                    />
                </label>
                <label className="rachel-upload__label">
                    <span className="rachel-upload__label-text">תוצאות</span>
                    <textarea
                        className="rachel-upload__textarea"
                        name="results"
                        rows={5}
                        value={results}
                        onChange={(ev) => setResults(ev.target.value)}
                        placeholder="תוצאות המדידות או הסיכום"
                        required
                    />
                </label>
                <button type="submit" className="rachel-upload__submit" disabled={submitting}>
                    {submitting ? 'שולח…' : 'שליחה'}
                </button>
            </form>
        </section>
    );
}
