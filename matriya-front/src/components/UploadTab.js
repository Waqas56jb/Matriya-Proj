import React, { useState, useRef, useEffect, useCallback } from 'react';
import api from '../utils/api';
import { formatApiErrorForUser } from '../utils/openAiFriendlyError';
import { runAskMatriyaDocumentsQuery } from '../utils/askMatriyaDocumentsClient';
import { formatBoldSegments } from '../utils/formatBold';
import GptSyncStatusRow, { filterEligibleLogicalNames, GPT_ELIGIBLE_RE } from './GptSyncStatusRow';
import AnswerEvidenceSection from './AnswerEvidenceSection';
import './UploadTab.css';

const ASK_EVIDENCE_TITLE = 'מקורות מהמסמכים (ציטוטים)';
const ASK_EVIDENCE_HINT = 'קטעים ששימשו כבסיס לתשובה — לשקיפות וביקורת.';

const ACCEPT = '.pdf,.docx,.txt,.doc,.xlsx,.xls,.jpg,.jpeg,.png,.webp';
const ACCEPT_LIST = ['pdf', 'docx', 'txt', 'doc', 'xlsx', 'xls', 'jpg', 'jpeg', 'png', 'webp'];

/** Tells matriya-back to skip debounced OpenAI auto-sync — UI runs POST /gpt-rag/sync itself. */
const INGEST_OPT_OUT_AUTO_GPT_SYNC = { 'X-Matriya-Client-Gpt-Sync': '1' };

function getFileType(filename) {
    if (!filename) return '—';
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    const labels = {
        pdf: 'PDF',
        docx: 'DOCX',
        doc: 'DOC',
        txt: 'TXT',
        xlsx: 'XLSX',
        xls: 'XLS',
        jpg: 'JPG',
        jpeg: 'JPEG',
        png: 'PNG',
        webp: 'WEBP'
    };
    return labels[ext] || ext.toUpperCase() || '—';
}

