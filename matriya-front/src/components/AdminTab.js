import React, { useState, useEffect } from 'react';
import api from '../utils/api';
import './AdminTab.css';

function AdminTab({ isAdmin }) {
    const [files, setFiles] = useState([]);
    const [users, setUsers] = useState([]);
    const [selectedUser, setSelectedUser] = useState(null);
    const [userPermissions, setUserPermissions] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [activeSection, setActiveSection] = useState('files'); // 'files' | 'users' | 'history' | 'integrity' | 'global'
    const [deletingFile, setDeletingFile] = useState(null);
    const [savingPermissions, setSavingPermissions] = useState(false);
    const [searchHistory, setSearchHistory] = useState([]);
    const [historyLoading, setHistoryLoading] = useState(false);
    // B-Integrity dashboard
    const [dashboard, setDashboard] = useState(null);
    const [dashboardLoading, setDashboardLoading] = useState(false);
    const [violationModal, setViolationModal] = useState(null);
    const [resolvingId, setResolvingId] = useState(null);
    const [resolveNote, setResolveNote] = useState('');
    // Dashboard filters
    const [filterFromDate, setFilterFromDate] = useState('');
    const [filterToDate, setFilterToDate] = useState('');
    const [filterViolationStatus, setFilterViolationStatus] = useState('all');
    const [filterViolationType, setFilterViolationType] = useState('');
    // Global metrics
    const [globalMetrics, setGlobalMetrics] = useState(null);
    const [globalMetricsLoading, setGlobalMetricsLoading] = useState(false);
    // Risk Oracle (B-Integrity)
    const [oracle, setOracle] = useState(null);
    const [oracleLoading, setOracleLoading] = useState(false);
    // Value summary report
    const [valueSummary, setValueSummary] = useState(null);
    const [valueSummaryLoading, setValueSummaryLoading] = useState(false);
    const [valueSummarySessionId, setValueSummarySessionId] = useState('');
    const [valueSummaryDateFrom, setValueSummaryDateFrom] = useState('');
    const [valueSummaryDateTo, setValueSummaryDateTo] = useState('');
    // FIL-01 warnings
    const [filWarnings, setFilWarnings] = useState(null);
    const [filWarningsLoading, setFilWarningsLoading] = useState(false);

    useEffect(() => {
        if (isAdmin) {
            loadFiles();
            loadUsers();
        } else {
            setLoading(false);
        }
    }, [isAdmin]);

    useEffect(() => {
        if (activeSection === 'history') {
            loadSearchHistory();
        }
        if (activeSection === 'integrity') {
            loadIntegrityDashboard();
            loadOracle();
            loadValueSummary();
            loadFilWarnings();
        }
        if (activeSection === 'global') {
            loadGlobalMetrics();
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loaders are stable and defined below
    }, [activeSection]);

    const loadFiles = async () => {
        try {
            const response = await api.get('/admin/files', {
                timeout: 15000  // 15 second timeout (files list may need RAG service init)
            });
            setFiles(response.data.files || []);
        } catch (err) {
            setError(err.response?.data?.detail || err.message || 'שגיאה בטעינת קבצים');
        } finally {
            setLoading(false);
        }
    };

    const loadUsers = async () => {
        try {
            const response = await api.get('/admin/users', {
                timeout: 10000  // 10 second timeout for user list
            });
            setUsers(response.data.users || []);
        } catch (err) {
            console.error('Error loading users:', err);
        }
    };

    const loadSearchHistory = async () => {
        setHistoryLoading(true);
        setError(null);
        try {
            const response = await api.get('/admin/search-history', {
                params: { limit: 100 },
                timeout: 10000
            });
            setSearchHistory(response.data.history || []);
        } catch (err) {
            setError(err.response?.data?.error || err.message || 'שגיאה בטעינת היסטוריית חיפושים');
        } finally {
            setHistoryLoading(false);
        }
    };

    const handleDeleteFile = async (filename) => {
        if (!window.confirm(`האם אתה בטוח שברצונך למחוק את הקובץ "${filename}"?`)) {
            return;
        }

        setDeletingFile(filename);
        try {
            await api.delete(`/admin/files/${encodeURIComponent(filename)}`, {
                timeout: 5000
            });
            setFiles(files.filter(f => f !== filename));
            alert('הקובץ נמחק בהצלחה');
        } catch (err) {
            alert(err.response?.data?.detail || err.message || 'שגיאה במחיקת קובץ');
        } finally {
            setDeletingFile(null);
        }
    };

    const handleUserClick = async (user) => {
        setSelectedUser(user);
        try {
            const response = await api.get(`/admin/users/${user.id}/permissions`, {
                timeout: 5000  // 5 second timeout
            });
            setUserPermissions(response.data);
        } catch (err) {
            alert(err.response?.data?.detail || err.message || 'שגיאה בטעינת הרשאות');
        }
    };

    const handleSavePermissions = async () => {
        if (!selectedUser || !userPermissions) return;

        setSavingPermissions(true);
        try {
            await api.post(`/admin/users/${selectedUser.id}/permissions`, {
                access_all_files: userPermissions.access_all_files,
                allowed_files: userPermissions.allowed_files
            }, {
                timeout: 5000
            });
            alert('הרשאות עודכנו בהצלחה');
        } catch (err) {
            alert(err.response?.data?.detail || err.message || 'שגיאה בשמירת הרשאות');
        } finally {
            setSavingPermissions(false);
        }
    };

    const handleToggleAccessAll = () => {
        setUserPermissions({
            ...userPermissions,
            access_all_files: !userPermissions.access_all_files,
            allowed_files: userPermissions.access_all_files ? [] : userPermissions.allowed_files
        });
    };

    const handleToggleFile = (filename) => {
        if (userPermissions.access_all_files) return;
        
        const currentFiles = userPermissions.allowed_files || [];
        if (currentFiles.includes(filename)) {
            setUserPermissions({
                ...userPermissions,
                allowed_files: currentFiles.filter(f => f !== filename)
            });
        } else {
            setUserPermissions({
                ...userPermissions,
                allowed_files: [...currentFiles, filename]
            });
        }
    };

    const loadIntegrityDashboard = async () => {
        setDashboardLoading(true);
        setError(null);
        try {
            const params = { limit: 200 };
            if (filterFromDate) params.from_date = filterFromDate;
            if (filterToDate) params.to_date = filterToDate;
            if (filterViolationStatus !== 'all') params.violation_status = filterViolationStatus;
            if (filterViolationType) params.violation_type = filterViolationType;
            const response = await api.get('/admin/recovery/dashboard', { params, timeout: 10000 });
            setDashboard(response.data);
        } catch (err) {
            setError(err.response?.data?.error || err.message || 'שגיאה בטעינת דשבורד B-Integrity');
        } finally {
            setDashboardLoading(false);
        }
    };

    const applyDashboardFilters = () => {
        loadIntegrityDashboard();
    };

    const exportDashboardCsv = (kind) => {
        if (!dashboard) return;
        const BOM = '\uFEFF';
        if (kind === 'violations') {
            const rows = (dashboard.violations || []).map(v => ({
                id: v.id,
                session_id: v.session_id,
                type: v.type || '',
                reason: (v.reason || '').replace(/"/g, '""'),
                created_at: v.created_at || '',
                resolved_at: v.resolved_at || '',
                resolve_note: (v.resolve_note || '').replace(/"/g, '""')
            }));
            const headers = ['id', 'session_id', 'type', 'reason', 'created_at', 'resolved_at', 'resolve_note'];
            const csv = [headers.join(','), ...rows.map(r => headers.map(h => `"${String(r[h] ?? '')}"`).join(','))].join('\r\n');
            const blob = new Blob([BOM + csv], { type: 'text/csv;charset=utf-8' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `integrity-violations-${new Date().toISOString().slice(0, 10)}.csv`;
            a.click();
            URL.revokeObjectURL(a.href);
        } else {
            const points = dashboard.chart?.points || [];
            const rows = points.map((p, i) => ({ cycle_index: i + 1, value: p.value, t: p.t || '', session_id: p.session_id || '' }));
            const headers = ['cycle_index', 'value', 't', 'session_id'];
            const csv = [headers.join(','), ...rows.map(r => headers.map(h => `"${String(r[h] ?? '')}"`).join(','))].join('\r\n');
            const blob = new Blob([BOM + csv], { type: 'text/csv;charset=utf-8' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `integrity-chart-${new Date().toISOString().slice(0, 10)}.csv`;
            a.click();
            URL.revokeObjectURL(a.href);
        }
    };

    const handleResolveViolation = async (id) => {
        setResolvingId(id);
        try {
            await api.patch(`/admin/recovery/violations/${id}`, { resolve_note: resolveNote || undefined }, { timeout: 5000 });
            setViolationModal(null);
            setResolveNote('');
            loadIntegrityDashboard();
        } catch (err) {
            alert(err.response?.data?.error || err.message || 'שגיאה בשחרור נעילה');
        } finally {
            setResolvingId(null);
        }
    };

    const formatGateStatus = (s) => {
        const map = { HEALTHY: 'תקין', HALTED: 'נעול', RECOVERY: 'החלמה' };
        return map[s] || s;
    };

    const loadGlobalMetrics = async () => {
        setGlobalMetricsLoading(true);
        setError(null);
        try {
            const response = await api.get('/admin/metrics/global', { timeout: 10000 });
            setGlobalMetrics(response.data);
        } catch (err) {
            setError(err.response?.data?.error || err.message || 'שגיאה בטעינת מדדי גלובל');
        } finally {
            setGlobalMetricsLoading(false);
        }
    };

    const loadOracle = async () => {
        setOracleLoading(true);
        try {
            const response = await api.get('/admin/recovery/oracle', { timeout: 10000 });
            setOracle(response.data);
        } catch (err) {
            setOracle(null);
        } finally {
            setOracleLoading(false);
        }
    };

    const loadValueSummary = async () => {
        setValueSummaryLoading(true);
        try {
            const params = {};
            if (valueSummarySessionId) params.session_id = valueSummarySessionId;
            if (valueSummaryDateFrom) params.date_from = valueSummaryDateFrom;
            if (valueSummaryDateTo) params.date_to = valueSummaryDateTo;
            const response = await api.get('/admin/reports/value-summary', { params, timeout: 10000 });
            setValueSummary(response.data);
        } catch (err) {
            setValueSummary(null);
        } finally {
            setValueSummaryLoading(false);
        }
    };

    const exportValueSummaryCsv = async () => {
        const params = { format: 'csv' };
        if (valueSummarySessionId) params.session_id = valueSummarySessionId;
        if (valueSummaryDateFrom) params.date_from = valueSummaryDateFrom;
        if (valueSummaryDateTo) params.date_to = valueSummaryDateTo;
        try {
            const response = await api.get('/admin/reports/value-summary', { params, responseType: 'text', timeout: 10000 });
            const blob = new Blob([response.data], { type: 'text/csv;charset=utf-8' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `value-summary-${new Date().toISOString().slice(0, 10)}.csv`;
            a.click();
            URL.revokeObjectURL(a.href);
        } catch (err) {
            alert(err.response?.data?.error || err.message || 'שגיאה בייצוא');
        }
    };

    const loadFilWarnings = async () => {
        setFilWarningsLoading(true);
        try {
            const response = await api.get('/admin/fil/warnings', { params: { days: 30 }, timeout: 10000 });
            setFilWarnings(response.data);
        } catch (err) {
            setFilWarnings(null);
        } finally {
            setFilWarningsLoading(false);
        }
    };

    if (!isAdmin) {
        return (
            <div className="admin-tab">
                <div className="card">
                    <div className="empty-state">אין הרשאות ניהול</div>
                </div>
            </div>
        );
    }

    if (loading) {
        return (
            <div className="admin-tab">
                <div className="card">
                    <div className="loading">טוען...</div>
                </div>
            </div>
        );
    }

    return (
        <div className="admin-tab">
            <div className="card">
                <h2>ניהול מערכת - Admin</h2>
                
                <div className="admin-sections">
                    <button
                        className={`section-button ${activeSection === 'files' ? 'active' : ''}`}
                        onClick={() => setActiveSection('files')}
                    >
                        ניהול קבצים
                    </button>
                    <button
                        className={`section-button ${activeSection === 'users' ? 'active' : ''}`}
                        onClick={() => setActiveSection('users')}
                    >
                        ניהול הרשאות משתמשים
                    </button>
                    <button
                        className={`section-button ${activeSection === 'history' ? 'active' : ''}`}
                        onClick={() => setActiveSection('history')}
                    >
                        הסטורית חיפושים
                    </button>
                    <button
                        className={`section-button ${activeSection === 'integrity' ? 'active' : ''}`}
                        onClick={() => setActiveSection('integrity')}
                    >
                        דשבורד B-Integrity
                    </button>
                    <button
                        className={`section-button ${activeSection === 'global' ? 'active' : ''}`}
                        onClick={() => setActiveSection('global')}
                    >
                        מדדי גלובל
                    </button>
                </div>

                {error && (
                    <div className="error-message">{error}</div>
                )}

                {activeSection === 'files' && (
                    <div className="files-section">
                        <h3>כל הקבצים במאגר ({files.length})</h3>
                        {files.length === 0 ? (
                            <div className="empty-state">אין קבצים במאגר</div>
                        ) : (
                            <div className="files-list">
                                {files.map((filename, index) => (
                                    <div key={index} className="file-item">
                                        <span className="file-name">{filename}</span>
                                    <button
                                        className={`delete-button ${deletingFile === filename ? 'loading' : ''}`}
                                        onClick={() => handleDeleteFile(filename)}
                                        disabled={deletingFile === filename}
                                    >
                                        {deletingFile === filename ? (
                                            <span key="loading" className="btn-inner">
                                                <span className="spinner"></span>
                                                <span>מוחק...</span>
                                            </span>
                                        ) : (
                                            <span key="idle" className="btn-inner">
                                                <span>מחק</span>
                                            </span>
                                        )}
                                    </button>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}

                {activeSection === 'users' && (
                    <div className="users-section">
                        <div className="users-list-container">
                            <h3>משתמשים ({users.length})</h3>
                            <div className="users-list">
                                {users.map((user) => (
                                    <div
                                        key={user.id}
                                        className={`user-item ${selectedUser?.id === user.id ? 'selected' : ''}`}
                                        onClick={() => handleUserClick(user)}
                                    >
                                        <div className="user-info">
                                            <strong>{user.username}</strong>
                                            {user.full_name && <span> - {user.full_name}</span>}
                                            {user.is_admin && <span className="admin-badge">Admin</span>}
                                        </div>
                                        <div className="user-email">{user.email}</div>
                                    </div>
                                ))}
                            </div>
                        </div>

                        {selectedUser && userPermissions && (
                            <div className="permissions-panel">
                                <h3>הרשאות עבור: {selectedUser.username}</h3>
                                
                                <div className="permission-option">
                                    <label className="checkbox-label">
                                        <input
                                            type="checkbox"
                                            checked={userPermissions.access_all_files}
                                            onChange={handleToggleAccessAll}
                                        />
                                        <span>גישה לכל הקבצים</span>
                                    </label>
                                </div>

                                {!userPermissions.access_all_files && (
                                    <div className="files-permissions">
                                        <h4>בחר קבצים מותרים:</h4>
                                        <div className="files-checkbox-list">
                                            {files.map((filename, index) => (
                                                <label key={index} className="checkbox-label">
                                                    <input
                                                        type="checkbox"
                                                        checked={userPermissions.allowed_files?.includes(filename) || false}
                                                        onChange={() => handleToggleFile(filename)}
                                                    />
                                                    <span>{filename}</span>
                                                </label>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                <button
                                    className={`save-button ${savingPermissions ? 'loading' : ''}`}
                                    onClick={handleSavePermissions}
                                    disabled={savingPermissions}
                                >
                                    {savingPermissions ? (
                                        <span key="loading" className="btn-inner">
                                            <span className="spinner"></span>
                                            <span>שומר...</span>
                                        </span>
                                    ) : (
                                        <span key="idle" className="btn-inner">
                                            <span>שמור הרשאות</span>
                                        </span>
                                    )}
                                </button>
                            </div>
                        )}
                    </div>
                )}

                {activeSection === 'history' && (
                    <div className="history-section">
                        <h3>הסטורית חיפושים – שאלות ותשובות משתמשים</h3>
                        {historyLoading ? (
                            <div className="loading">טוען...</div>
                        ) : searchHistory.length === 0 ? (
                            <div className="empty-state">אין עדיין היסטוריית חיפושים</div>
                        ) : (
                            <div className="search-history-list">
                                {searchHistory.map((item) => (
                                    <div key={item.id} className="history-item">
                                        <div className="history-meta">
                                            <span className="history-username">{item.username}</span>
                                            <span className="history-date">
                                                {item.created_at ? new Date(item.created_at).toLocaleString('he-IL') : ''}
                                            </span>
                                        </div>
                                        <div className="history-question"><strong>שאלה:</strong> {item.question}</div>
                                        <div className="history-answer"><strong>תשובה:</strong> {item.answer || '—'}</div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}

                {activeSection === 'integrity' && (
                    <div className="integrity-section">
                        <h3>דשבורד B-Integrity</h3>
                        <div className="dashboard-toolbar">
                            <div className="dashboard-filters">
                                <div className="filter-group">
                                    <label>מתאריך</label>
                                    <input type="date" value={filterFromDate} onChange={e => setFilterFromDate(e.target.value)} className="filter-input" />
                                </div>
                                <div className="filter-group">
                                    <label>עד תאריך</label>
                                    <input type="date" value={filterToDate} onChange={e => setFilterToDate(e.target.value)} className="filter-input" />
                                </div>
                                <div className="filter-group">
                                    <label>סטטוס הפרות</label>
                                    <select value={filterViolationStatus} onChange={e => setFilterViolationStatus(e.target.value)} className="filter-select">
                                        <option value="all">הכל</option>
                                        <option value="active">פעיל בלבד</option>
                                        <option value="resolved">מטופל בלבד</option>
                                    </select>
                                </div>
                                <div className="filter-group">
                                    <label>סוג הפרה</label>
                                    <input type="text" value={filterViolationType} onChange={e => setFilterViolationType(e.target.value)} placeholder="סינון לפי סוג" className="filter-input filter-input-text" />
                                </div>
                                <button type="button" className="filter-apply-btn" onClick={applyDashboardFilters}>החל סינון</button>
                            </div>
                            <div className="dashboard-export">
                                <button type="button" className="export-csv-btn" onClick={() => exportDashboardCsv('violations')} disabled={!dashboard || !(dashboard.violations || []).length}>ייצוא CSV הפרות</button>
                                <button type="button" className="export-csv-btn" onClick={() => exportDashboardCsv('chart')} disabled={!dashboard || !(dashboard.chart?.points || []).length}>ייצוא CSV גרף</button>
                            </div>
                        </div>
                        {dashboardLoading ? (
                            <div className="loading">טוען...</div>
                        ) : !dashboard ? (
                            <div className="empty-state">לא נטען דשבורד</div>
                        ) : (
                            <>
                                <div className="integrity-status-panel">
                                    <div className="status-row">
                                        <span className="status-label">מצב גייט:</span>
                                        <span className={`status-badge status-${(dashboard.gate_status || '').toLowerCase()}`}>
                                            {formatGateStatus(dashboard.gate_status)}
                                        </span>
                                    </div>
                                    <div className="status-row">
                                        <span className="status-label">מחזור נוכחי:</span>
                                        <span className="status-value">{dashboard.current_cycle ?? 0}</span>
                                    </div>
                                    <div className="status-row">
                                        <span className="status-label">|𝓜| נוכחי:</span>
                                        <span className="status-value">{dashboard.current_m ?? 0}</span>
                                    </div>
                                    <div className="status-row">
                                        <span className="status-label">מחזורים מאז סגירה אחרונה:</span>
                                        <span className="status-value">{dashboard.cycles_since_last_closure ?? 0}</span>
                                    </div>
                                </div>

                                <div className="integrity-oracle-block">
                                    <h4>חיזוי סיכונים (Risk Oracle – אזהרות בלבד, לא חוסם)</h4>
                                    {oracleLoading ? (
                                        <div className="loading small">טוען...</div>
                                    ) : oracle && (oracle.risks || []).length > 0 ? (
                                        <ul className="oracle-risks-list">
                                            {(oracle.risks || []).map((r, i) => (
                                                <li key={r.id || i} className={`oracle-risk severity-${r.severity || 'low'}`}>
                                                    <span className="oracle-risk-badge">{r.severity === 'high' ? 'גבוה' : r.severity === 'medium' ? 'בינוני' : 'נמוך'}</span>
                                                    <span className="oracle-risk-message">{r.message}</span>
                                                </li>
                                            ))}
                                        </ul>
                                    ) : (
                                        <div className="oracle-no-risks">אין סיכונים מזוהים כרגע</div>
                                    )}
                                </div>

                                <div className="integrity-fil-block">
                                    <h4>FIL-01 – התראות מניתוח הפרות</h4>
                                    {filWarningsLoading ? (
                                        <div className="loading small">טוען...</div>
                                    ) : filWarnings && (filWarnings.warnings || []).length > 0 ? (
                                        <ul className="oracle-risks-list">
                                            {(filWarnings.warnings || []).map((w, i) => (
                                                <li key={w.id || i} className="oracle-risk severity-medium">
                                                    <span className="oracle-risk-badge">{w.type === 'recurring_reason' ? 'חוזר' : w.type === 'session_repeated_violations' ? 'סשן' : 'פעיל'}</span>
                                                    <span className="oracle-risk-message">{w.message}</span>
                                                </li>
                                            ))}
                                        </ul>
                                    ) : (
                                        <div className="oracle-no-risks">אין אזהרות FIL</div>
                                    )}
                                </div>

                                <div className="integrity-value-summary-block">
                                    <h4>דוח ערך (Value Summary)</h4>
                                    <div className="dashboard-filters">
                                        <div className="filter-group">
                                            <label>מתאריך</label>
                                            <input type="date" value={valueSummaryDateFrom} onChange={e => setValueSummaryDateFrom(e.target.value)} className="filter-input" />
                                        </div>
                                        <div className="filter-group">
                                            <label>עד תאריך</label>
                                            <input type="date" value={valueSummaryDateTo} onChange={e => setValueSummaryDateTo(e.target.value)} className="filter-input" />
                                        </div>
                                        <div className="filter-group">
                                            <label>מזהה סשן</label>
                                            <input type="text" value={valueSummarySessionId} onChange={e => setValueSummarySessionId(e.target.value)} placeholder="אופציונלי" className="filter-input filter-input-text" />
                                        </div>
                                        <button type="button" className="filter-apply-btn" onClick={loadValueSummary}>טען דוח</button>
                                        <button type="button" className="export-csv-btn" onClick={exportValueSummaryCsv} disabled={!valueSummary}>ייצוא CSV</button>
                                    </div>
                                    {valueSummaryLoading ? (
                                        <div className="loading small">טוען...</div>
                                    ) : valueSummary ? (
                                        <div className="value-summary-content">
                                            <div className="status-row"><span className="status-label">סה"כ ריצות:</span> <span>{valueSummary.runs?.total ?? 0}</span></div>
                                            <div className="status-row"><span className="status-label">הצלחות:</span> <span>{valueSummary.runs?.successful ?? 0}</span></div>
                                            <div className="status-row"><span className="status-label">נעצרו (הפרה):</span> <span>{valueSummary.runs?.stopped_by_violation ?? 0}</span></div>
                                            {valueSummary.duration_ms && (
                                                <div className="status-row"><span className="status-label">זמן ריצה (ממוצע/מינ/מקס ms):</span> <span>{valueSummary.duration_ms.avg_ms} / {valueSummary.duration_ms.min_ms} / {valueSummary.duration_ms.max_ms}</span></div>
                                            )}
                                            <div className="status-row"><span className="status-label">הפרות לפי סיבה:</span> <span>{JSON.stringify(valueSummary.violations_by_reason || {})}</span></div>
                                            {(valueSummary.violations || []).length > 0 && (
                                                <div className="value-summary-violations">
                                                    <strong>הפרות (reason + details):</strong>
                                                    <ul className="violations-detail-list">
                                                        {(valueSummary.violations || []).slice(0, 20).map(v => (
                                                            <li key={v.id}>
                                                                {v.reason} {v.details ? ` – ${JSON.stringify(v.details)}` : ''} (סשן: {v.session_id})
                                                            </li>
                                                        ))}
                                                    </ul>
                                                </div>
                                            )}
                                        </div>
                                    ) : null}
                                </div>

                                <div className="integrity-chart-block">
                                    <h4>|𝓜| לאורך זמן</h4>
                                    <IntegrityChart
                                        points={dashboard.chart?.points || []}
                                        violations={dashboard.chart?.violations || []}
                                        fullViolations={dashboard.violations || []}
                                        onPointClick={(p) => setViolationModal(p)}
                                        onViolationClick={(v) => setViolationModal(v)}
                                    />
                                </div>

                                <div className="integrity-charts-row">
                                    <div className="integrity-chart-block chart-half">
                                        <h4>הפרות לפי סוג</h4>
                                        <ViolationsByTypeChart violations={dashboard.violations || []} />
                                    </div>
                                    <div className="integrity-chart-block chart-half">
                                        <h4>הפרות לאורך זמן</h4>
                                        <ViolationsOverTimeChart violations={dashboard.violations || []} />
                                    </div>
                                </div>

                                <div className="integrity-violations-block">
                                    <h4>הפרות אחרונות</h4>
                                    <div className="violations-table-wrap">
                                        <table className="violations-table">
                                            <thead>
                                                <tr>
                                                    <th>תאריך</th>
                                                    <th>סוג</th>
                                                    <th>סיבה</th>
                                                    <th>סשן</th>
                                                    <th>סטטוס</th>
                                                    <th>פעולה</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {(dashboard.violations || []).map((v) => (
                                                    <tr key={v.id}>
                                                        <td>{v.created_at ? new Date(v.created_at).toLocaleString('he-IL') : '—'}</td>
                                                        <td>{v.type || '—'}</td>
                                                        <td>
                                                            <button
                                                                type="button"
                                                                className="link-like"
                                                                onClick={() => setViolationModal(v)}
                                                            >
                                                                {v.reason || '—'}
                                                            </button>
                                                        </td>
                                                        <td className="session-cell">{v.session_id ? String(v.session_id).slice(0, 8) + '…' : '—'}</td>
                                                        <td>{v.resolved_at ? 'מטופל' : 'פעיל'}</td>
                                                        <td>
                                                            {!v.resolved_at && (
                                                                <button
                                                                    type="button"
                                                                    className="unlock-button"
                                                                    onClick={() => setViolationModal({ ...v, _action: 'resolve' })}
                                                                >
                                                                    שחרר נעילה
                                                                </button>
                                                            )}
                                                        </td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                        {(!dashboard.violations || dashboard.violations.length === 0) && (
                                            <div className="empty-state small">אין הפרות</div>
                                        )}
                                    </div>
                                </div>

                                {violationModal && (
                                    <ViolationModal
                                        item={violationModal}
                                        onClose={() => { setViolationModal(null); setResolveNote(''); }}
                                        onResolve={handleResolveViolation}
                                        resolvingId={resolvingId}
                                        resolveNote={resolveNote}
                                        setResolveNote={setResolveNote}
                                    />
                                )}
                            </>
                        )}
                    </div>
                )}

                {activeSection === 'global' && (
                    <div className="global-metrics-section">
                        <h3>מדדי גלובל</h3>
                        {globalMetricsLoading ? (
                            <div className="loading">טוען...</div>
                        ) : !globalMetrics ? (
                            <div className="empty-state">לא נטענו מדדים</div>
                        ) : (
                            <div className="global-metrics-grid">
                                <div className="global-metric-card">
                                    <span className="global-metric-label">משתמשים</span>
                                    <span className="global-metric-value">{globalMetrics.users ?? 0}</span>
                                </div>
                                <div className="global-metric-card">
                                    <span className="global-metric-label">סשנים (מחקר)</span>
                                    <span className="global-metric-value">{globalMetrics.research_sessions ?? 0}</span>
                                </div>
                                <div className="global-metric-card">
                                    <span className="global-metric-label">היסטוריית חיפושים</span>
                                    <span className="global-metric-value">{globalMetrics.search_history_entries ?? 0}</span>
                                </div>
                                <div className="global-metric-card">
                                    <span className="global-metric-label">|𝓜| (מסמכים)</span>
                                    <span className="global-metric-value">{globalMetrics.document_count ?? 0}</span>
                                </div>
                                <div className="global-metric-card">
                                    <span className="global-metric-label">נקודות מחזור (B-Integrity)</span>
                                    <span className="global-metric-value">{globalMetrics.integrity_cycle_snapshots ?? 0}</span>
                                </div>
                                <div className="global-metric-card">
                                    <span className="global-metric-label">הפרות (סה״כ)</span>
                                    <span className="global-metric-value">{globalMetrics.violations_total ?? 0}</span>
                                </div>
                                <div className="global-metric-card highlight">
                                    <span className="global-metric-label">הפרות פעילות</span>
                                    <span className="global-metric-value">{globalMetrics.violations_active ?? 0}</span>
                                </div>
                                <div className="global-metric-card">
                                    <span className="global-metric-label">הפרות מטופלות</span>
                                    <span className="global-metric-value">{globalMetrics.violations_resolved ?? 0}</span>
                                </div>
                                <div className="global-metric-card">
                                    <span className="global-metric-label">תמונות מצב (Snapshots)</span>
                                    <span className="global-metric-value">{globalMetrics.system_snapshots ?? 0}</span>
                                </div>
                                <div className="global-metric-card">
                                    <span className="global-metric-label">ריצות Research Loop</span>
                                    <span className="global-metric-value">{globalMetrics.research_loop_runs ?? 0}</span>
                                </div>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}

function IntegrityChart({ points, violations, fullViolations, onPointClick, onViolationClick }) {
    const [hoveredIndex, setHoveredIndex] = React.useState(null);

    if (!points.length) {
        return <div className="chart-empty">אין עדיין נתוני מחזורים</div>;
    }
    const values = points.map(p => p.value);
    let minV = Math.min(...values);
    let maxV = Math.max(...values);
    const flat = minV === maxV;
    if (flat) {
        minV = Math.min(0, minV - 1);
        maxV = maxV + 1;
    }
    const range = maxV - minV || 1;
    const height = 260;
    const width = Math.max(480, points.length * 24);
    const padding = { top: 28, right: 32, bottom: 44, left: 52 };
    const chartW = width - padding.left - padding.right;
    const chartH = height - padding.top - padding.bottom;
    const xScale = (i) => padding.left + (i / (points.length - 1 || 1)) * chartW;
    const yScale = (val) => padding.top + chartH - ((val - minV) / range) * chartH;

    const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xScale(i)} ${yScale(p.value)}`).join(' ');
    const violationByIndex = {};
    const fullById = (fullViolations || []).reduce((acc, f) => { acc[f.id] = f; return acc; }, {});
    (violations || []).forEach((v) => {
        if (!v.t) return;
        const pointTimes = points.map(p => new Date(p.t).getTime());
        const vTime = new Date(v.t).getTime();
        let best = 0;
        let bestDiff = Math.abs(pointTimes[0] - vTime);
        pointTimes.forEach((t, i) => {
            const d = Math.abs(t - vTime);
            if (d < bestDiff) { bestDiff = d; best = i; }
        });
        violationByIndex[best] = fullById[v.id] || v;
    });

    const yTicks = 5;
    const yTickValues = [];
    for (let i = 0; i <= yTicks; i++) {
        yTickValues.push(minV + (range * i) / yTicks);
    }
    const xTickStep = Math.max(1, Math.floor(points.length / 8));
    const xTickIndices = [];
    for (let i = 0; i < points.length; i += xTickStep) xTickIndices.push(i);
    if (points.length - 1 !== xTickIndices[xTickIndices.length - 1]) xTickIndices.push(points.length - 1);

    const hoveredPoint = hoveredIndex != null ? points[hoveredIndex] : null;
    const tooltipLeftPct = hoveredIndex != null ? (xScale(hoveredIndex) / width) * 100 : 0;
    const tooltipTopPct = hoveredPoint != null ? (yScale(hoveredPoint.value) / height) * 100 : 0;
    const showTooltipBelow = tooltipTopPct < 35;

    return (
        <div className="integrity-chart-wrap">
            {hoveredPoint && (
                <div className="chart-tooltip" style={{
                    left: `${tooltipLeftPct}%`,
                    top: `${tooltipTopPct}%`,
                    transform: showTooltipBelow ? 'translate(-50%, 0) translateY(12px)' : 'translate(-50%, -100%) translateY(-12px)'
                }}>
                    <div className="chart-tooltip-row"><strong>מחזור:</strong> {hoveredIndex + 1}</div>
                    <div className="chart-tooltip-row"><strong>|𝓜|:</strong> {hoveredPoint.value}</div>
                    <div className="chart-tooltip-row"><strong>תאריך:</strong> {hoveredPoint.t ? new Date(hoveredPoint.t).toLocaleString('he-IL') : '—'}</div>
                    {violationByIndex[hoveredIndex] && <div className="chart-tooltip-badge">הפרה</div>}
                </div>
            )}
            <svg className="integrity-chart" width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
                {/* Grid lines */}
                {yTickValues.map((v, i) => (
                    <line key={`hy-${i}`} className="chart-grid" x1={padding.left} y1={yScale(v)} x2={padding.left + chartW} y2={yScale(v)} />
                ))}
                {xTickIndices.map((i) => (
                    <line key={`vx-${i}`} className="chart-grid" x1={xScale(i)} y1={padding.top} x2={xScale(i)} y2={padding.top + chartH} />
                ))}
                {/* Y-axis labels */}
                {yTickValues.map((v, i) => (
                    <text key={`yt-${i}`} className="chart-axis-label" x={padding.left - 8} y={yScale(v)} textAnchor="end" dominantBaseline="middle">{Math.round(v)}</text>
                ))}
                <text x={14} y={padding.top + chartH / 2} className="chart-axis-title" textAnchor="middle" transform={`rotate(-90, 14, ${padding.top + chartH / 2})`}>|𝓜|</text>
                {/* X-axis labels */}
                {xTickIndices.map((i) => (
                    <text key={`xt-${i}`} className="chart-axis-label" x={xScale(i)} y={height - 14} textAnchor="middle">{i + 1}</text>
                ))}
                <text x={padding.left + chartW / 2} y={height - 4} className="chart-axis-title" textAnchor="middle">מחזור</text>
                {/* Line and points */}
                <path className="chart-line" d={pathD} fill="none" strokeWidth="2" />
                {points.map((p, i) => {
                    const violation = violationByIndex[i];
                    return (
                        <circle
                            key={i}
                            className={violation ? 'chart-point violation-point' : 'chart-point'}
                            cx={xScale(i)}
                            cy={yScale(p.value)}
                            r={violation ? 6 : 5}
                            onClick={() => violation ? onViolationClick(violation) : onPointClick(p)}
                            onMouseEnter={() => setHoveredIndex(i)}
                            onMouseLeave={() => setHoveredIndex(null)}
                        />
                    );
                })}
            </svg>
        </div>
    );
}

function ViolationsByTypeChart({ violations }) {
    const byType = (violations || []).reduce((acc, v) => {
        const t = v.type || 'אחר';
        acc[t] = (acc[t] || 0) + 1;
        return acc;
    }, {});
    const entries = Object.entries(byType).sort((a, b) => b[1] - a[1]);
    if (!entries.length) return <div className="chart-empty">אין הפרות להצגה</div>;
    const maxCount = Math.max(...entries.map(([, c]) => c));
    const height = 220;
    const barHeight = 28;
    const gap = 8;
    const padding = { left: 120, right: 24, top: 8, bottom: 8 };
    const chartW = 280;
    const width = padding.left + chartW + padding.right;
    return (
        <div className="integrity-chart-wrap violations-by-type-chart">
            <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
                {entries.map(([type, count], i) => {
                    const y = padding.top + i * (barHeight + gap);
                    const barW = maxCount ? (count / maxCount) * chartW : 0;
                    return (
                        <g key={type}>
                            <text x={padding.left - 8} y={y + barHeight / 2} textAnchor="end" dominantBaseline="middle" className="chart-axis-label">{type}</text>
                            <rect x={padding.left} y={y} width={barW} height={barHeight} rx="4" className="chart-bar" />
                            <text x={padding.left + barW + 6} y={y + barHeight / 2} dominantBaseline="middle" className="chart-axis-label">{count}</text>
                        </g>
                    );
                })}
            </svg>
        </div>
    );
}

function ViolationsOverTimeChart({ violations }) {
    const withDate = (violations || []).filter(v => v.created_at).map(v => ({
        ...v,
        date: new Date(v.created_at).toISOString().slice(0, 10)
    }));
    const byDate = withDate.reduce((acc, v) => {
        acc[v.date] = (acc[v.date] || 0) + 1;
        return acc;
    }, {});
    const sortedDates = Object.keys(byDate).sort();
    if (!sortedDates.length) return <div className="chart-empty">אין הפרות להצגה</div>;
    const counts = sortedDates.map(d => byDate[d]);
    const maxCount = Math.max(...counts);
    const height = 220;
    const width = Math.max(400, sortedDates.length * 32);
    const padding = { top: 24, right: 24, bottom: 36, left: 40 };
    const chartW = width - padding.left - padding.right;
    const chartH = height - padding.top - padding.bottom;
    const barW = Math.max(4, (chartW / sortedDates.length) - 4);
    const yScale = (val) => padding.top + chartH - (maxCount ? (val / maxCount) * chartH : 0);
    return (
        <div className="integrity-chart-wrap violations-over-time-chart">
            <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
                {counts.map((c, i) => (
                    <line key={i} className="chart-grid" x1={padding.left + (i + 0.5) * (chartW / counts.length)} y1={padding.top} x2={padding.left + (i + 0.5) * (chartW / counts.length)} y2={padding.top + chartH} />
                ))}
                {[0, 0.25, 0.5, 0.75, 1].map((pct, i) => (
                    <text key={i} className="chart-axis-label" x={padding.left - 6} y={yScale(maxCount * pct)} textAnchor="end" dominantBaseline="middle">{Math.round(maxCount * pct)}</text>
                ))}
                <text x={14} y={padding.top + chartH / 2} className="chart-axis-title" textAnchor="middle" transform={`rotate(-90, 14, ${padding.top + chartH / 2})`}>מס׳ הפרות</text>
                {sortedDates.map((d, i) => (
                    <text key={d} className="chart-axis-label" x={padding.left + (i + 0.5) * (chartW / sortedDates.length)} y={height - 12} textAnchor="middle">{d.slice(5)}</text>
                ))}
                {counts.map((c, i) => (
                    <rect
                        key={i}
                        className="chart-bar"
                        x={padding.left + i * (chartW / counts.length) + 2}
                        y={yScale(c)}
                        width={barW}
                        height={chartH - (yScale(c) - padding.top)}
                        rx="4"
                    />
                ))}
            </svg>
        </div>
    );
}

function ViolationModal({ item, onClose, onResolve, resolvingId, resolveNote, setResolveNote }) {
    const v = item && item.id ? item : null;

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-content integrity-modal" onClick={e => e.stopPropagation()}>
                <div className="modal-header">
                    <h4>{v ? 'פרטי הפרה' : 'נקודת מחזור'}</h4>
                    <button type="button" className="modal-close" onClick={onClose} aria-label="סגור">×</button>
                </div>
                <div className="modal-body">
                    {v && (
                        <>
                            <p><strong>מזהה:</strong> {v.id}</p>
                            <p><strong>סשן:</strong> {v.session_id}</p>
                            <p><strong>סוג:</strong> {v.type}</p>
                            <p><strong>סיבה:</strong> {v.reason}</p>
                            {v.details && <p><strong>פרטים:</strong> <pre>{JSON.stringify(v.details, null, 2)}</pre></p>}
                            <p><strong>נוצר:</strong> {v.created_at ? new Date(v.created_at).toLocaleString('he-IL') : '—'}</p>
                            {v.resolved_at && (
                                <p><strong>טופל:</strong> {v.resolved_at ? new Date(v.resolved_at).toLocaleString('he-IL') : '—'} {v.resolve_note && ` – ${v.resolve_note}`}</p>
                            )}
                            {!v.resolved_at && (
                                <div className="resolve-form">
                                    <label>הערה לשחרור (אופציונלי):</label>
                                    <input type="text" value={resolveNote} onChange={e => setResolveNote(e.target.value)} placeholder="הערה..." />
                                    <button type="button" className="unlock-button" disabled={resolvingId === v.id} onClick={() => onResolve(v.id)}>
                                        {resolvingId === v.id ? 'משחרר...' : 'אישור שחרור / Unlock'}
                                    </button>
                                </div>
                            )}
                        </>
                    )}
                    {!v && item && (
                        <p>מחזור: {item.cycle_index != null ? item.cycle_index : '—'} | ערך: {item.value} | תאריך: {item.t ? new Date(item.t).toLocaleString('he-IL') : '—'}</p>
                    )}
                </div>
            </div>
        </div>
    );
}

export default AdminTab;
