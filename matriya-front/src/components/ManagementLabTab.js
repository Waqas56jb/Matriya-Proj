import React, { useState, useEffect } from 'react';
import {
  MANAGEMENT_API_URL,
  MANAGEMENT_FRONT_URL,
  isManagementLabConfigured
} from '../utils/managementConfig';
import managementApi from '../utils/managementApi';
import './ManagementLabTab.css';

function ManagementLabTab() {
  const [status, setStatus] = useState('idle');
  const [detail, setDetail] = useState(null);
  const [projectTotal, setProjectTotal] = useState(null);

  useEffect(() => {
    if (!isManagementLabConfigured()) {
      setStatus('unconfigured');
      return;
    }

    let cancelled = false;
    setStatus('checking');

    (async () => {
      try {
        const me = await managementApi.get('/api/auth/me');
        if (cancelled) return;
        setDetail({ user: me.data });
        setStatus('ok');

        try {
          const pr = await managementApi.get('/api/projects', { params: { limit: 1, offset: 0 } });
          if (!cancelled && pr.data && typeof pr.data.total === 'number') {
            setProjectTotal(pr.data.total);
          }
        } catch (_) {
          if (!cancelled) setProjectTotal(null);
        }
      } catch (err) {
        if (cancelled) return;
        const msg =
          err.response?.data?.error ||
          err.response?.data?.detail ||
          err.message ||
          'שגיאת חיבור';
        setDetail({ error: msg, status: err.response?.status });
        setStatus('error');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const openManagementUi = () => {
    if (!MANAGEMENT_FRONT_URL) return;
    window.open(MANAGEMENT_FRONT_URL, '_blank', 'noopener,noreferrer');
  };

  if (!isManagementLabConfigured()) {
    return (
      <div className="management-lab-tab">
        <div className="management-lab-card">
          <h2>מעבדה (ניהול)</h2>
          <p className="management-lab-lead">
            כדי לשלב את המעבדה, הגדר משתני סביבה בזמן הבנייה (לוקאלי: קובץ <code>.env</code>, Vercel: Environment
            Variables):
          </p>
          <ul className="management-lab-env-list">
            <li>
              <code>REACT_APP_MANAGEMENT_API_URL</code> — כתובת שרת הניהול (למשל{' '}
              <code>https://manegment-back.vercel.app</code>)
            </li>
            <li>
              <code>REACT_APP_MANAGEMENT_FRONT_URL</code> — כתובת ממשק הניהול (למשל{' '}
              <code>https://manegment-front.vercel.app</code>)
            </li>
          </ul>
          <p className="management-lab-note">
            <strong>התחברות:</strong> אותו משתמש וסיסמה כמו ב־Matriya — שרת הניהול מאמת מול Matriya באמצעות אותו JWT.
            בממשק הניהול (לשונית נפרדת) יש להתחבר עם אותם פרטים.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="management-lab-tab">
      <div className="management-lab-card">
        <h2>מעבדה (ניהול)</h2>
        <p className="management-lab-lead">
          חיבור למערכת הפרויקטים והמעבדה. <strong>אותו שם משתמש וסיסמה כמו ב־Matriya</strong> — האימות עובר לשרת
          Matriya דרך שרת הניהול.
        </p>

        <div className="management-lab-urls">
          <div>
            <span className="management-lab-label">API</span>
            <code className="management-lab-code">{MANAGEMENT_API_URL}</code>
          </div>
          <div>
            <span className="management-lab-label">ממשק</span>
            <code className="management-lab-code">{MANAGEMENT_FRONT_URL}</code>
          </div>
        </div>

        {status === 'checking' && <p className="management-lab-status checking">בודק חיבור לשרת הניהול…</p>}

        {status === 'ok' && detail?.user && (
          <p className="management-lab-status ok">
            <span key="status-ok">
              מחובר לשרת הניהול כ־<strong>{detail.user.username || detail.user.full_name || 'משתמש'}</strong>
              {projectTotal != null ? ` · ${projectTotal} פרויקטים במערכת` : ''}.
            </span>
          </p>
        )}

        {status === 'error' && (
          <p className="management-lab-status error">
            <span key="status-error">
              לא ניתן לאמת מול שרת הניהול: {detail?.error}
              {detail?.status === 503
                ? ' — ודא ש־MATRIYA_BACK_URL מוגדר אצל שרת הניהול וש־Matriya זמין.'
                : ''}
            </span>
          </p>
        )}

        <div className="management-lab-actions">
          <button type="button" className="management-lab-primary" onClick={openManagementUi}>
            פתח את מערכת הניהול בלשונית חדשה
          </button>
        </div>

        <p className="management-lab-hint">
          במעבדת הפרויקט (בממשק הניהול): קבצי Excel מוצגים כטבלאות והטקסט ל־AI נשמר במבנה טבלה (Markdown) — עדכון
          גיליון: העלה מחדש את הקובץ.
        </p>
        <p className="management-lab-hint">
          אם נפתחת מסך התחברות במערכת הניהול, התחבר עם אותם פרטים שב־Matriya. הטוקן כאן משמש רק לבדיקת API מתוך
          Matriya; הדפדפן בממשק הניהול שומר התחברות נפרדת.
        </p>
      </div>
    </div>
  );
}

export default ManagementLabTab;
