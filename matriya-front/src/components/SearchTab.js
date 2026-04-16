import React, { useState, useCallback, useEffect } from 'react';
import api from '../utils/api';
import { formatBoldSegments } from '../utils/formatBold';
import GptSyncStatusRow from './GptSyncStatusRow';
import AnswerEvidenceSection from './AnswerEvidenceSection';
import AnswerView from './answerComposer/AnswerView';
import { isAnswerComposerPayload } from '../utils/isAnswerComposerPayload';
import JsonViewer from './JsonViewer';
import './SearchTab.css';

const SEARCH_EVIDENCE_TITLE = 'מקורות מהמסמכים (ציטוטים)';
const SEARCH_EVIDENCE_HINT = 'קטעים ששימשו כבסיס לתשובה — לשקיפות וביקורת.';
/** Same scope label as UploadTab — search uses the same document list (`/files/detail`). */
const ALL_DOCUMENTS_SCOPE_LABEL =
    'כל הקבצים (מאגר מסונכרן — מקורות לפי קטעים שנמשכו)';

const RESEARCH_STAGES = [
    { id: 'K', label: 'K', desc: 'מידע קיים בלבד (ללא פתרונות)' },
    { id: 'C', label: 'C', desc: 'מידע מאומת (ללא פתרונות)' },
    { id: 'B', label: 'B', desc: 'עצירה קשיחה בלבד' },
    { id: 'N', label: 'N', desc: 'מותר רק אחרי B' },
    { id: 'L', label: 'L', desc: 'מותר רק אחרי N' }
];

