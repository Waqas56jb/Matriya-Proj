import React, { useState, useEffect } from 'react';
import {
    HiArrowUpTray,
    HiChatBubbleLeftRight,
    HiMagnifyingGlass,
    HiCog6Tooth
} from 'react-icons/hi2';
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

const MOBILE_NAV_MQ = '(max-width: 900px)';

function useMatchMedia(query) {
    const [matches, setMatches] = useState(() =>
        typeof window !== 'undefined' ? window.matchMedia(query).matches : false
    );
    useEffect(() => {
        const mq = window.matchMedia(query);
        const onChange = () => setMatches(mq.matches);
        mq.addEventListener('change', onChange);
        setMatches(mq.matches);
        return () => mq.removeEventListener('change', onChange);
    }, [query]);
    return matches;
}

const TAB_DEFS = [
    { id: 'upload', label: 'העלאת מסמכים', shortLabel: 'העלאה', Icon: HiArrowUpTray },
    { id: 'ask', label: 'שאל את מטריה', shortLabel: 'שאלה', Icon: HiChatBubbleLeftRight },
    { id: 'search', label: 'מחקר והחלטות', shortLabel: 'מחקר', Icon: HiMagnifyingGlass },
    { id: 'admin', label: 'ניהול', shortLabel: 'ניהול', Icon: HiCog6Tooth }
];

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

    const tabs = TAB_DEFS.filter((t) => t.id !== 'admin' || isAdmin);

    const isMobileNav = useMatchMedia(MOBILE_NAV_MQ);

    const renderTabNav = (variant) => tabs.map((tab) => {
        const switchBlocked = gptRagSyncing && tab.id !== activeTab;
        const Icon = tab.Icon;
        const isMobile = variant === 'mobile';
        return (
            <button
                key={tab.id}
                type="button"
                className={`tab-button ${activeTab === tab.id ? 'active' : ''} ${isMobile ? 'tab-button--mobile' : ''}`}
                disabled={switchBlocked}
                title={switchBlocked ? TAB_SWITCH_BLOCKED_WHILE_GPT_SYNC_TITLE : tab.label}
                onClick={() => setActiveTab(tab.id)}
            >
                {isMobile && Icon ? <Icon className="tab-button__icon" aria-hidden /> : null}
                <span className={isMobile ? 'tab-button__short-label' : 'tab-button__label'}>
                    {isMobile ? tab.shortLabel : tab.label}
                </span>
            </button>
        );
    });

    const tabNavDesktop = (
        <nav
            className="tabs matriya-tabs matriya-tabs--desktop"
            aria-label="ניווט ראשי"
            aria-hidden={isMobileNav}
        >
            {renderTabNav('desktop')}
        </nav>
    );

    const tabNavMobile = (
        <nav
            className="matriya-mobile-tabbar"
            aria-label="ניווט ראשי"
            aria-hidden={!isMobileNav}
        >
            {renderTabNav('mobile')}
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
        <div className="app-root app-root--logged-in">
            <SiteHeader user={user} onLogout={handleLogout}>
                {tabNavDesktop}
            </SiteHeader>
            <main className="app-main app-main--with-mobile-tabbar">
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
            {tabNavMobile}
            <SiteFooter />
        </div>
    );
}

export default App;
