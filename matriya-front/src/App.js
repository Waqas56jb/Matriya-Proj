import React, { useState, useEffect } from 'react';
import './App.css';
import UploadTab from './components/UploadTab';
import SearchTab from './components/SearchTab';
import AskMatriyaTab from './components/AskMatriyaTab';
import LoginTab from './components/LoginTab';
import AdminTab from './components/AdminTab';
import ErrorBoundary from './components/ErrorBoundary';
import axios from 'axios';
import { API_BASE_URL } from './utils/api';

const TAB_SWITCH_BLOCKED_WHILE_GPT_SYNC_TITLE =
    'לא ניתן לעבור לשונית אחרת בזמן סנכרון המסמכים (מסנכרן…)';

function App() {
    const [activeTab, setActiveTab] = useState('upload');
    const [user, setUser] = useState(null);
    const [isLoading, setIsLoading] = useState(true);
    const [gptRagSyncing, setGptRagSyncing] = useState(false);

    // Check if user is already logged in (optimized)
    useEffect(() => {
        const storedToken = localStorage.getItem('token');
        const storedUser = localStorage.getItem('user');
        
        if (storedToken && storedUser) {
            // Use stored user immediately for faster UI
            try {
                const userData = JSON.parse(storedUser);
                setUser(userData);
                axios.defaults.headers.common['Authorization'] = `Bearer ${storedToken}`;
            } catch (e) {
                console.error('Error parsing stored user:', e);
            }
            
            // Verify token in background (don't block UI)
            axios.get('/auth/me', {
                baseURL: API_BASE_URL,
                headers: { Authorization: `Bearer ${storedToken}` },
                timeout: 10000  // 10 second timeout
            })
            .then(response => {
                // Update user data if verification succeeds
                setUser(response.data);
                // Update stored user data
                localStorage.setItem('user', JSON.stringify(response.data));
            })
            .catch((error) => {
                // Only clear storage on 401 (unauthorized), not on network errors
                if (error.response?.status === 401) {
                    // Token invalid, clear storage
                    localStorage.removeItem('token');
                    localStorage.removeItem('user');
                    setUser(null);
                    delete axios.defaults.headers.common['Authorization'];
                } else {
                    // Network error or timeout - keep user logged in with stored data
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
    };

    const isAdmin = user && (user.is_admin || user.username === 'admin');

    // Ensure non-admins never stay on Admin tab (e.g. after auth state update)
    React.useEffect(() => {
        if (user && !isAdmin && activeTab === 'admin') {
            setActiveTab('upload');
        } else if (activeTab === 'lab') {
            setActiveTab('upload');
        }
    }, [user, isAdmin, activeTab]);

    const tabs = [
        { id: 'upload', label: 'העלאת מסמכים' },
        { id: 'ask', label: 'Ask Matriya' },
        { id: 'search', label: 'מחקר' },
        ...(isAdmin ? [{ id: 'admin', label: 'ניהול' }] : [])
    ];

    if (isLoading) {
        return (
            <div className="container">
                <div className="loading">טוען...</div>
            </div>
        );
    }

    // Show login if not authenticated
    if (!user) {
        return (
            <div className="container">
                <header>
                    <h1>
                        <span key="h1-text">MATRIYA – Research Intelligence System</span>
                    </h1>
                    <p className="subtitle">
                        <span key="subtitle-text">מערכת אינטליגנציה למחקר</span>
                    </p>
                </header>
                <LoginTab onLogin={handleLogin} />
            </div>
        );
    }

    return (
        <div className="container">
            <header>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                        <h1>
                            <span key="h1-text-auth">MATRIYA – Research Intelligence System</span>
                        </h1>
                        <p className="subtitle">
                            <span key="subtitle-text-auth">מערכת אינטליגנציה למחקר</span>
                        </p>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '20px', flexWrap: 'wrap' }}>
                        <span style={{ color: '#c0c0e0', fontSize: '1.05em', fontWeight: '500' }}>
                            <span key="welcome-prefix">שלום, </span>
                            <span key="user-name" style={{ color: '#667eea', fontWeight: '700' }}>
                                {user.full_name || user.username || ''}
                            </span>
                        </span>
                        <button
                            onClick={handleLogout}
                            className="logout-button"
                        >
                            התנתק
                        </button>
                    </div>
                </div>
            </header>

            <div className="tabs">
                {tabs.map(tab => {
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
                            <span key={tab.id}>{tab.label}</span>
                        </button>
                    );
                })}
            </div>

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
    );
}

export default App;