function SearchTab({ onGptSyncingChange, gptRagSyncing = false }) {
    const [query, setQuery] = useState('');
    const [selectedFile, setSelectedFile] = useState('');
    /** Same source as UploadTab: `GET /files/detail` rows `{ filename, ... }`. */
    const [documentFiles, setDocumentFiles] = useState([]);
    const [isLoadingFiles, setIsLoadingFiles] = useState(true);
    const [results, setResults] = useState(null);
    const [isSearching, setIsSearching] = useState(false);
    const [error, setError] = useState(null);
    const [agentAnalysis, setAgentAnalysis] = useState(null);
    const [isAnalyzing, setIsAnalyzing] = useState(false);
    const [researchStage, setResearchStage] = useState(null);
    const [sessionId, setSessionId] = useState(null);
    const [sessionLoading, setSessionLoading] = useState(true);
    const [answerMode, setAnswerMode] = useState('quick'); // 'quick' = GET /search (stage required) | 'agents' = POST /api/research/run (4 agents)
    /** quick only: 'research' | 'document' | 'lab' — default 'lab' so Answer Composer is visible first (David). */
    const [searchFlowMode, setSearchFlowMode] = useState('lab');
    /** True when the last completed request was flow=lab (for mismatch UI if API is old). */
    const [lastResultsFromLab, setLastResultsFromLab] = useState(false);
    /** flow=lab → POST composeAnswer-shaped JSON (BASE-003 style). */
    const [labQueryType, setLabQueryType] = useState('version_comparison');
    const [labBaseId, setLabBaseId] = useState('BASE-003');
    const [labVersionA, setLabVersionA] = useState('003.1');
    const [labVersionB, setLabVersionB] = useState('003.2');
    const [labIdA, setLabIdA] = useState('27.10.2022');
    const [labIdB, setLabIdB] = useState('28.09.2023');
    const [preJustification, setPreJustification] = useState('');
    /** Kernel v1.6 – optional JSON (POST /api/research/search when any block is non-empty). */
    const [kernelSignalsJson, setKernelSignalsJson] = useState('');
    const [dataAnchorsJson, setDataAnchorsJson] = useState('');
    const [methodologyFlagsJson, setMethodologyFlagsJson] = useState('');
    const [showKernelAdvanced, setShowKernelAdvanced] = useState(false);

    // Create research session on mount – required for every question (session_id + stage)
    useEffect(() => {
        let isMounted = true;
        const createSession = async () => {
            setSessionLoading(true);
            try {
                const res = await api.post('/research/session', {}, { timeout: 10000 });
                if (isMounted && res.data?.session_id) setSessionId(res.data.session_id);
            } catch (err) {
                if (isMounted) setError('לא ניתן ליצור סשן מחקר. נא לרענן את הדף.');
            } finally {
                if (isMounted) setSessionLoading(false);
            }
        };
        createSession();
        return () => { isMounted = false; };
    }, []);

    const handleSearch = async () => {
        if (gptRagSyncing) return;
        const quickResearch = answerMode === 'quick' && searchFlowMode === 'research';
        if (answerMode === 'agents' && !sessionId) {
            setError('סשן מחקר לא זמין. נא לרענן את הדף.');
            return;
        }
        if (quickResearch && !sessionId) {
            setError('סשן מחקר לא זמין. נא לרענן את הדף.');
            return;
        }
        if (quickResearch && !researchStage) {
            setError('נא לבחור שלב מחקר (K, C, B, N או L) לפני שליחת השאלה');
            return;
        }
        if (!query.trim()) {
            setError('אנא הכנס שאילתת חיפוש');
            return;
        }

        setIsSearching(true);
        setError(null);
        setResults(null);
        setLastResultsFromLab(false);

        const parseJsonField = (label, raw) => {
            const t = (raw || '').trim();
            if (!t) return { ok: true, value: null };
            try {
                return { ok: true, value: JSON.parse(t) };
            } catch {
                return { ok: false, error: `${label}: JSON לא תקין` };
            }
        };

        try {
            if (answerMode === 'agents') {
                const body = {
                    session_id: sessionId,
                    query: query.trim(),
                    use_4_agents: true
                };
                if (selectedFile) body.filename = selectedFile;
                if (preJustification && preJustification.trim()) body.pre_justification = preJustification.trim();
                const response = await api.post('/api/research/run', body, { timeout: 120000 });
                const data = response.data;
                setLastResultsFromLab(false);
                setResults({
                    answer: data.outputs?.synthesis || data.outputs?.research || data.outputs?.analysis || '',
                    use_4_agents: true,
                    outputs: data.outputs,
                    justifications: data.justifications,
                    stopped_by_violation: data.stopped_by_violation,
                    violation_id: data.violation_id,
                    message: data.message,
                    run_id: data.run_id,
                    duration_ms: data.duration_ms,
                    results_count: 0,
                    results: [],
                    sources: Array.isArray(data.sources) ? data.sources : []
                });
                } else if (searchFlowMode === 'lab') {
                    const response = await api.post(
                        '/api/research/search',
                        {
                            query: query.trim(),
                            generate_answer: true,
                            flow: 'lab',
                            lab_query_type: (labQueryType || 'version_comparison').trim(),
                            base_id: (labBaseId || 'BASE-003').trim(),
                            version_a: (labVersionA || '003.1').trim(),
                            version_b: (labVersionB || '003.2').trim(),
                            id_a: (labIdA || '').trim(),
                            id_b: (labIdB || '').trim(),
                        },
                        { timeout: 120000 }
                    );
                    const queryResult = response.data;
                    // David Step 1 — verify API in DevTools → Console
                    console.log('[Lab] queryResult', queryResult);
                    if (typeof window !== 'undefined') {
                        window.__MATRIYA_LAB_QUERY_RESULT = queryResult;
                    }
                    setLastResultsFromLab(true);
                    setResults(queryResult);
                } else {
                const ks = parseJsonField('אותות קרנל (kernel_signals)', kernelSignalsJson);
                const da = parseJsonField('עוגני נתונים', dataAnchorsJson);
                const mf = parseJsonField('דגלי מתודולוגיה', methodologyFlagsJson);
                if (!ks.ok) {
                    setError(ks.error);
                    setIsSearching(false);
                    return;
                }
                if (!da.ok) {
                    setError(da.error);
                    setIsSearching(false);
                    return;
                }
                if (!mf.ok) {
                    setError(mf.error);
                    setIsSearching(false);
                    return;
                }

                const useKernelPost =
                    ks.value != null || da.value != null || mf.value != null;

                if (useKernelPost) {
                    const body = {
                        query: query.trim(),
                        generate_answer: true,
                        stage: researchStage,
                        session_id: sessionId,
                        flow: 'research'
                    };
                    if (selectedFile) body.filename = selectedFile;
                    if (ks.value != null) body.kernel_signals = ks.value;
                    if (da.value != null) body.data_anchors = da.value;
                    if (mf.value != null) body.methodology_flags = mf.value;

                    const response = await api.post('/api/research/search', body, { timeout: 60000 });
                    const data = response.data;
                    setLastResultsFromLab(false);
                    setResults(data);
                    if (data.session_id) setSessionId(data.session_id);
                } else {
                    const params = {
                        query: query.trim(),
                        generate_answer: true
                    };
                    if (searchFlowMode === 'document') {
                        params.flow = 'document';
                    } else {
                        params.stage = researchStage;
                        params.session_id = sessionId;
                    }
                    if (selectedFile) params.filename = selectedFile;

                    const response = await api.get('/search', {
                        params,
                        timeout: 60000
                    });

                    const data = response.data;
                    setLastResultsFromLab(false);
                    setResults(data);
                    if (data.session_id) setSessionId(data.session_id);
                }
            }
        } catch (err) {
            const data = err.response?.data;
            const msg = data?.error || data?.detail || err.message;
            if (searchFlowMode === 'lab' && data && typeof data === 'object') {
                console.log('[Lab] queryResult (error response body)', data);
                if (typeof window !== 'undefined') {
                    window.__MATRIYA_LAB_QUERY_RESULT = data;
                }
                setLastResultsFromLab(true);
                setResults(data);
                if (!isAnswerComposerPayload(data)) {
                    setError(
                        'Lab returned JSON that is NOT Answer Composer shape. Point REACT_APP_API_BASE_URL to your local matriya-back (e.g. http://localhost:8000) with the latest code, then restart npm start.'
                    );
                } else {
                    setError(null);
                }
            } else if (err.response?.status === 409 && data?.research_gate_locked) {
                setError(`שער נעול (Kernel Lock): ${msg} נדרש Recovery לפני המשך.`);
            } else if (err.response?.status === 409 && data?.possibility_shutdown) {
                setError(`${msg || 'סגירת מרחב אפשרויות — מסלול 4 סוכנים חסום.'}`);
            } else {
                setError(data?.research_stage_error ? msg : (msg || 'שגיאה בחיפוש'));
            }
        } finally {
            setIsSearching(false);
        }
    };

    const handleKeyPress = (e) => {
        if (e.key === 'Enter') {
            handleSearch();
        }
    };

    const loadDocumentFiles = useCallback(async () => {
        setIsLoadingFiles(true);
        try {
            const response = await api.get('/files/detail', { timeout: 15000 });
            const files = Array.isArray(response.data?.files) ? response.data.files : [];
            setDocumentFiles(files);
        } catch (err) {
            console.error('Error loading files:', err);
            setDocumentFiles([]);
            setError('שגיאה בטעינת רשימת הקבצים');
        } finally {
            setIsLoadingFiles(false);
        }
    }, []);

    useEffect(() => {
        loadDocumentFiles();
    }, [loadDocumentFiles]);

    // David Step 2 — confirm React state after setResults (same object as console above)
    useEffect(() => {
        if (results && lastResultsFromLab) {
            console.log('[Lab] queryResult (React state)', results);
        }
    }, [results, lastResultsFromLab]);

    const handleAgentCheck = async (agentType) => {
        if (isAnswerComposerPayload(results)) {
            setError('מסלול Answer Composer (Lab) אינו תומך בבדיקת סוכן — אין שינוי החלטה ב-UI.');
            return;
        }
        if (!results || !results.answer) {
            setError('לא ניתן לבדוק ללא תשובה');
            return;
        }
        
        // Check if we have context or can build it from results
        const hasContext = results.context || (results.results && results.results.length > 0);
        if (!hasContext) {
            setError('לא ניתן לבדוק ללא הקשר - אנא נסה שוב את החיפוש');
            return;
        }

        setIsAnalyzing(true);
        setAgentAnalysis(null);
        setError(null);

        try {
            const endpoint = agentType === 'contradiction' 
                ? '/agent/contradiction' 
                : '/agent/risk';
            
            // Use query from state if not in results
            const queryToUse = results.query || query;
            
            // Build context from search results if context is empty
            let contextToUse = results.context;
            if (!contextToUse && results.results && results.results.length > 0) {
                // Reconstruct context from search results
                contextToUse = results.results.map((result, index) => {
                    const docText = result.document || result.text || '';
                    const filename = result.metadata?.filename || 'לא ידוע';
                    return `[Source ${index + 1} from ${filename}]:\n${docText}\n`;
                }).join('\n');
            }
            
            const response = await api.post(endpoint, {
                answer: results.answer,
                context: contextToUse || '',
                query: queryToUse
            }, {
                timeout: 30000  // 30 second timeout for agent checks
            });

            setAgentAnalysis({
                type: agentType,
                ...response.data
            });
        } catch (err) {
            setError(err.response?.data?.detail || err.message || `שגיאה בבדיקת ${agentType === 'contradiction' ? 'סתירות' : 'סיכונים'}`);
        } finally {
            setIsAnalyzing(false);
        }
    };

    const composerPayload = results && isAnswerComposerPayload(results);
    const labMismatch = results && lastResultsFromLab && !composerPayload;
    const legacyResults = results && !composerPayload && !labMismatch;

    return (
        <div className="search-tab">
                <div className="card">
                <h2>{searchFlowMode === 'lab' ? 'מעבדה — לוח החלטות (Answer Composer)' : 'חיפוש במסמכים'}</h2>
                <GptSyncStatusRow
                    filenames={documentFiles.map((f) => f.filename)}
                    onSyncComplete={loadDocumentFiles}
                    onSyncingChange={onGptSyncingChange}
                    className="search-tab-gpt-sync"
                />

                <div className="answer-mode-section">
                    <h3 className="stage-heading">אופן תשובה</h3>
                    <div className="mode-buttons">
                        <button
                            type="button"
                            className={`mode-button ${answerMode === 'quick' ? 'active' : ''}`}
                            onClick={() => setAnswerMode('quick')}
                            title="תשובה אחת מהירה (שלב מחקר K→C→B→N→L)"
                        >
                            סוכני מחקר
                        </button>
                        <button
                            type="button"
                            className={`mode-button ${answerMode === 'agents' ? 'active' : ''}`}
                            onClick={() => setAnswerMode('agents')}
                            title="4 סוכנים: ניתוח → מחקר → ביקורת → סינתזה"
                        >
                            4 סוכנים
                        </button>
                    </div>
                        <p className="stage-hint">
                        {answerMode === 'quick'
                            ? 'תשובה אחת מהירה לפי שלב מחקר (K→C→B→N→L).'
                            : 'שרשרת ארבעה סוכנים (ניתוח → מחקר → ביקורת → סינתזה) עם ניטור שלמות.'}
                    </p>
                </div>

                {answerMode === 'quick' && (
                    <div className="answer-mode-section">
                        <h3 className="stage-heading">סוג זרימה</h3>
                        <div className="mode-buttons">
                            <button
                                type="button"
                                className={`mode-button ${searchFlowMode === 'research' ? 'active' : ''}`}
                                onClick={() => setSearchFlowMode('research')}
                                title="שער מחקר, pre-LLM, קרנל — לשאלות ניסוי / ניתוח"
                            >
                                ניתוח מחקר
                            </button>
                            <button
                                type="button"
                                className={`mode-button ${searchFlowMode === 'document' ? 'active' : ''}`}
                                onClick={() => setSearchFlowMode('document')}
                                title="חיפוש והסקה ממסמכים בלבד — ללא FSM"
                            >
                                חיפוש מסמך
                            </button>
                            <button
                                type="button"
                                className={`mode-button ${searchFlowMode === 'lab' ? 'active' : ''}`}
                                onClick={() => setSearchFlowMode('lab')}
                                title="Lab Chain — תשובת Answer Composer בלבד (ללא RAG)"
                            >
                                מעבדה (Lab)
                            </button>
                        </div>
                        <p className="stage-hint">
                            {searchFlowMode === 'document'
                                ? 'שליפה מהמאגר והסקה ממסמכים בלבד — בלי מכונת מצבים מלאה של המחקר.'
                                : searchFlowMode === 'lab'
                                  ? 'הבקשה נשלחת לשרת עם flow=lab — מבנה התשובה הוא לפי Answer Composer (נתוני מעבדה מובנים).'
                                  : 'מסלול מחקר מלא: סשן, שלב K→L, שער ראיות לפני המודל, וקרנל.'}
                        </p>
                    </div>
                )}

                {answerMode === 'quick' && searchFlowMode === 'lab' && (
                    <div className="answer-mode-section lab-bridge-fields">
                        <h3 className="stage-heading">פרמטרים למעבדה (Lab Chain)</h3>
                        <div className="lab-field-grid">
                            {/* Query type — always shown; drives which fields appear below */}
                            <label className="lab-field">
                                <span className="lab-field-label">lab_query_type</span>
                                <select
                                    className="search-input"
                                    value={labQueryType}
                                    onChange={(e) => setLabQueryType(e.target.value)}
                                >
                                    <option value="version_comparison">version_comparison</option>
                                    <option value="formulation_delta">formulation_delta</option>
                                </select>
                            </label>

                            {/* base_id — shown for both types (optional scope filter) */}
                            <label className="lab-field">
                                <span className="lab-field-label">
                                    base_id
                                    {labQueryType === 'formulation_delta' && (
                                        <span className="lab-field-optional"> (אופציונלי)</span>
                                    )}
                                </span>
                                <input
                                    className="search-input"
                                    value={labBaseId}
                                    onChange={(e) => setLabBaseId(e.target.value)}
                                    placeholder="BASE-003"
                                />
                            </label>

                            {/* version_comparison fields — hidden for formulation_delta */}
                            {labQueryType === 'version_comparison' && (
                                <>
                                    <label className="lab-field">
                                        <span className="lab-field-label">version_a</span>
                                        <input
                                            className="search-input"
                                            value={labVersionA}
                                            onChange={(e) => setLabVersionA(e.target.value)}
                                            placeholder="003.1"
                                        />
                                    </label>
                                    <label className="lab-field">
                                        <span className="lab-field-label">version_b</span>
                                        <input
                                            className="search-input"
                                            value={labVersionB}
                                            onChange={(e) => setLabVersionB(e.target.value)}
                                            placeholder="003.2"
                                        />
                                    </label>
                                </>
                            )}

                            {/* formulation_delta fields — hidden for version_comparison */}
                            {labQueryType === 'formulation_delta' && (
                                <>
                                    <label className="lab-field">
                                        <span className="lab-field-label">id_a (date or source_id)</span>
                                        <input
                                            className="search-input"
                                            value={labIdA}
                                            onChange={(e) => setLabIdA(e.target.value)}
                                            placeholder="27.10.2022 or 27.10.2022-001"
                                        />
                                    </label>
                                    <label className="lab-field">
                                        <span className="lab-field-label">id_b (date or source_id)</span>
                                        <input
                                            className="search-input"
                                            value={labIdB}
                                            onChange={(e) => setLabIdB(e.target.value)}
                                            placeholder="28.09.2023 or 28.09.2023-017"
                                        />
                                    </label>
                                </>
                            )}
                        </div>
                        <p className="stage-hint">
                            {labQueryType === 'formulation_delta'
                                ? 'השוואת פורמולציות: id_a ו-id_b יכולים להיות תאריך (27.10.2022) או source_id מלא.'
                                : 'השוואת גרסאות: base_id + version_a + version_b נדרשים.'}
                        </p>
                    </div>
                )}

                {answerMode === 'agents' && (
                    <div className="pre-justification-section" style={{ marginBottom: '12px' }}>
                        <label className="stage-hint">הצדקה לפני ריצה (אופציונלי – נשמר עם הריצה):</label>
                        <textarea
                            value={preJustification}
                            onChange={(e) => setPreJustification(e.target.value)}
                            placeholder="תיעוד סיבת הריצה..."
                            rows={2}
                            className="search-input"
                            style={{ width: '100%', minHeight: '50px', resize: 'vertical' }}
                        />
                    </div>
                )}

                {answerMode === 'quick' && searchFlowMode === 'research' && (
                    <div className="research-stage-section">
                        {sessionLoading && (
                            <p className="stage-hint" style={{ color: '#a0a0c0' }}>יוצר סשן מחקר...</p>
                        )}
                        <h3 className="stage-heading">שלב מחקר (חובה)</h3>
                        <p className="stage-hint">יש לבחור שלב לפני שליחת שאלה. מעבר שלבים: K → C → B → N → L</p>
                        <div className="stage-buttons">
                            {RESEARCH_STAGES.map((s) => (
                                <button
                                    key={s.id}
                                    type="button"
                                    className={`stage-button ${researchStage === s.id ? 'active' : ''}`}
                                    onClick={() => setResearchStage(s.id)}
                                    title={s.desc}
                                >
                                    {s.label}
                                </button>
                            ))}
                        </div>
                        {researchStage && (
                            <span className="stage-desc">
                                {RESEARCH_STAGES.find((s) => s.id === researchStage)?.desc}
                            </span>
                        )}
                        <div className="kernel-v16-advanced">
                            <button
                                type="button"
                                className="kernel-advanced-toggle"
                                onClick={() => setShowKernelAdvanced((v) => !v)}
                            >
                                <span key={showKernelAdvanced ? 'open' : 'closed'}>
                                    {showKernelAdvanced ? '▼' : '▶'} קרנל v1.6 (אופציונלי): אותות / עוגנים / מתודולוגיה
                                </span>
                            </button>
                            {showKernelAdvanced && (
                                <div className="kernel-advanced-fields">
                                    <p className="stage-hint">
                                        עוגן נתונים מותר בלבד: <code>experiment_snapshot</code>,{' '}
                                        <code>similar_experiments</code>, <code>failure_patterns</code>. לשלב N עם
                                        אותות: זיהוי שבירה (מודלים / OOD / שאריות / נקודת שינוי). לשלב L:{' '}
                                        <code>l_validation</code> עם ≥3 הרצות, שיפור מול baseline, יציבות.
                                    </p>
                                    <label className="kernel-json-label">kernel_signals (JSON)</label>
                                    <textarea
                                        className="search-input kernel-json-textarea"
                                        rows={4}
                                        value={kernelSignalsJson}
                                        onChange={(e) => setKernelSignalsJson(e.target.value)}
                                        placeholder='{"model_fits":{"linear":{"ok":false},"polynomial":{"ok":false},"piecewise":{"ok":false}}}'
                                    />
                                    <label className="kernel-json-label">data_anchors (JSON)</label>
                                    <textarea
                                        className="search-input kernel-json-textarea"
                                        rows={3}
                                        value={dataAnchorsJson}
                                        onChange={(e) => setDataAnchorsJson(e.target.value)}
                                        placeholder='{"experiment_snapshot":{},"similar_experiments":[],"failure_patterns":[]}'
                                    />
                                    <label className="kernel-json-label">methodology_flags (JSON)</label>
                                    <textarea
                                        className="search-input kernel-json-textarea"
                                        rows={2}
                                        value={methodologyFlagsJson}
                                        onChange={(e) => setMethodologyFlagsJson(e.target.value)}
                                        placeholder='{"repeated_solution":false,"patches_without_hypothesis":false}'
                                    />
                                </div>
                            )}
                        </div>
                    </div>
                )}

                <div className="search-box">
                    <input
                        type="text"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        onKeyPress={handleKeyPress}
                        placeholder="הכנס שאילתת חיפוש..."
                        className="search-input"
                        disabled={gptRagSyncing}
                    />
                    <button
                        onClick={handleSearch}
                        disabled={
                            gptRagSyncing ||
                            isSearching ||
                            (sessionLoading && !(answerMode === 'quick' && searchFlowMode === 'lab')) ||
                            (answerMode === 'agents' && !sessionId) ||
                            (answerMode === 'quick' &&
                                searchFlowMode === 'research' &&
                                (!sessionId || !researchStage))
                        }
                        className={`search-button ${isSearching ? 'loading' : ''}`}
                    >
                        {isSearching ? (
                            <span key="searching" className="btn-inner">
                                <span className="spinner"></span>
                                <span>מחפש...</span>
                            </span>
                        ) : (
                            <span key="idle" className="btn-inner">
                                <span>חפש</span>
                            </span>
                        )}
                    </button>
                </div>
                <div className="search-options">
                    <label>
                        חיפוש במסמך:
                        <select
                            value={selectedFile}
                            onChange={(e) => setSelectedFile(e.target.value)}
                            className="file-select"
                            disabled={isLoadingFiles}
                        >
                            {isLoadingFiles ? (
                                <option value="">טוען קבצים...</option>
                            ) : documentFiles.length === 0 ? (
                                <option value="">אין קבצים זמינים</option>
                            ) : (
                                <>
                                    <option value="">{ALL_DOCUMENTS_SCOPE_LABEL}</option>
                                    {documentFiles.map((f) => (
                                        <option key={f.filename} value={f.filename}>
                                            {f.filename}
                                        </option>
                                    ))}
                                </>
                            )}
                        </select>
                        {isLoadingFiles && (
                            <span className="file-loading-spinner"></span>
                        )}
                    </label>
                </div>

                {error && (
                    <div className="error-message">
                        {error}
                    </div>
                )}

                {isSearching && (
                    <div className="loading">
                        <div>מחפש במסמכים...</div>
                        <div style={{ marginTop: '15px', fontSize: '0.95em', color: '#a0a0c0' }}>
                            {answerMode === 'agents'
                                ? '🤖 מריץ 4 סוכנים (ניתוח → מחקר → ביקורת → סינתזה)...'
                                : searchFlowMode === 'lab'
                                  ? 'מעבדה — שולח שאילתה לשרת (מסלול מעבדה)…'
                                  : 'מייצר תשובה חכמה…'}
                        </div>
                    </div>
                )}

                {results && (
                    <div className="search-results" id="lab-answer-composer-root">
                        {/* David Step 3 — same fields as AnswerView; state variable is `results` (= queryResult after Search) */}
                        {composerPayload && <AnswerView data={results} />}
                        {labMismatch && (
                            <div className="lab-composer-mismatch" role="alert">
                                <h3>לא זוהה מבנה Answer Composer</h3>
                                <p>
                                    התשובה מהשרת אינה כוללת את ששת השדות הצפויים. לעיתים זה קורה כש־
                                    <code className="lab-code-inline">REACT_APP_API_BASE_URL</code> מצביע לשרת ישן
                                    או לפריסה ללא הקוד העדכני. בדקו את כתובת ה־API ב־
                                    <code className="lab-code-inline">.env</code> והריצו מחדש את הפרונט לאחר עדכון
                                    השרת.
                                </p>
                                <JsonViewer value={results} maxHeight="min(40vh, 320px)" />
                            </div>
                        )}
                        {legacyResults && (
                        <>
                        {results.status === 'PARTIAL_EVIDENCE' && (
                            <div className="ai-answer partial-evidence-block">
                                <div className="research-stage-badge">PARTIAL_EVIDENCE</div>
                                <h3>מידע חלקי במערכת</h3>
                                {results.gap_type ? (
                                    <p className="stage-hint">סוג פער: {results.gap_type}</p>
                                ) : null}
                                {Array.isArray(results.what_exists) && results.what_exists.length > 0 && (
                                    <div className="partial-list">
                                        <strong>קיים:</strong>
                                        <ul>
                                            {results.what_exists.map((x, i) => (
                                                <li key={`ex-${i}`}>{x}</li>
                                            ))}
                                        </ul>
                                    </div>
                                )}
                                {Array.isArray(results.what_missing) && results.what_missing.length > 0 && (
                                    <div className="partial-list">
                                        <strong>חסר:</strong>
                                        <ul>
                                            {results.what_missing.map((x, i) => (
                                                <li key={`mi-${i}`}>{x}</li>
                                            ))}
                                        </ul>
                                    </div>
                                )}
                                <AnswerEvidenceSection
                                    sources={results.sources || []}
                                    title={SEARCH_EVIDENCE_TITLE}
                                    hint={SEARCH_EVIDENCE_HINT}
                                />
                            </div>
                        )}
                        {results.research_flow === 'document' && (
                            <div className="research-stage-badge" title="ללא FSM / קרנל מחקר">
                                חיפוש מסמך
                            </div>
                        )}
                        {results.blocked && (
                            <div className="blocked-message">
                                <h3>🚫 תשובה נחסמה</h3>
                                <div className="blocked-text">
                                    {results.block_reason || results.error || 'התשובה נחסמה על ידי המערכת'}
                                </div>
                                {results.state && (
                                    <div className="state-badge blocked-state">
                                        מצב: {results.state}
                                    </div>
                                )}
                            </div>
                        )}
                        {results.kernel_v16?.possibility_shutdown && (
                            <div className="kernel-shutdown-banner">
                                מרחב אפשרויות סגור (אחרי זיהוי שבירה): אין אופטימיזציה/כוונון במסלול 4 סוכנים עד סשן
                                חדש.
                            </div>
                        )}
                        {results.kernel_v16?.structured && (
                            <div className="kernel-v16-structured">
                                <h3>מבנה תשובה (קרנל v1.6)</h3>
                                <dl className="kernel-v16-dl">
                                    <dt>Evidence</dt>
                                    <dd>{results.kernel_v16.structured.Evidence}</dd>
                                    <dt>Pattern</dt>
                                    <dd>{results.kernel_v16.structured.Pattern}</dd>
                                    <dt>Conclusion</dt>
                                    <dd>
                                        {formatBoldSegments(results.kernel_v16.structured.Conclusion || '').map(
                                            (part, j) =>
                                                part.type === 'bold' ? (
                                                    <strong key={`kernel- conclusão-${j}`}>{part.value}</strong>
                                                ) : (
                                                    <span key={`kernel- conclusão-${j}`}>{part.value}</span>
                                                )
                                        )}
                                    </dd>
                                    <dt>Confidence</dt>
                                    <dd>{results.kernel_v16.structured.Confidence}</dd>
                                </dl>
                                {results.kernel_v16.n_generation?.ideas?.length > 0 && (
                                    <div className="kernel-n-generation">
                                        <strong>יצירה מבנית (N):</strong>
                                        <ul>
                                            {results.kernel_v16.n_generation.ideas.map((idea, idx) => (
                                                <li key={idx}>
                                                    <code>{idea.kind}</code>: {idea.desc_he}
                                                </li>
                                            ))}
                                        </ul>
                                        <p className="stage-hint">{results.kernel_v16.n_generation.acceptance_criteria_he}</p>
                                    </div>
                                )}
                            </div>
                        )}
                        {results.stopped_by_violation && (
                            <div className="blocked-message">
                                <h3>⛔ נעצר על ידי Integrity Monitor</h3>
                                <div className="blocked-text">
                                    {results.message || 'נוצרה הפרת B-Integrity. יש לטפל בהפרה בדשבורד ניהול.'}
                                </div>
                                {results.violation_id && (
                                    <div className="state-badge blocked-state">מזהה הפרה: {results.violation_id}</div>
                                )}
                            </div>
                        )}
                        {results.answer && !results.blocked && (
                            <div className="ai-answer">
                                {results.use_4_agents && (
                                    <div className="research-stage-badge">4 סוכנים – סינתזה</div>
                                )}
                                {results.research_stage && !results.use_4_agents && (
                                    <div className="research-stage-badge">שלב: {results.research_stage}</div>
                                )}
                                <h3>🤖 {results.use_4_agents ? 'תשובה (סינתזה):' : 'תשובה חכמה (Doc Agent):'}</h3>
                                {results.warning && (
                                    <div className="warning-banner">
                                        ⚠️ {results.warning}
                                    </div>
                                )}
                                {results.state && (
                                    <div className={`state-badge state-${results.state.toLowerCase()}`}>
                                        מצב: {results.state}
                                    </div>
                                )}
                                <div className="answer-text">
                                    {formatBoldSegments(results.answer || '').map((part, j) =>
                                        part.type === 'bold' ? <strong key={`search-ans-${j}`}>{part.value}</strong> : <span key={`search-ans-${j}`}>{part.value}</span>
                                    )}
                                </div>
                                <AnswerEvidenceSection
                                    sources={results.sources || []}
                                    title={SEARCH_EVIDENCE_TITLE}
                                    hint={SEARCH_EVIDENCE_HINT}
                                />
                                {results.use_4_agents && results.outputs && (
                                    <details className="four-agents-outputs">
                                        <summary>פלטי כל הסוכנים</summary>
                                        <div className="agent-outputs-list">
                                            {Object.entries(results.outputs).map(([name, text]) => (
                                                <div key={name} className="agent-output-item">
                                                    <strong>{name}:</strong>{' '}
                                                    {formatBoldSegments(text || '—').map((part, j) =>
                                                        part.type === 'bold' ? <strong key={`agent-out-${name}-${j}`}>{part.value}</strong> : <span key={`agent-out-${name}-${j}`}>{part.value}</span>
                                                    )}
                                                </div>
                                            ))}
                                        </div>
                                        {results.justifications && results.justifications.length > 0 && (
                                            <div className="justifications-list">
                                                <strong>הצדקות שינוי:</strong>
                                                <ul>
                                                    {results.justifications.map((j, i) => (
                                                        <li key={i}>{j.agent}: {j.label || j.reason}</li>
                                                    ))}
                                                </ul>
                                            </div>
                                        )}
                                    </details>
                                )}
                                {results.context_sources && (
                                    <div className="answer-sources">
                                        מבוסס על {results.context_sources} מקורות מהמסמכים
                                    </div>
                                )}
                                {!results.use_4_agents && (
                                <div className="agent-actions">
                                    <button
                                        onClick={() => handleAgentCheck('contradiction')}
                                        disabled={isAnalyzing}
                                        className={`agent-button contradiction-button ${isAnalyzing ? 'loading' : ''}`}
                                    >
                                        {isAnalyzing ? (
                                            <span key="analyzing" className="btn-inner">
                                                <span className="spinner"></span>
                                                <span>בודק...</span>
                                            </span>
                                        ) : (
                                            <span key="idle" className="btn-inner">
                                                <span>🔍 בדוק סתירות (Contradiction Agent)</span>
                                            </span>
                                        )}
                                    </button>
                                    <button
                                        onClick={() => handleAgentCheck('risk')}
                                        disabled={isAnalyzing}
                                        className={`agent-button risk-button ${isAnalyzing ? 'loading' : ''}`}
                                    >
                                        {isAnalyzing ? (
                                            <span key="analyzing" className="btn-inner">
                                                <span className="spinner"></span>
                                                <span>בודק...</span>
                                            </span>
                                        ) : (
                                            <span key="idle" className="btn-inner">
                                                <span>⚠️ זהה סיכונים (Risk Agent)</span>
                                            </span>
                                        )}
                                    </button>
                                </div>
                                )}
                            </div>
                        )}
                        {!results.answer && results.results_count > 0 && (
                            <div className="info-message">
                                ⚠️ לא נוצרה תשובה חכמה. מציג תוצאות חיפוש בלבד.
                            </div>
                        )}

                        {agentAnalysis && (
                            <div className={`agent-analysis ${agentAnalysis.type === 'contradiction' ? 'contradiction-analysis' : 'risk-analysis'}`}>
                                <h3>
                                    {agentAnalysis.type === 'contradiction' 
                                        ? '🔍 ניתוח סתירות (Contradiction Agent)' 
                                        : '⚠️ ניתוח סיכונים (Risk Agent)'}
                                </h3>
                                <div className="agent-analysis-text">
                                    {formatBoldSegments(agentAnalysis.analysis || '').map((part, j) =>
                                        part.type === 'bold' ? <strong key={`analysis-${j}`}>{part.value}</strong> : <span key={`analysis-${j}`}>{part.value}</span>
                                    )}
                                </div>
                            </div>
                        )}
                        
                        {!results.use_4_agents && (
                        <>
                        <h3>נמצאו {results.results_count} תוצאות:</h3>
                        {results.results_count === 0 ? (
                            <div className="empty-state">לא נמצאו תוצאות</div>
                        ) : (
                            results.results.map((item, index) => (
                                <div key={index} className="search-result-item">
                                    <div className="result-header">
                                        <span className="result-filename">
                                            {item.metadata?.filename || 'לא ידוע'}
                                        </span>
                                        <span className="result-distance">
                                            דמיון: {item.distance ? item.distance.toFixed(4) : 'N/A'}
                                        </span>
                                    </div>
                                    <div className="result-text">
                                        {formatBoldSegments(item.document || '').map((part, j) =>
                                            part.type === 'bold' ? <strong key={`res-item-${index}-${j}`}>{part.value}</strong> : <span key={`res-item-${index}-${j}`}>{part.value}</span>
                                        )}
                                    </div>
                                    {item.metadata?.chunk_index !== undefined && (
                                        <div className="result-metadata">
                                            חלק מספר: {item.metadata.chunk_index}
                                        </div>
                                    )}
                                </div>
                            ))
                        )}
                        </>
                        )}
                        </>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}

export default SearchTab;
