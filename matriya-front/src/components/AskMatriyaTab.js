import React, { useState, useRef, useEffect, useCallback } from 'react';
import api from '../utils/api';
import { runAskMatriyaDocumentsQuery, sortFilenamesForAskMatriyaDisplay } from '../utils/askMatriyaDocumentsClient';
import { formatBoldSegments } from '../utils/formatBold';
import AnswerEvidenceSection from './AnswerEvidenceSection';
import GptSyncStatusRow from './GptSyncStatusRow';
import './AskMatriyaTab.css';

const ASK_CHAT_EVIDENCE_TITLE = 'מקורות מהמסמכים (ציטוטים)';
const ASK_CHAT_EVIDENCE_HINT = 'קטעים ששימשו כבסיס לתשובה — לשקיפות וביקורת.';
const ASK_ALL_FILES_VALUE = '__ALL_FILES__';

function AskMatriyaTab({ onGptSyncingChange, gptRagSyncing = false }) {
    /** Same order as Upload file table (GET /files/detail) — used for /ask-matriya filenames. */
    const [filesInApiOrder, setFilesInApiOrder] = useState([]);
    const [selectedFilenames, setSelectedFilenames] = useState([ASK_ALL_FILES_VALUE]);
    const [messages, setMessages] = useState([]);
    const [input, setInput] = useState('');
    const [sending, setSending] = useState(false);
    const [error, setError] = useState(null);
    const [filesLoading, setFilesLoading] = useState(true);
    const [dropdownOpen, setDropdownOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const messagesEndRef = useRef(null);
    const dropdownRef = useRef(null);
    const searchInputRef = useRef(null);

    const filteredFiles = sortFilenamesForAskMatriyaDisplay(
        filesInApiOrder.filter((f) => f.toLowerCase().includes((searchQuery || '').trim().toLowerCase()))
    );

    const fileBasename = (f) => f.split('/').filter(Boolean).pop() || f;
    const isSpreadsheetFilename = (f) => /\.xlsx$/i.test(fileBasename(f)) || /\.xls$/i.test(fileBasename(f));

    useEffect(() => {
        if (!dropdownOpen) return;
        searchInputRef.current?.focus();
    }, [dropdownOpen]);

    useEffect(() => {
        const handleClickOutside = (e) => {
            if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
                setDropdownOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    };

    useEffect(() => {
        scrollToBottom();
    }, [messages]);

    const loadSystemFiles = useCallback((opts = {}) => {
        const silent = Boolean(opts.silent);
        if (!silent) setFilesLoading(true);
        return api
            .get('/files/detail')
            .then((res) => {
                const list = Array.isArray(res.data?.files) ? res.data.files : [];
                const names = list.map((f) => f.filename).filter((n) => typeof n === 'string' && n.trim());
                setFilesInApiOrder(names);
            })
            .catch(() => {
                /* Keep existing list on refresh errors; only initial load stays empty. */
            })
            .finally(() => {
                if (!silent) setFilesLoading(false);
            });
    }, []);

    useEffect(() => {
        loadSystemFiles();
    }, [loadSystemFiles]);

    useEffect(() => {
        setSelectedFilenames((prev) => {
            if (prev.includes(ASK_ALL_FILES_VALUE)) return [ASK_ALL_FILES_VALUE];
            const kept = prev.filter((f) => filesInApiOrder.includes(f));
            return kept.length ? kept : [ASK_ALL_FILES_VALUE];
        });
    }, [filesInApiOrder]);

    const isAllFilesSelected = selectedFilenames.includes(ASK_ALL_FILES_VALUE);

    const toggleFile = (filename) => {
        if (filename === ASK_ALL_FILES_VALUE) {
            setSelectedFilenames([ASK_ALL_FILES_VALUE]);
            return;
        }
        setSelectedFilenames((prev) => {
            const withoutAll = prev.filter((f) => f !== ASK_ALL_FILES_VALUE);
            if (withoutAll.includes(filename)) {
                const next = withoutAll.filter((f) => f !== filename);
                return next.length ? next : [ASK_ALL_FILES_VALUE];
            }
            return [...withoutAll, filename];
        });
    };

    const handleSend = async () => {
        const text = input.trim();
        if (!text || sending || gptRagSyncing) return;

        setError(null);
        setInput('');
        const userMessage = { role: 'user', content: text };
        setMessages((prev) => [...prev, userMessage]);
        setSending(true);

        try {
            if (selectedFilenames.length === 0) {
                setError('בחרו לפחות מסמך אחד מהרשימה לפני שליחת השאלה.');
                setMessages((prev) => prev.slice(0, -1));
                return;
            }
            if (filesInApiOrder.length === 0) {
                setError('אין מסמכים במערכת — העלו מסמכים בלשונית העלאה.');
                setMessages((prev) => prev.slice(0, -1));
                return;
            }
            const filenames = isAllFilesSelected
                ? [...filesInApiOrder]
                : filesInApiOrder.filter((f) => selectedFilenames.includes(f));
            if (filenames.length === 0) {
                setError('אין מסמכים זמינים לשאילתה. רעננו את הרשימה ונסו שוב.');
                setMessages((prev) => prev.slice(0, -1));
                return;
            }
            const { reply: replyText, sources } = await runAskMatriyaDocumentsQuery(text, filenames);
            setMessages((prev) => [...prev, { role: 'assistant', content: replyText, sources }]);
        } catch (err) {
            const msg = err.response?.data?.error || err.message || 'שגיאה בשליחה';
            setError(msg);
            setMessages((prev) => prev.slice(0, -1));
        } finally {
            setSending(false);
        }
    };

    const handleKeyDown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    return (
        <div className="ask-matriya-tab">
            <div className="ask-matriya-single card">
                <h2>שאל את מטריה</h2>
                <p className="ask-matriya-hint">
                    חובה לבחור לפחות מסמך אחד מהרשימה. התשובה מותרת רק לפי מה שמופיע בטקסט המאונדקס של המסמכים שבחרתם — בלי השלמות מידע כללי מהמודל; אם אין במסמכים מספיק נתונים, התשובה תאמר זאת במפורש.
                </p>
                <p className="ask-matriya-hint">
                    השרת בודק תחילה אם השאלה באופן ברור עוסקת ברשימת החומרים/הניסויים כפי שרשומים במערכת הניהול (כשיש חיבור לשרת הניהול); שאלות מקט, מפרט טכני או תוכן מסמכים — בדרך כלל נענות מטקסט הקבצים שבחרתם. אם כן לניהול — התשובה מסתמכת על הנתונים משם; אחרת על טקסט המסמכים. ציטוטים מהמסמכים — רק לקבצים המופיעים ברשימה; אחרי מחיקה יש לרענן; סנכרון OpenAI למעלה מעדכן את החיפוש בענן.
                </p>
                <p className="ask-matriya-hint">
                    לאותה שאלה ואותה בחירת מסמכים, המערכת מכוונת לתשובה יציבה ועקבית יותר; היסטוריית השיחה בשדה למטה עשויה לשנות מעט את ניסוח התשובה בין סיבובים.
                </p>

                <GptSyncStatusRow
                    filenames={filesInApiOrder}
                    onSyncComplete={loadSystemFiles}
                    onSyncingChange={onGptSyncingChange}
                    className="ask-matriya-gpt-sync"
                />

                <div className="ask-matriya-file-section" ref={dropdownRef}>
                    <span className="ask-matriya-file-section-label">
                        <span key="label-prefix">מסמכים במערכת</span>
                        {!filesLoading && filesInApiOrder.length > 0 ? (
                            <span key="label-count">{` (${filesInApiOrder.length})`}</span>
                        ) : null}
                        <span key="label-suffix">:</span>
                    </span>
                    {filesLoading ? (
                        <div className="ask-matriya-loading-files">טוען...</div>
                    ) : filesInApiOrder.length === 0 ? (
                        <div className="ask-matriya-no-files">אין מסמכים במערכת. העלו מסמכים בלשונית העלאת מסמכים קודם.</div>
                    ) : (
                        <div className="ask-matriya-dropdown">
                            <button
                                type="button"
                                className="ask-matriya-dropdown-trigger"
                                onClick={() =>
                                    setDropdownOpen((o) => {
                                        const next = !o;
                                        if (next) {
                                            setSearchQuery('');
                                            void loadSystemFiles({ silent: true });
                                        }
                                        return next;
                                    })
                                }
                                aria-expanded={dropdownOpen}
                                aria-haspopup="listbox"
                            >
                                <span className="ask-matriya-dropdown-trigger-text">
                                    {isAllFilesSelected
                                        ? 'כל המסמכים במערכת'
                                        : selectedFilenames.length === 1
                                            ? selectedFilenames[0]
                                            : `${selectedFilenames.length} מסמכים נבחרו`}
                                </span>
                                <span className="ask-matriya-dropdown-arrow">{dropdownOpen ? '▲' : '▼'}</span>
                            </button>
                            {dropdownOpen && (
                                <div className="ask-matriya-dropdown-panel" role="listbox">
                                    <input
                                        ref={searchInputRef}
                                        type="text"
                                        className="ask-matriya-dropdown-search"
                                        placeholder="חיפוש לפי שם קובץ (כל הסוגים: Word, PDF, Excel…)"
                                        value={searchQuery}
                                        onChange={(e) => setSearchQuery(e.target.value)}
                                        onKeyDown={(e) => e.stopPropagation()}
                                    />
                                    <div className="ask-matriya-dropdown-list">
                                        <button
                                            type="button"
                                            role="option"
                                            aria-selected={isAllFilesSelected}
                                            className={`ask-matriya-dropdown-option ${isAllFilesSelected ? 'selected' : ''}`}
                                            onClick={() => toggleFile(ASK_ALL_FILES_VALUE)}
                                        >
                                            <span className="ask-matriya-dropdown-option-check">
                                                {isAllFilesSelected ? '✓' : ''}
                                            </span>
                                            <span className="ask-matriya-dropdown-option-label" title="כל המסמכים במערכת">
                                                <span key="val-all">כל המסמכים במערכת</span>
                                            </span>
                                        </button>
                                        {filteredFiles.length === 0 ? (
                                            <div className="ask-matriya-dropdown-empty">אין התאמות</div>
                                        ) : (
                                            filteredFiles.map((filename) => (
                                                <button
                                                    key={filename}
                                                    type="button"
                                                    role="option"
                                                    aria-selected={selectedFilenames.includes(filename)}
                                                    className={`ask-matriya-dropdown-option ${selectedFilenames.includes(filename) ? 'selected' : ''}`}
                                                    onClick={() => toggleFile(filename)}
                                                >
                                                    <span className="ask-matriya-dropdown-option-check">
                                                        {selectedFilenames.includes(filename) ? <span key="check">✓</span> : null}
                                                    </span>
                                                    <span className="ask-matriya-dropdown-option-label" title={filename}>
                                                        <span key={filename}>{filename}</span>
                                                    </span>
                                                    {isSpreadsheetFilename(filename) ? (
                                                        <span className="ask-matriya-file-kind" aria-hidden>
                                                            <span key="excel">גיליון</span>
                                                        </span>
                                                    ) : null}
                                                </button>
                                            ))
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>
                    )}
                </div>

                <div className="ask-matriya-messages">
                    {messages.length === 0 && (
                        <div className="ask-matriya-placeholder">
                            <span key="placeholder-text">בחרו מסמך אחד או יותר למעלה, ואז כתבו שאלה למטה.</span>
                        </div>
                    )}
                    <div className="ask-matriya-messages-list">
                        {messages.map((msg, i) => (
                            <div key={i} className={`ask-matriya-msg ask-matriya-msg-${msg.role}`}>
                                <div className="ask-matriya-msg-content">
                                    {formatBoldSegments(msg.content || '').map((part, j) => (
                                        part.type === 'bold' ? (
                                            <strong key={`msg-${i}-part-${j}`}>{part.value}</strong>
                                        ) : (
                                            <span key={`msg-${i}-part-${j}`}>{part.value}</span>
                                        )
                                    ))}
                                </div>
                                {msg.role === 'assistant' ? (
                                    <AnswerEvidenceSection
                                        sources={msg.sources || []}
                                        title={ASK_CHAT_EVIDENCE_TITLE}
                                        hint={ASK_CHAT_EVIDENCE_HINT}
                                    />
                                ) : null}
                            </div>
                        ))}
                    </div>
                    <div className="ask-matriya-typing-container">
                        {sending ? (
                            <div key="typing" className="ask-matriya-msg ask-matriya-msg-assistant">
                                <div className="ask-matriya-msg-content ask-matriya-typing">
                                    <span key="typing-indicator">מחפש תשובה...</span>
                                </div>
                            </div>
                        ) : null}
                    </div>
                    <div ref={messagesEndRef} />
                </div>

                {error && <div className="ask-matriya-error">{error}</div>}

                <div className="ask-matriya-input-row">
                    <textarea
                        className="ask-matriya-input"
                        placeholder="כתבו את השאלה..."
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={handleKeyDown}
                        rows={2}
                        disabled={
                            sending ||
                            gptRagSyncing ||
                            filesInApiOrder.length === 0 ||
                            selectedFilenames.length === 0
                        }
                    />
                    <button
                        type="button"
                        className="ask-matriya-send"
                        onClick={handleSend}
                        disabled={
                            sending ||
                            gptRagSyncing ||
                            !input.trim() ||
                            selectedFilenames.length === 0 ||
                            filesInApiOrder.length === 0
                        }
                    >
                        {sending || gptRagSyncing ? (
                            <span key="sending" className="btn-inner">שולח...</span>
                        ) : (
                            <span key="idle" className="btn-inner">שלח</span>
                        )}
                    </button>
                </div>
            </div>
        </div>
    );
}

export default AskMatriyaTab;