function formatDate(iso) {
    if (!iso) return '—';
    try {
        const d = new Date(iso);
        return d.toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch (_) {
        return iso;
    }
}

/** Build a tree from file list: { type: 'folder', pathFull, pathSegment, children: [], files: [] } or flat list of files at root */
function buildFileTree(files) {
    const root = { type: 'folder', pathFull: '', pathSegment: null, children: [], files: [] };
    for (const f of files) {
        const pathStr = (f.filename || '').trim();
        const segments = pathStr.includes('/') ? pathStr.split('/').filter(Boolean) : [];
        if (segments.length <= 1) {
            root.files.push(f);
            continue;
        }
        const fileSegment = segments.pop();
        let node = root;
        for (let i = 0; i < segments.length; i++) {
            const pathFull = segments.slice(0, i + 1).join('/');
            let child = node.children.find(c => c.pathFull === pathFull);
            if (!child) {
                child = { type: 'folder', pathFull, pathSegment: segments[i], children: [], files: [] };
                node.children.push(child);
            }
            node = child;
        }
        node.files.push({ ...f, _basename: fileSegment });
    }
    if (root.files.length > 0) {
        root.children.push({ type: 'folder', pathFull: '\0', pathSegment: 'ללא תיקייה', children: [], files: root.files });
        root.files = [];
    }
    root.children.sort((a, b) => (a.pathFull === '\0' ? -1 : b.pathFull === '\0' ? 1 : (a.pathSegment || '').localeCompare(b.pathSegment || '')));
    function sortNode(n) {
        n.children.sort((a, b) => (a.pathFull === '\0' ? -1 : b.pathFull === '\0' ? 1 : (a.pathSegment || '').localeCompare(b.pathSegment || '')));
        n.children.forEach(sortNode);
    }
    sortNode(root);
    return root;
}

function collectFolderPathFulls(node) {
    const out = [];
    if (node.pathFull !== undefined && node.pathFull !== '') out.push(node.pathFull);
    (node.children || []).forEach(c => out.push(...collectFolderPathFulls(c)));
    return out;
}

/** Same idea as maneger-front resolveProjectFileIdsFromHints — match ingest hints to rows from GET /files/detail. */
function resolveMatriyaLogicalNamesFromHints(files, hints) {
    const list = Array.isArray(files) ? files : [];
    const hintList = (Array.isArray(hints) ? hints : []).map((h) => String(h || '').trim()).filter(Boolean);
    if (hintList.length === 0 || list.length === 0) return [];
    const seen = new Set();
    const out = [];
    for (const hint of hintList) {
        const base = hint.includes('/') || hint.includes('\\') ? hint.split(/[/\\]/).pop() : hint;
        const candidates = list.filter((f) => {
            const name = String(f.filename || '').trim();
            if (!name) return false;
            return name === hint || name === base || (base && name.endsWith(base));
        });
        const pick = candidates.sort((a, b) => {
            const ta = new Date(a.uploaded_at || 0).getTime();
            const tb = new Date(b.uploaded_at || 0).getTime();
            return tb - ta;
        })[0];
        const fn = pick?.filename;
        if (fn != null && String(fn).trim() && !seen.has(String(fn))) {
            seen.add(String(fn));
            out.push(String(fn).trim());
        }
    }
    return out;
}

function hintListEligibleForGptSync(hints) {
    const arr = Array.isArray(hints) ? hints : [];
    return arr.some((n) => {
        const base = String(n || '').split('/').filter(Boolean).pop() || '';
        return base && GPT_ELIGIBLE_RE.test(base);
    });
}

function UploadTab({ onGptSyncingChange, gptRagSyncing = false }) {
    const [fileList, setFileList] = useState([]);
    const [fileListLoading, setFileListLoading] = useState(true);
    const [isDragging, setIsDragging] = useState(false);
    const [isUploading, setIsUploading] = useState(false);
    const [uploadResult, setUploadResult] = useState(null);
    const [previewDoc, setPreviewDoc] = useState(null);
    const [previewLoading, setPreviewLoading] = useState(false);
    const [collectionInfo, setCollectionInfo] = useState(null);
    const [foldersCollapsed, setFoldersCollapsed] = useState(() => new Set());
    const [askSelectedFile, setAskSelectedFile] = useState('');
    const [askQuery, setAskQuery] = useState('');
    const [askResult, setAskResult] = useState(null);
    const [askLoading, setAskLoading] = useState(false);
    const [askError, setAskError] = useState(null);
    const [askSources, setAskSources] = useState(null);
    const [deletingFilename, setDeletingFilename] = useState(null);
    /** Management-style: POST /gpt-rag/sync with only_logical_names after reload + optional name resolution. */
    const gptRagStatusRef = useRef(null);
    const gptSyncRowRef = useRef(null);
    const fileInputRef = useRef(null);
    const folderInputRef = useRef(null);
    const gptResyncDebounceRef = useRef(null);

    const toggleFolder = (pathFull) => {
        setFoldersCollapsed(prev => {
            const next = new Set(prev);
            if (next.has(pathFull)) next.delete(pathFull);
            else next.add(pathFull);
            return next;
        });
    };

    const loadFileList = useCallback(async () => {
        setFileListLoading(true);
        try {
            const res = await api.get('/files/detail');
            const files = Array.isArray(res.data?.files) ? res.data.files : [];
            setFileList(files);
            return files;
        } catch (_) {
            setFileList([]);
            return [];
        } finally {
            setFileListLoading(false);
        }
    }, []);

    const loadCollectionInfo = useCallback(async () => {
        try {
            const res = await api.get('/collection/info');
            setCollectionInfo(res.data);
        } catch (_) {
            setCollectionInfo(null);
        }
    }, []);

    const onGptSyncComplete = useCallback(() => {
        loadFileList();
        loadCollectionInfo();
    }, [loadFileList, loadCollectionInfo]);

    const onGptRagStatusChange = useCallback((s) => {
        gptRagStatusRef.current = s;
    }, []);

    /**
     * Fire-and-forget incremental cloud sync (no UI «מסנכרן» — avoids stuck state; server auto-sync skipped via ingest header).
     */
    const runGptCloudSyncAfterUpload = useCallback(
        (onlyLogicalNames) => {
            const names = filterEligibleLogicalNames(onlyLogicalNames);
            if (names.length === 0) return;

            void api
                .post('/gpt-rag/sync', { only_logical_names: names }, { timeout: 300000 })
                .then(() => {
                    void loadFileList();
                    loadCollectionInfo();
                    return gptSyncRowRef.current?.refreshSilent?.();
                })
                .catch((e) => {
                    console.warn('[UploadTab] gpt-rag/sync after upload', e);
                })
                .finally(() => {
                    void gptSyncRowRef.current?.refreshSilent?.();
                });
        },
        [loadFileList, loadCollectionInfo]
    );

    /**
     * Same flow as maneger RagTab queueGptResyncAfterUpload: debounce, reload file list, resolve names, incremental sync only.
     */
    const queueGptResyncAfterUpload = useCallback(
        (fileNameHints, logicalNamesFromApi) => {
            const hints = Array.isArray(fileNameHints) ? fileNameHints : [];
            const fromApi = Array.isArray(logicalNamesFromApi) ? logicalNamesFromApi : [];
            const unknownOrEligible = hints.length === 0 || hintListEligibleForGptSync(hints);
            if (!unknownOrEligible) return;
            if (gptResyncDebounceRef.current != null) {
                clearTimeout(gptResyncDebounceRef.current);
            }
            gptResyncDebounceRef.current = window.setTimeout(async () => {
                gptResyncDebounceRef.current = null;
                let gptSt = gptRagStatusRef.current;
                try {
                    const latest = await gptSyncRowRef.current?.refreshSilent?.();
                    if (latest && typeof latest === 'object') gptSt = latest;
                } catch (_) {}
                if (!gptSt?.openai || !gptSt?.use_openai_file_search) return;
                try {
                    const freshFiles = await loadFileList();
                    let names = filterEligibleLogicalNames(fromApi);
                    if (names.length === 0 && hints.length > 0) {
                        names = filterEligibleLogicalNames(resolveMatriyaLogicalNamesFromHints(freshFiles, hints));
                    }
                    if (names.length > 0) {
                        runGptCloudSyncAfterUpload(names);
                    } else {
                        await gptSyncRowRef.current?.refreshSilent?.();
                    }
                } catch (_) {
                    await gptSyncRowRef.current?.refreshSilent?.();
                }
            }, 500);
        },
        [loadFileList, runGptCloudSyncAfterUpload]
    );

    useEffect(() => {
        loadFileList();
        loadCollectionInfo();
    }, [loadFileList, loadCollectionInfo]);

    useEffect(
        () => () => {
            if (gptResyncDebounceRef.current != null) {
                clearTimeout(gptResyncDebounceRef.current);
            }
        },
        []
    );

    useEffect(() => {
        if (!askSelectedFile) return;
        if (!fileList.some((f) => f.filename === askSelectedFile)) {
            setAskSelectedFile('');
        }
    }, [fileList, askSelectedFile]);

    useEffect(() => {
        if (fileList.length === 0) return;
        const tree = buildFileTree(fileList);
        const pathFulls = collectFolderPathFulls(tree);
        setFoldersCollapsed(new Set(pathFulls));
    }, [fileList]);

    const handleDragOver = (e) => {
        e.preventDefault();
        setIsDragging(true);
    };

    const handleDragLeave = () => setIsDragging(false);

    const handleDrop = (e) => {
        e.preventDefault();
        setIsDragging(false);
        const files = e.dataTransfer.files;
        if (files.length > 0) {
            if (files.length === 1) uploadFile(files[0]);
            else uploadFiles(Array.from(files));
        }
    };

    const handleFileSelect = (e) => {
        const files = e.target.files;
        if (files?.length > 0) {
            if (files.length === 1) uploadFile(files[0]);
            else uploadFiles(Array.from(files));
        }
        e.target.value = '';
    };

    const handleFolderSelect = (e) => {
        const files = e.target.files;
        if (files?.length > 0) {
            const supported = Array.from(files).filter(f => {
                const ext = (f.name.split('.').pop() || '').toLowerCase();
                return ACCEPT_LIST.includes(ext);
            });
            if (supported.length > 0) uploadFiles(supported);
            else setUploadResult({ type: 'error', message: 'לא נמצאו קבצים נתמכים בתיקייה (PDF, DOCX, TXT, DOC, XLSX, XLS)' });
        }
        e.target.value = '';
    };

    const uploadFile = async (file) => {
        const formData = new FormData();
        formData.append('file', file);
        setIsUploading(true);
        setUploadResult(null);
        try {
            const response = await api.post('/ingest/file', formData, { headers: INGEST_OPT_OUT_AUTO_GPT_SYNC });
            if (response.data.success) {
                setUploadResult({ type: 'success', message: 'העלאה הושלמה בהצלחה!', data: response.data.data });
                const logicalName = response.data?.data?.filename;
                const hints = logicalName ? [logicalName] : [];
                queueGptResyncAfterUpload(hints, logicalName ? [logicalName] : []);
                loadFileList();
                loadCollectionInfo();
            } else {
                setUploadResult({ type: 'error', message: response.data?.error || response.data?.detail || 'שגיאה בהעלאה' });
            }
        } catch (error) {
            setUploadResult({ type: 'error', message: error.response?.data?.error || error.response?.data?.detail || error.message || 'שגיאה בהעלאה' });
        } finally {
            setIsUploading(false);
        }
    };

    const uploadFiles = async (files) => {
        setIsUploading(true);
        setUploadResult(null);
        let ok = 0, err = 0;
        const ingestedLogicalNames = [];
        for (const file of files) {
            const formData = new FormData();
            formData.append('file', file);
            const relativePath = file.webkitRelativePath || (file.path && typeof file.path === 'string' ? file.path : null);
            if (relativePath) formData.append('relative_path', relativePath);
            try {
                const response = await api.post('/ingest/file', formData, { headers: INGEST_OPT_OUT_AUTO_GPT_SYNC });
                if (response.data?.success) {
                    ok++;
                    const fn = response.data?.data?.filename;
                    if (fn) ingestedLogicalNames.push(fn);
                } else err++;
            } catch (_) {
                err++;
            }
        }
        if (ingestedLogicalNames.length > 0) {
            queueGptResyncAfterUpload(ingestedLogicalNames, ingestedLogicalNames);
        }
        setIsUploading(false);
        setUploadResult({
            type: err === 0 ? 'success' : (ok === 0 ? 'error' : 'success'),
            message: err === 0 ? `${ok} קבצים הועלו בהצלחה` : ok === 0 ? `${err} העלאות נכשלו` : `הועלו ${ok} קבצים, ${err} נכשלו`
        });
        loadFileList();
        loadCollectionInfo();
        if (fileInputRef.current) fileInputRef.current.value = '';
        if (folderInputRef.current) folderInputRef.current.value = '';
    };

    const openPreview = async (filename) => {
        setPreviewDoc({ filename, text: null });
        setPreviewLoading(true);
        try {
            const res = await api.get('/files/preview', { params: { filename } });
            setPreviewDoc({ filename, text: res.data?.text || '', metadata: res.data?.metadata });
        } catch (_) {
            setPreviewDoc(prev => ({ ...prev, text: '(לא ניתן לטעון תצוגה מקדימה)' }));
        } finally {
            setPreviewLoading(false);
        }
    };

    const closePreview = () => setPreviewDoc(null);

    const handleDeleteFile = async (filename) => {
        if (!filename || !window.confirm(`למחוק את "${filename}" מהמאגר? לא ניתן יהיה לשאול על הקובץ לאחר המחיקה.`)) {
            return;
        }
        setDeletingFilename(filename);
        setUploadResult(null);
        try {
            await api.delete('/files', { data: { filename }, timeout: 60000 });
            setUploadResult({ type: 'success', message: `הקובץ נמחק מהמאגר: ${filename}` });
            if (askSelectedFile === filename) setAskSelectedFile('');
            setAskResult(null);
            setAskSources(null);
            setAskError(null);
            await loadFileList();
            await loadCollectionInfo();
        } catch (error) {
            setUploadResult({
                type: 'error',
                message: formatApiErrorForUser(error, 'שגיאה במחיקה')
            });
        } finally {
            setDeletingFilename(null);
        }
    };

    const runAsk = async () => {
        const query = (askQuery || '').trim();
        if (!query) return;
        if (isUploading || gptRagSyncing) return;
        const tableFilenames = fileList.map((f) => f.filename).filter(Boolean);
        if (tableFilenames.length === 0) {
            setAskError('אין מסמכים בטבלה — העלו מסמכים כדי לשאול.');
            return;
        }
        const filenames = askSelectedFile
            ? tableFilenames.includes(askSelectedFile)
                ? [askSelectedFile]
                : []
            : tableFilenames;
        if (askSelectedFile && filenames.length === 0) {
            setAskError('המסמך שנבחר אינו ברשימה — רעננו את הדף או בחרו מחדש.');
            return;
        }
        setAskError(null);
        setAskResult(null);
        setAskSources(null);
        setAskLoading(true);
        try {
            const { reply, sources } = await runAskMatriyaDocumentsQuery(query, filenames);
            setAskResult(reply);
            setAskSources(sources);
        } catch (err) {
            setAskError(formatApiErrorForUser(err, 'שגיאה בשאילתה'));
        } finally {
            setAskLoading(false);
        }
    };

    const recentFiles = fileList.slice(0, 5);
    const fileTree = buildFileTree(fileList);

    const renderFileRow = (f, displayName) => (
        <tr key={f.filename} className="documents-table__data-row">
            <td className="doc-name" data-label="שם מסמך">{displayName || f.filename}</td>
            <td data-label="סוג קובץ">{getFileType(displayName || f.filename)}</td>
            <td data-label="תאריך העלאה">{formatDate(f.uploaded_at)}</td>
            <td data-label="חלקים">{f.chunks_count ?? '—'}</td>
            <td data-label="תצוגה מקדימה">
                <button type="button" className="preview-btn" onClick={() => openPreview(f.filename)}>תצוגה מקדימה</button>
            </td>
            <td data-label="מחיקה">
                <button
                    type="button"
                    className="preview-btn doc-delete-btn"
                    disabled={deletingFilename === f.filename}
                    onClick={() => handleDeleteFile(f.filename)}
                >
                    {deletingFilename === f.filename ? (
                        <span key="loading" className="btn-inner">מוחק…</span>
                    ) : (
                        <span key="idle" className="btn-inner">מחק</span>
                    )}
                </button>
            </td>
        </tr>
    );

    const renderFolderRows = (node, depth = 0) => {
        const rows = [];
        if (node.pathSegment != null) {
            const isCollapsed = foldersCollapsed.has(node.pathFull);
            rows.push(
                <tr key={`folder-${node.pathFull}`} className="folder-row">
                    <td colSpan={6} className="folder-cell">
                        <button type="button" className="folder-toggle" onClick={() => toggleFolder(node.pathFull)} aria-expanded={!isCollapsed}>
                            <span className="folder-chevron" style={{ transform: isCollapsed ? 'rotate(-90deg)' : 'none' }}>▼</span>
                            <span>📁 {node.pathSegment}</span>
                        </button>
                    </td>
                </tr>
            );
            if (!isCollapsed) {
                node.files.forEach(f => rows.push(renderFileRow(f, f._basename || f.filename)));
                node.children.forEach(c => renderFolderRows(c, depth + 1).forEach(r => rows.push(r)));
            }
        }
        return rows;
    };

    const tableBodyRows = [];
    fileTree.files.forEach(f => tableBodyRows.push(renderFileRow(f, null)));
    fileTree.children.forEach(c => renderFolderRows(c).forEach(r => tableBodyRows.push(r)));

    return (
        <div className="upload-tab">
            <div className="upload-layout">
                <div className="upload-main">
                    <div className="card">
                        <div className="upload-card-header">
                            <h2>העלאת מסמך חדש</h2>
                            <button type="button" className="folder-upload-btn" onClick={() => folderInputRef.current?.click()}>
                                📁 ייבוא תיקייה
                            </button>
                            <input ref={folderInputRef} type="file" webkitdirectory="true" directory="true" multiple style={{ display: 'none' }} onChange={handleFolderSelect} accept={ACCEPT} />
                        </div>
                        <div className="upload-actions">
                            <div
                                className={`upload-area ${isDragging ? 'dragover' : ''}`}
                                onDragOver={handleDragOver}
                                onDragLeave={handleDragLeave}
                                onDrop={handleDrop}
                                onClick={() => fileInputRef.current?.click()}
                            >
                                <input ref={fileInputRef} type="file" accept={ACCEPT} style={{ display: 'none' }} onChange={handleFileSelect} multiple />
                                <div className="upload-placeholder">
                                    <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                                        <polyline points="17 8 12 3 7 8" />
                                        <line x1="12" y1="3" x2="12" y2="15" />
                                    </svg>
                                    <p>לחץ כאן או גרור קובץ להעלאה</p>
                                    <p className="file-types">PDF, DOCX, TXT, DOC, XLSX, XLS</p>
                                </div>
                            </div>
                        </div>

                        {isUploading && (
                            <div className="progress-bar">
                                <div className="progress-fill" />
                            </div>
                        )}

                        {uploadResult && (
                            <div className={`upload-result ${uploadResult.type}`}>
                                <strong>{uploadResult.type === 'success' ? '✓' : '✗'} {uploadResult.message}</strong>
                                {uploadResult.data && (
                                    <div style={{ marginTop: '10px' }}>
                                        <p>קובץ: {uploadResult.data.filename}</p>
                                        <p>מספר חלקים שנוצרו: {uploadResult.data.chunks_count}</p>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>

                    <div className="card documents-table-card">
                        <h2>מסמכים במערכת</h2>
                        {fileListLoading ? (
                            <div className="loading">טוען רשימה...</div>
                        ) : fileList.length === 0 ? (
                            <p className="empty-docs">אין עדיין מסמכים. העלה קבצים למעלה.</p>
                        ) : (
                            <div className="table-wrap" role="region" aria-label="טבלת מסמכים — גלילה אופקית במסכים רחבים">
                                <table className="documents-table">
                                    <thead>
                                        <tr>
                                            <th>שם מסמך</th>
                                            <th>סוג קובץ</th>
                                            <th>תאריך העלאה</th>
                                            <th>חלקים</th>
                                            <th>תצוגה מקדימה</th>
                                            <th>מחיקה</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {tableBodyRows}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </div>

                    <div className="card upload-ask-card">
                        <h2>שאל על המסמכים</h2>
                        <GptSyncStatusRow
                            ref={gptSyncRowRef}
                            filenames={fileList.map((f) => f.filename)}
                            onStatusChange={onGptRagStatusChange}
                            onSyncComplete={onGptSyncComplete}
                            onSyncingChange={onGptSyncingChange}
                            fileUploadInProgress={isUploading}
                            className="upload-ask-gpt-sync"
                        />
                        {fileList.length > 0 && (
                            <>
                                <div className="form-group">
                                    <label htmlFor="upload-ask-scope">חיפוש בתוך</label>
                                    <select
                                        id="upload-ask-scope"
                                        value={askSelectedFile}
                                        onChange={e => setAskSelectedFile(e.target.value)}
                                        aria-describedby="upload-ask-scope-hint"
                                    >
                                        <option value="">כל הקבצים המופיעים בטבלה למעלה</option>
                                        {fileList.map(f => (
                                            <option key={f.filename} value={f.filename} title={f.filename}>
                                                {f.filename}
                                            </option>
                                        ))}
                                    </select>
                                    <p id="upload-ask-scope-hint" className="upload-ask-hint muted">
                                        השרת בודק תחילה אם השאלה באופן ברור עוסקת ברשימת החומרים/הניסויים כפי שרשומים במערכת הניהול (כשיש חיבור לשרת הניהול); שאלות מקט, מפרט טכני או תוכן מסמכים — בדרך כלל נענות מטקסט הקבצים בטבלה. אם כן לניהול — התשובה מסתמכת על הנתונים משם; אחרת על טקסט המסמכים. ציטוטים מהמסמכים — רק לקבצים המופיעים ברשימה; אחרי מחיקה יש לרענן; סנכרון OpenAI למעלה מעדכן את החיפוש בענן.
                                    </p>
                                    <p className="upload-ask-hint muted">
                                        לאותה שאלה ואותה בחירת קבצים (טווח החיפוש למעלה), המערכת מכוונת לתשובה יציבה ועקבית יותר.
                                    </p>
                                </div>
                                <label htmlFor="upload-ask-query">שאל שאלה</label>
                                <textarea
                                    id="upload-ask-query"
                                    value={askQuery}
                                    onChange={e => setAskQuery(e.target.value)}
                                    placeholder="הזן שאלה..."
                                    rows={4}
                                    disabled={askLoading || isUploading || gptRagSyncing}
                                />
                                <button
                                    type="button"
                                    className="upload-ask-run"
                                    onClick={runAsk}
                                    disabled={askLoading || !askQuery.trim() || isUploading || gptRagSyncing}
                                >
                                    {askLoading ? (
                                        <span key="asking" className="btn-inner">מריץ...</span>
                                    ) : (
                                        <span key="idle" className="btn-inner">הרץ</span>
                                    )}
                                </button>
                                {askError && <p className="upload-ask-error">{askError}</p>}
                                {askResult != null && askResult !== '' && (
                                    <>
                                    <div className="upload-ask-result">
                                        <span key={askResult || 'empty'}>{askResult}</span>
                                    </div>
                                        <AnswerEvidenceSection
                                            sources={askSources || []}
                                            title={ASK_EVIDENCE_TITLE}
                                            hint={ASK_EVIDENCE_HINT}
                                        />
                                    </>
                                )}
                            </>
                        )}
                        {fileList.length === 0 && !fileListLoading && (
                            <p className="muted">העלה מסמכים למעלה כדי לשאול עליהם שאלות.</p>
                        )}
                    </div>
                </div>

                <aside className="upload-sidebar">
                    <div className="card sidebar-card">
                        <h3>סטטיסטיקה</h3>
                        {collectionInfo ? (
                            <ul className="stats-list">
                                <li>מסמכים במאגר: <strong>{collectionInfo.document_count ?? 0}</strong></li>
                                <li>קבצים ייחודיים: <strong>{fileList.length}</strong></li>
                            </ul>
                        ) : (
                            <p className="muted">טוען...</p>
                        )}
                    </div>
                    <div className="card sidebar-card">
                        <h3>מסמכים אחרונים</h3>
                        {recentFiles.length === 0 ? (
                            <p className="muted">אין מסמכים</p>
                        ) : (
                            <ul className="recent-list">
                                {recentFiles.map((f) => (
                                    <li key={f.filename} title={f.filename}>{f.filename}</li>
                                ))}
                            </ul>
                        )}
                    </div>
                    <div className="card sidebar-card">
                        <h3>פעילות אינדוקס</h3>
                        {uploadResult ? (
                            <p className={uploadResult.type}>{uploadResult.message}</p>
                        ) : (
                            <p className="muted">העלה קובץ או תיקייה כדי לראות פעילות</p>
                        )}
                    </div>
                </aside>
            </div>

            {previewDoc && (
                <div className="preview-overlay" onClick={closePreview} role="dialog" aria-modal="true">
                    <div className="preview-modal" onClick={e => e.stopPropagation()}>
                        <div className="preview-header">
                            <h3>{previewDoc.filename}</h3>
                            <button type="button" className="preview-close" onClick={closePreview} aria-label="סגור">×</button>
                        </div>
                        <div className="preview-body">
                            {previewLoading ? (
                                <div className="loading">טוען...</div>
                            ) : (
                                <div className="preview-text">
                                    {formatBoldSegments(previewDoc.text || 'אין תוכן').map((part, j) => (
                                        part.type === 'bold' ? (
                                            <strong key={`preview-part-${j}`}>{part.value}</strong>
                                        ) : (
                                            <span key={`preview-part-${j}`}>{part.value}</span>
                                        )
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

export default UploadTab;
