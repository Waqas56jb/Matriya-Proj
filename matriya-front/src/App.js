import React, { useState, useEffect } from 'react';
import './App.css';
import SiteHeader from './components/layout/SiteHeader';
import SiteFooter from './components/layout/SiteFooter';
import UploadTab from './components/UploadTab';
import SearchTab from './components/SearchTab';
import AskMatriyaTab from './components/AskMatriyaTab';
import LoginTab from './components/LoginTab';
import AdminTab from './components/AdminTab';
import ErrorBoundary from './components/ErrorBoundary';
import axios from 'axios';
import { toast } from 'react-toastify';
import { API_BASE_URL, isMatriyaSessionInvalid401 } from './utils/api';

const TAB_SWITCH_BLOCKED_WHILE_GPT_SYNC_TITLE =
    'לא ניתן לעבור לשונית אחרת בזמן סנכרון המסמכים (מסנכרן…)';

function noop() {}

function App() {
    const [activeTab, setActiveTab] = useState('upload');
    const [user, setUser] = useState(null);
    const [isLoading, setIsLoading] = useState(true);
    const [gptRagSyncing, setGptRagSyncing] = useState(false);

    useEffect(() => {
        const storedToken = localStorage.getItem('token');
        const storedUser = localStorage.getItem('user');

        if (storedToken && storedUser) {
            try {
                const userData = JSON.parse(storedUser);
                setUser(userData);
                axios.defaults.headers.common['Authorization'] = `Bearer ${storedToken}`;
            } catch (e) {
                console.error('Error parsing stored user:', e);
            }

            axios.get('/auth/me', {
                baseURL: API_BASE_URL,
                headers: { Authorization: `Bearer ${storedToken}` },
                timeout: 10000
            })
                .then((response) => {
                    setUser(response.data);
                    localStorage.setItem('user', JSON.stringify(response.data));
                })
                .catch((error) => {
                    if (isMatriyaSessionInvalid401(error)) {
                        localStorage.removeItem('token');
                        localStorage.removeItem('user');
                        setUser(null);
                        delete axios.defaults.headers.common['Authorization'];
                    } else {
                        console.warn('Token verification failed, but keeping user logged in:', error.message);
                    }
                })
                .finally(() => {
                    setIsLoading(false);
                });
        } else {
            setIsLoading(false);
        }
    }, []);

    const handleLogin = (userData, authToken) => {
        setUser(userData);
        axios.defaults.headers.common['Authorization'] = `Bearer ${authToken}`;
    };

    const handleLogout = () => {
        setUser(null);
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        delete axios.defaults.headers.common['Authorization'];
        toast.info('התנתקת מהמערכת');
    };

    const isAdmin = user && (user.is_admin || user.username === 'admin');

    React.useEffect(() => {
        if (user && !isAdmin && activeTab === 'admin') {
            setActiveTab('upload');
        } else if (activeTab === 'lab') {
            setActiveTab('upload');
        }
    }, [user, isAdmin, activeTab]);

    const tabs = [
        { id: 'upload', label: 'העלאת מסמכים' },
        { id: 'ask', label: 'שאל את מטריה' },
        { id: 'search', label: 'מחקר והחלטות' },
        ...(isAdmin ? [{ id: 'admin', label: 'ניהול' }] : [])
    ];

    const tabNav = (
        <nav className="tabs matriya-tabs" aria-label="ניווט ראשי">
            {tabs.map((tab) => {
                const switchBlocked = gptRagSyncing && tab.id !== activeTab;
                return (
                    <button
                        key={tab.id}
                        type="button"
                        className={`tab-button ${activeTab === tab.id ? 'active' : ''}`}
                        disabled={switchBlocked}
                        title={switchBlocked ? TAB_SWITCH_BLOCKED_WHILE_GPT_SYNC_TITLE : undefined}
                        onClick={() => setActiveTab(tab.id)}
                    >
                        {tab.label}
                    </button>
                );
            })}
        </nav>
    );

    if (isLoading) {
        return (
            <div className="app-root">
                <SiteHeader user={null} onLogout={noop} />
                <main className="app-main">
                    <div className="container">
                        <div className="loading loading-screen">
                            <span className="loading-spinner" aria-hidden />
                            טוען את המערכת…
                        </div>
                    </div>
                </main>
                <SiteFooter />
            </div>
        );
    }

    if (!user) {
        return (
            <div className="app-root">
                <SiteHeader user={null} onLogout={noop} />
                <main className="app-main app-main--auth">
                    <div className="container auth-hero">
                        <p className="auth-lead">
                            חיפוש במסמכים, שאילתות מבוססות ראיות, ומסלול מעבדה עם הצגת החלטות — הכל בעברית ובשקיפות.
                        </p>
                        <LoginTab onLogin={handleLogin} />
                    </div>
                </main>
                <SiteFooter />
            </div>
        );
    }

    return (
        <div className="app-root">
            <SiteHeader user={user} onLogout={handleLogout}>
                {tabNav}
            </SiteHeader>
            <main className="app-main">
                <div className="container">
                    <div className="tab-content-wrapper" key={activeTab}>
                        <ErrorBoundary>
                            {activeTab === 'upload' && (
                                <UploadTab onGptSyncingChange={setGptRagSyncing} gptRagSyncing={gptRagSyncing} />
                            )}
                            {activeTab === 'ask' && (
                                <AskMatriyaTab onGptSyncingChange={setGptRagSyncing} gptRagSyncing={gptRagSyncing} />
                            )}
                            {activeTab === 'search' && (
                                <SearchTab onGptSyncingChange={setGptRagSyncing} gptRagSyncing={gptRagSyncing} />
                            )}
                            {activeTab === 'admin' && isAdmin && <AdminTab isAdmin={isAdmin} />}
                        </ErrorBoundary>
                    </div>
                </div>
            </main>
            <SiteFooter />
        </div>
    );
}

export default App;
