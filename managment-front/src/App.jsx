import React from 'react';
import ReactMarkdown from 'react-markdown';
import { HiEye, HiEyeSlash } from 'react-icons/hi2';
import { BrowserRouter, Routes, Route, Link, NavLink, Outlet, useParams, useNavigate, Navigate, useLocation } from 'react-router-dom';
import { projects as projectsApi, users as usersApi, tasks as tasksApi, milestones as milestonesApi, documents as documentsApi, notes as notesApi, projectFiles as projectFilesApi, rag as ragApi, gptRag as gptRagApi, chat as chatApi, emails as emailsApi, lab as labApi, auth as authApi, getStoredToken, getStoredUser, setAuth, clearAuth, getNetworkErrorMessage } from './api';
import { LabExcelSpreadsheet } from './LabExcelSpreadsheet';
import t from './strings';

/** True when context looks like GFM markdown tables (Excel export uses this). */
function looksLikeMarkdownTables(text) {
  if (!text || typeof text !== 'string' || text.length < 30) return false;
  const lines = text.split('\n');
  let pipeRows = 0;
  let hasSep = false;
  for (const line of lines) {
    const s = line.trim();
    if (s.startsWith('|') && s.includes('|')) {
      pipeRows++;
      if (/^\|[\s\-:|]+\|/.test(s)) hasSep = true;
    }
  }
  return hasSep && pipeRows >= 2;
}

const labTableMarkdownComponents = {
  table: ({ node: _n, ...props }) => (
    <table
      style={{ borderCollapse: 'collapse', width: '100%', marginBottom: 12, fontSize: '0.9rem' }}
      {...props}
    />
  ),
  th: ({ node: _n, ...props }) => (
    <th
      style={{
        border: '1px solid var(--border, #c9ccd1)',
        padding: '8px 10px',
        textAlign: 'start',
        background: 'var(--bg-soft, #f0f2f5)',
        fontWeight: 600
      }}
      {...props}
    />
  ),
  td: ({ node: _n, ...props }) => (
    <td
      style={{ border: '1px solid var(--border, #c9ccd1)', padding: '8px 10px', textAlign: 'start' }}
      {...props}
    />
  )
};

/** Ensure we never pass an object to setError (React cannot render objects). */
function errorMessageFromResponse(err, fallback) {
  const data = err?.response?.data;
  if (data == null) return typeof fallback === 'string' ? fallback : (err?.message || 'שגיאה');
  const msg = data.error ?? data.message;
  if (typeof msg === 'string') return msg;
  if (msg && typeof msg === 'object' && typeof msg.message === 'string') return msg.message;
  return typeof fallback === 'string' ? fallback : (err?.message || 'שגיאה');
}

const SidebarProjectContext = React.createContext([null, () => {}]);

/** Sidebar only when a project is selected; otherwise full-width main */
function AuthenticatedLayout({ user, onLogout }) {
  const { id } = useParams();
  const location = useLocation();
  const isProject = Boolean(id);
  const section = location.pathname.match(/\/project\/[^/]+\/section\/([^/]+)/)?.[1];
  const [sidebarProjectName, setSidebarProjectName] = React.useState(null);

  return (
    <SidebarProjectContext.Provider value={[sidebarProjectName, setSidebarProjectName]}>
      <div className={`app-shell ${isProject ? '' : 'app-shell-no-sidebar'}`} dir="rtl">
        {isProject && (
          <aside className="sidebar">
            <div className="sidebar-brand">
              <span className="sidebar-brand-icon">🧪</span>
              <span className="sidebar-brand-text">{t.appTitle}</span>
            </div>
            {sidebarProjectName && (
              <div className="sidebar-project-title-wrap">
                <h1 className="sidebar-project-title">{sidebarProjectName}</h1>
              </div>
            )}
            <nav className="sidebar-nav">
            <NavLink to="/projects" className={({ isActive }) => (isActive ? 'active' : '')}>
              📁 {t.navProjects}
            </NavLink>
            <Link to={`/project/${id}/section/lab`} className={section === 'lab' ? 'active' : ''}>🧪 {t.navExperiments}</Link>
            <Link to={`/project/${id}/section/materials`} className={section === 'materials' ? 'active' : ''}>🧱 {t.navMaterials}</Link>
            <Link to={`/project/${id}/section/rag`} className={section === 'rag' ? 'active' : ''}>📁 {t.navDocuments}</Link>
            <Link to={`/project/${id}/section/emails`} className={section === 'emails' ? 'active' : ''}>✉️ {t.navEmails}</Link>
            <Link to={`/project/${id}/section/settings`} className={section === 'settings' ? 'active' : ''}>⚙️ {t.navSettings}</Link>
          </nav>
          <div className="sidebar-user">
            <div className="main-header-user" style={{ padding: '8px 0' }}>
              <div className="main-header-avatar">{(user?.username || user?.full_name || 'A').charAt(0).toUpperCase()}</div>
              <div>
                <div className="main-header-user-name">{user?.username || user?.full_name || ''}</div>
                <div className="main-header-user-email">{user?.email || ''}</div>
              </div>
            </div>
            <button type="button" className="secondary" style={{ width: '100%' }} onClick={onLogout}>{t.logout}</button>
          </div>
        </aside>
      )}
        <main className="main">
          <Outlet />
        </main>
      </div>
    </SidebarProjectContext.Provider>
  );
}

function Home({ user, onLogout, dashboardMode = false }) {
  const [projects, setProjects] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(null);
  const [showNew, setShowNew] = React.useState(false);
  const [newName, setNewName] = React.useState('');
  const [newDesc, setNewDesc] = React.useState('');
  const [search, setSearch] = React.useState('');
  const [requestProject, setRequestProject] = React.useState(null);
  const [requestSending, setRequestSending] = React.useState(false);
  const [creatingProject, setCreatingProject] = React.useState(false);
  const [loadingProjectId, setLoadingProjectId] = React.useState(null);
  const [totalTasks, setTotalTasks] = React.useState(0);
  const [totalFiles, setTotalFiles] = React.useState(0);
  const [totalExperiments, setTotalExperiments] = React.useState(0);
  const [totalMaterials, setTotalMaterials] = React.useState(0);
  const [recentExperimentsList, setRecentExperimentsList] = React.useState([]);
  const [recentDocumentsList, setRecentDocumentsList] = React.useState([]);
  const navigate = useNavigate();

  React.useEffect(() => {
    projectsApi.list().then(d => { setProjects(d.projects || []); setLoading(false); }).catch(e => { setError(e.message); setLoading(false); });
  }, []);

  React.useEffect(() => {
    if (projects.length === 0) { setTotalTasks(0); return; }
    Promise.all(projects.map(p => tasksApi.list(p.id)))
      .then(results => {
        const total = results.reduce((sum, r) => sum + (r.tasks || []).length, 0);
        setTotalTasks(total);
      })
      .catch(() => setTotalTasks(0));
  }, [projects]);

  React.useEffect(() => {
    if (projects.length === 0) { setTotalFiles(0); setRecentDocumentsList([]); return; }
    Promise.all(projects.map(p => projectFilesApi.list(p.id)))
      .then(results => {
        let total = 0;
        const withProject = [];
        results.forEach((r, i) => {
          const list = r.files || [];
          total += list.length;
          const proj = projects[i];
          list.forEach(f => withProject.push({ ...f, projectId: proj?.id, projectName: proj?.name || '' }));
        });
        setTotalFiles(total);
        const sorted = withProject
          .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
          .slice(0, 10);
        setRecentDocumentsList(sorted);
      })
      .catch(() => { setTotalFiles(0); setRecentDocumentsList([]); });
  }, [projects]);

  React.useEffect(() => {
    if (projects.length === 0) { setTotalExperiments(0); setTotalMaterials(0); setRecentExperimentsList([]); return; }
    const limit = Math.min(projects.length, 15);
    const slice = projects.slice(0, limit);
    Promise.all([
      ...slice.map(p => labApi.experiments(p.id, { limit: 50 }).then(r => ({ projectId: p.id, projectName: p.name, experiments: r.experiments || [] }))),
      ...slice.map(p => labApi.materialLibrary(p.id).then(r => ({ count: (r.materials || r || []).length })))
    ]).then(all => {
      const expResults = all.slice(0, limit);
      const matResults = all.slice(limit, limit * 2);
      setTotalExperiments(expResults.reduce((s, x) => s + (x.experiments || []).length, 0));
      setTotalMaterials(matResults.reduce((s, x) => s + (x.count || 0), 0));
      const flat = [];
      expResults.forEach(({ projectId, projectName, experiments }) => {
        (experiments || []).forEach(e => flat.push({ ...e, projectId, projectName }));
      });
      const sorted = flat.sort((a, b) => new Date(b.updated_at || b.created_at || 0) - new Date(a.updated_at || a.created_at || 0)).slice(0, 10);
      setRecentExperimentsList(sorted);
    }).catch(() => { setTotalExperiments(0); setTotalMaterials(0); setRecentExperimentsList([]); });
  }, [projects]);

  const filteredProjects = !search.trim() ? projects : projects.filter(p =>
    (p.name || '').toLowerCase().includes(search.toLowerCase()) ||
    (p.description || '').toLowerCase().includes(search.toLowerCase())
  );

  const onProjectClick = (p) => {
    if (loadingProjectId) return;
    setLoadingProjectId(p.id);
    projectsApi.getAccess(p.id)
      .then(access => {
        if (access.canAccess) navigate(`/project/${p.id}`);
        else setRequestProject({ project: p, hasPendingRequest: access.hasPendingRequest });
      })
      .catch(() => setRequestProject({ project: p, hasPendingRequest: false }))
      .finally(() => setLoadingProjectId(null));
  };

  const sendRequest = () => {
    if (!requestProject || requestProject.hasPendingRequest) return;
    setRequestSending(true);
    projectsApi.requestJoin(requestProject.project.id)
      .then(() => setRequestProject(prev => prev ? { ...prev, hasPendingRequest: true } : null))
      .catch(e => setError(e.response?.data?.error || e.message))
      .finally(() => setRequestSending(false));
  };

  const createProject = () => {
    if (!newName.trim()) return;
    setCreatingProject(true);
    projectsApi.create({ name: newName.trim(), description: newDesc.trim() || null })
      .then(p => { setShowNew(false); setNewName(''); setNewDesc(''); setProjects(prev => [p, ...prev]); navigate(`/project/${p.id}`); })
      .catch(e => setError(e.message))
      .finally(() => setCreatingProject(false));
  };

  const recentProjects = filteredProjects.slice(0, 5);

  return (
    <>
        <header className="main-header">
          <div className="main-header-search">
            <input type="search" placeholder={t.searchProjects} value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <div className="main-header-actions" style={{ minWidth: 0 }}>
            {user && (
              <>
                <div className="main-header-user">
                  <div className="main-header-avatar">{(user.username || user.full_name || 'A').charAt(0).toUpperCase()}</div>
                  <div>
                    <div className="main-header-user-name">{user.username || user.full_name || ''}</div>
                    <div className="main-header-user-email">{user.email || ''}</div>
                  </div>
                </div>
                <button type="button" className="secondary" onClick={onLogout}>{t.logout}</button>
              </>
            )}
          </div>
        </header>
        <div className="main-content">
          {dashboardMode && (
            <div className="dashboard-page">
              <header className="dashboard-hero">
                <div className="dashboard-hero-text">
                  <span className="dashboard-eyebrow">{t.dashboard}</span>
                  <h1 className="dashboard-hero-title">{t.dashboardMainTitle}</h1>
                  <p className="dashboard-hero-lead">{t.dashboardSubtitle}</p>
                </div>
                <button
                  type="button"
                  className="dashboard-hero-cta"
                  onClick={() => setShowNew(true)}
                  disabled={creatingProject}
                >
                  + {t.newProject}
                </button>
              </header>

              <section className="dashboard-stats-panel" aria-labelledby="dashboard-lab-stats">
                <div className="dashboard-section-heading-row">
                  <h2 id="dashboard-lab-stats" className="dashboard-section-heading">{t.labStatsTitle}</h2>
                </div>
                <ul className="dashboard-stat-grid">
                  <li className="dashboard-stat-tile dashboard-stat-tile--primary">
                    <span className="dashboard-stat-icon" aria-hidden="true">📁</span>
                    <div className="dashboard-stat-body">
                      <span className="dashboard-stat-value">{projects.length}</span>
                      <span className="dashboard-stat-label">{t.projects}</span>
                    </div>
                  </li>
                  <li className="dashboard-stat-tile">
                    <span className="dashboard-stat-icon" aria-hidden="true">📋</span>
                    <div className="dashboard-stat-body">
                      <span className="dashboard-stat-value">{totalTasks}</span>
                      <span className="dashboard-stat-label">{t.tasksCount}</span>
                    </div>
                  </li>
                  <li className="dashboard-stat-tile">
                    <span className="dashboard-stat-icon" aria-hidden="true">🧪</span>
                    <div className="dashboard-stat-body">
                      <span className="dashboard-stat-value">{totalExperiments}</span>
                      <span className="dashboard-stat-label">{t.navExperiments}</span>
                    </div>
                  </li>
                  <li className="dashboard-stat-tile">
                    <span className="dashboard-stat-icon" aria-hidden="true">🧱</span>
                    <div className="dashboard-stat-body">
                      <span className="dashboard-stat-value">{totalMaterials}</span>
                      <span className="dashboard-stat-label">{t.navMaterials}</span>
                    </div>
                  </li>
                  <li className="dashboard-stat-tile">
                    <span className="dashboard-stat-icon" aria-hidden="true">📄</span>
                    <div className="dashboard-stat-body">
                      <span className="dashboard-stat-value">{totalFiles}</span>
                      <span className="dashboard-stat-label">{t.navDocuments}</span>
                    </div>
                  </li>
                </ul>
              </section>

              {(recentProjects.length > 0 || recentExperimentsList.length > 0 || recentDocumentsList.length > 0) && (
                <section className="dashboard-recent-panel" aria-labelledby="dashboard-recent-title">
                  <div className="dashboard-section-heading-row">
                    <h2 id="dashboard-recent-title" className="dashboard-section-heading">{t.dashboardRecentSectionTitle}</h2>
                  </div>
                  <div className="dashboard-recent-grid">
                    {recentProjects.length > 0 && (
                      <article className="dashboard-recent-card dashboard-recent-card--projects">
                        <header className="dashboard-recent-card-head">
                          <h3>{t.recentActivity}</h3>
                          <span className="dashboard-recent-card-icon" aria-hidden="true">📌</span>
                        </header>
                        <ul className="dashboard-recent-list">
                          {recentProjects.map(p => (
                            <li key={p.id}>
                              <button type="button" className="dashboard-recent-link" onClick={() => onProjectClick(p)}>
                                <span className="dashboard-recent-link-title">{p.name}</span>
                                <span className="dashboard-recent-link-arrow" aria-hidden="true">‹</span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      </article>
                    )}
                    {recentExperimentsList.length > 0 && (
                      <article className="dashboard-recent-card dashboard-recent-card--lab">
                        <header className="dashboard-recent-card-head">
                          <h3>{t.recentExperiments}</h3>
                          <span className="dashboard-recent-card-icon" aria-hidden="true">🧪</span>
                        </header>
                        <ul className="dashboard-recent-list">
                          {recentExperimentsList.map((e, i) => (
                            <li key={e.id || e.experiment_id || i}>
                              <button type="button" className="dashboard-recent-link" onClick={() => navigate(`/project/${e.projectId}/section/lab`)}>
                                <span className="dashboard-recent-link-title">
                                  {(e.experiment_id || e.formula || t.navExperiments).toString().slice(0, 40)}
                                  <span className="dashboard-recent-link-meta">{e.projectName || ''}</span>
                                </span>
                                <span className="dashboard-recent-link-arrow" aria-hidden="true">‹</span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      </article>
                    )}
                    {recentDocumentsList.length > 0 && (
                      <article className="dashboard-recent-card dashboard-recent-card--docs">
                        <header className="dashboard-recent-card-head">
                          <h3>{t.recentDocuments}</h3>
                          <span className="dashboard-recent-card-icon" aria-hidden="true">📁</span>
                        </header>
                        <ul className="dashboard-recent-list">
                          {recentDocumentsList.map((f, i) => (
                            <li key={f.id || i}>
                              <button type="button" className="dashboard-recent-link" onClick={() => navigate(`/project/${f.projectId}/section/rag`)}>
                                <span className="dashboard-recent-link-title">
                                  {(f.original_name || f.filename || '').slice(0, 35)}{(f.original_name || f.filename || '').length > 35 ? '…' : ''}
                                  <span className="dashboard-recent-link-meta">{f.projectName || ''}</span>
                                </span>
                                <span className="dashboard-recent-link-arrow" aria-hidden="true">‹</span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      </article>
                    )}
                  </div>
                </section>
              )}
            </div>
          )}
          {!dashboardMode && (
            <>
              <h1 className="page-title">{t.projects}</h1>
              <p className="page-subtitle">נהל את הפרויקטים והמשימות שלך במקום אחד.</p>
            </>
          )}
          {error && <p className="error">{error}</p>}
          {!dashboardMode && (
            <div className="main-content-toolbar">
              <button onClick={() => setShowNew(!showNew)}>{showNew ? t.cancel : `+ ${t.newProject}`}</button>
            </div>
          )}
          {dashboardMode && showNew && (
            <div className="dashboard-toolbar-compact">
              <button type="button" className="secondary" onClick={() => setShowNew(false)} disabled={creatingProject}>{t.cancel}</button>
            </div>
          )}
        {showNew && (
          <div className={`card${dashboardMode ? ' dashboard-inline-card' : ''}`}>
            <h3>{t.newProject}</h3>
            <div className="form-group"><label>{t.name}</label><input value={newName} onChange={e => setNewName(e.target.value)} placeholder={t.projectName} /></div>
            <div className="form-group"><label>{t.description}</label><textarea value={newDesc} onChange={e => setNewDesc(e.target.value)} placeholder={t.optional} rows={2} /></div>
            <div className="flex gap"><button onClick={createProject} disabled={creatingProject} className={creatingProject ? 'btn-loading' : ''}>{creatingProject ? t.loading : t.create}</button><button className="secondary" onClick={() => setShowNew(false)} disabled={creatingProject}>{t.cancel}</button></div>
          </div>
        )}
        {loading && <p className="loading">{t.loading}</p>}
        {dashboardMode && !loading && (
          <section className="dashboard-projects-block" aria-labelledby="dashboard-projects-heading">
            <div className="dashboard-projects-intro">
              <h2 id="dashboard-projects-heading" className="dashboard-section-heading">{t.dashboardYourProjects}</h2>
              <p className="dashboard-projects-meta">{t.dashboardProjectsMeta(filteredProjects.length)}</p>
            </div>
          </section>
        )}
        {!loading && (
          <div className={`grid-2${dashboardMode ? ' dashboard-projects-grid' : ''}`}>
            {filteredProjects.map(p => (
              <div key={p.id} className={`project-card ${loadingProjectId === p.id ? 'project-card-loading' : ''}`} onClick={() => onProjectClick(p)}>
                {loadingProjectId === p.id ? (
                  <p className="loading" style={{ margin: 0 }}>{t.loading}</p>
                ) : (
                  <>
                    <h3>{p.name}</h3>
                    <p>{p.description || t.noDescription}</p>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
        {!loading && filteredProjects.length === 0 && !showNew && <p className="loading">{search.trim() ? t.noResults : t.noProjectsYet}</p>}

        </div>
        {requestProject && (
          <div className="modal-overlay" onClick={() => setRequestProject(null)}>
            <div className="card modal" onClick={e => e.stopPropagation()}>
              <h3>{requestProject.project.name}</h3>
              <p className="error">{t.notPartOfProject}</p>
              {requestProject.hasPendingRequest ? (
                <p style={{ color: 'var(--muted)' }}>{t.requestPending}</p>
              ) : (
                <p>{t.sendRequestToOwner}</p>
              )}
              <div className="flex gap">
                {!requestProject.hasPendingRequest && (
                  <button onClick={sendRequest} disabled={requestSending}>{requestSending ? t.loading : t.sendRequestToOwner}</button>
                )}
                <button className="secondary" onClick={() => setRequestProject(null)}>{t.cancel}</button>
              </div>
            </div>
          </div>
        )}
    </>
  );
}

const TABS = ['overview', 'tasks', 'milestones', 'notes', 'lab', 'materials', 'rag', 'emails', 'chat', 'settings'];
/** Dashboard tiles only — settings stays in sidebar (`/section/settings`). */
const WIDGET_TABS = TABS.filter(id => id !== 'settings');
const TAB_LABELS = { overview: `📊 ${t.overview}`, tasks: `📋 ${t.tasks}`, milestones: `🎯 ${t.milestones}`, notes: `📝 ${t.notes}`, lab: `🧪 ${t.labTab}`, materials: `🧱 ${t.materialLibraryTab}`, rag: `📁 ${t.docsManagementTab}`, emails: `✉️ ${t.emailsTab}`, chat: `💬 ${t.chat}`, settings: `⚙️ ${t.settings}` };
const TAB_TITLES = { overview: t.overview, tasks: t.tasks, milestones: t.milestones, notes: t.notes, lab: t.labTab, materials: t.materialLibraryTab, rag: t.docsManagementTab, emails: t.emailsTab, chat: t.chat, settings: t.settings };

function ProjectView({ user, onLogout }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const [project, setProject] = React.useState(null);
  const [projectRole, setProjectRole] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(null);

  const [, setSidebarProjectName] = React.useContext(SidebarProjectContext);
  React.useEffect(() => {
    if (!id) return;
    Promise.all([projectsApi.get(id), projectsApi.getAccess(id)])
      .then(([proj, access]) => { setProject(proj); setProjectRole(access.role); })
      .catch(e => setError(e.response?.data?.error || e.message))
      .finally(() => setLoading(false));
  }, [id]);
  React.useEffect(() => {
    setSidebarProjectName(null);
    return () => setSidebarProjectName(null);
  }, [id, setSidebarProjectName]);
  React.useEffect(() => {
    if (project?.name) setSidebarProjectName(project.name);
  }, [project?.name, setSidebarProjectName]);

  const [overviewCounts, setOverviewCounts] = React.useState({ tasks: 0, tasksDone: 0, milestones: 0, milestonesDone: 0, notes: 0, materials: 0 });
  const [chatUnreadCount, setChatUnreadCount] = React.useState(0);
  React.useEffect(() => {
    if (!id) return;
    Promise.all([tasksApi.list(id), milestonesApi.list(id), notesApi.list(id), labApi.materialLibrary(id)])
      .then(([tRes, mRes, nRes, matRes]) => {
        const tasks = tRes.tasks || [];
        const milestones = mRes.milestones || [];
        const notes = nRes.notes || [];
        const materials = matRes.materials || [];
        const tasksDone = tasks.filter(t => t.status === 'done').length;
        const milestonesDone = milestones.filter(m => m.completed_at).length;
        setOverviewCounts({ tasks: tasks.length, tasksDone, milestones: milestones.length, milestonesDone, notes: notes.length, materials: materials.length });
      })
      .catch(() => {});
  }, [id]);

  const { sectionId } = useParams();
  const [fullScreenSectionState, setFullScreenSectionState] = React.useState(null);
  const fullScreenSection = (sectionId && TABS.includes(sectionId) ? sectionId : null) || fullScreenSectionState;
  const setFullScreenSection = (s) => {
    setFullScreenSectionState(s);
    if (s) {
      navigate(`/project/${id}/section/${s}`, { replace: true });
    } else {
      navigate(`/project/${id}`, { replace: true });
    }
  };
  React.useEffect(() => {
    if (sectionId && TABS.includes(sectionId)) setFullScreenSectionState(sectionId);
  }, [sectionId]);

  const refreshChatUnread = React.useCallback(() => {
    if (!id) return;
    chatApi
      .unread(id)
      .then(({ unread }) => setChatUnreadCount(Number(unread) || 0))
      .catch(() => {});
  }, [id]);

  React.useEffect(() => {
    refreshChatUnread();
  }, [id, fullScreenSection, refreshChatUnread]);

  React.useEffect(() => {
    if (!id) return undefined;
    const timer = setInterval(refreshChatUnread, 20000);
    const onFocus = () => refreshChatUnread();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [id, refreshChatUnread]);

  if (loading || !project) return <div className="main-content"><p className="loading">{t.loading}</p></div>;
  if (error) return <div className="main-content"><p className="error">{error}</p><button onClick={() => navigate('/')}>{t.back}</button></div>;

  const taskPending = overviewCounts.tasks - overviewCounts.tasksDone;

  return (
    <>
        <header className="main-header">
          <div className="main-header-search">
            <input type="search" placeholder="חיפוש משימה..." dir="rtl" />
          </div>
          <div className="main-header-actions">
            <Link to="/" className="header-link">📊 {t.allProjects}</Link>
            {user && (
              <>
                <div className="main-header-user">
                  <div className="main-header-avatar">{(user.username || user.full_name || 'A').charAt(0).toUpperCase()}</div>
                  <div>
                    <div className="main-header-user-name">{user.username || user.full_name || ''}</div>
                    <div className="main-header-user-email">{user.email || ''}</div>
                  </div>
                </div>
                <button type="button" className="secondary" onClick={onLogout}>{t.logout}</button>
              </>
            )}
          </div>
        </header>
        <div className="main-content">
          <div className="overview-cards-row">
            <div className="overview-card-item primary">
              <span className="card-icon">📋</span>
              <div className="overview-card-value">{overviewCounts.tasks}</div>
              <div className="overview-card-label">{t.tasksCount}</div>
              <div className="overview-card-meta">{overviewCounts.tasksDone} {t.completed}</div>
            </div>
            <div className="overview-card-item">
              <span className="card-icon">✓</span>
              <div className="overview-card-value">{overviewCounts.tasksDone}</div>
              <div className="overview-card-label">{t.completed}</div>
              <div className="overview-card-meta">{t.tasks}</div>
            </div>
            <div className="overview-card-item">
              <span className="card-icon">🎯</span>
              <div className="overview-card-value">{overviewCounts.milestones}</div>
              <div className="overview-card-label">{t.milestonesCount}</div>
              <div className="overview-card-meta">{overviewCounts.milestonesDone} {t.completedMilestones}</div>
            </div>
            <div className="overview-card-item">
              <span className="card-icon">📝</span>
              <div className="overview-card-value">{overviewCounts.notes}</div>
              <div className="overview-card-label">{t.notesCount}</div>
              <div className="overview-card-meta">{t.notes}</div>
            </div>
          </div>
          <div className="widgets-grid">
            {WIDGET_TABS.map(tabId => (
              <button key={tabId} type="button" className="widget-card" onClick={() => setFullScreenSection(tabId)}>
                <span className="widget-card-icon-wrapper">
                  <span className="widget-card-icon">{tabId === 'overview' ? '📊' : tabId === 'tasks' ? '📋' : tabId === 'milestones' ? '🎯' : tabId === 'notes' ? '📝' : tabId === 'lab' ? '🧪' : tabId === 'materials' ? '🧱' : tabId === 'rag' ? '📁' : tabId === 'emails' ? '✉️' : '💬'}</span>
                  {tabId === 'chat' && chatUnreadCount > 0 && (
                    <span className="widget-card-badge" aria-label={t.chatUnreadCount(chatUnreadCount)}>{chatUnreadCount > 99 ? '99+' : chatUnreadCount}</span>
                  )}
                </span>
                <span className="widget-card-title">{TAB_TITLES[tabId]}</span>
                {tabId === 'overview' && <span className="widget-card-meta">{overviewCounts.tasks} {t.tasks}, {overviewCounts.milestones} {t.milestones}</span>}
                {tabId === 'tasks' && <span className="widget-card-meta">{overviewCounts.tasks} {t.tasks}</span>}
                {tabId === 'milestones' && <span className="widget-card-meta">{overviewCounts.milestones} {t.milestones}</span>}
                {tabId === 'notes' && <span className="widget-card-meta">{overviewCounts.notes} {t.notes}</span>}
                {tabId === 'materials' && <span className="widget-card-meta">{overviewCounts.materials} {t.navMaterials}</span>}
                {tabId === 'chat' && chatUnreadCount > 0 && <span className="widget-card-meta">{t.chatNewMessages(chatUnreadCount)}</span>}
              </button>
            ))}
          </div>
          {fullScreenSection && (
            <div className="fullscreen-overlay" role="dialog" aria-modal="true" aria-label={TAB_LABELS[fullScreenSection]}>
              <div className="fullscreen-content">
                <div className="fullscreen-header">
                  <h2 className="fullscreen-title">{TAB_LABELS[fullScreenSection]}</h2>
                  <button type="button" className="fullscreen-close" onClick={() => setFullScreenSection(null)} aria-label={t.cancel}>×</button>
                </div>
                <div className="fullscreen-body modal-scroll">
                  {fullScreenSection === 'overview' && <Overview projectId={id} project={project} />}
                  {fullScreenSection === 'tasks' && <TasksTab projectId={id} />}
                  {fullScreenSection === 'milestones' && <MilestonesTab projectId={id} />}
                  {fullScreenSection === 'notes' && <NotesTab projectId={id} />}
                  {fullScreenSection === 'lab' && <LabTab projectId={id} />}
                  {fullScreenSection === 'materials' && <MaterialsLibraryTab projectId={id} />}
                  {fullScreenSection === 'rag' && <RagTab projectId={id} />}
                  {fullScreenSection === 'emails' && <EmailsTab projectId={id} />}
                  {fullScreenSection === 'chat' && <ChatTab projectId={id} onUnreadChange={refreshChatUnread} />}
                  {fullScreenSection === 'settings' && <SettingsTab projectId={id} project={project} setProject={setProject} navigate={navigate} projectRole={projectRole} user={user} />}
                </div>
              </div>
            </div>
          )}
        </div>
    </>
  );
}

function isOverdueDate(dateStr) {
  if (!dateStr) return false;
  return dateStr < new Date().toISOString().slice(0, 10);
}

function Overview({ projectId, project }) {
  const [tasks, setTasks] = React.useState([]);
  const [milestones, setMilestones] = React.useState([]);
  const [notesCount, setNotesCount] = React.useState(0);
  const [filesCount, setFilesCount] = React.useState(0);
  const [experimentsSummary, setExperimentsSummary] = React.useState(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    Promise.all([
      tasksApi.list(projectId),
      milestonesApi.list(projectId),
      notesApi.list(projectId),
      projectFilesApi.list(projectId)
    ]).then(([tRes, mRes, nRes, fRes]) => {
      setTasks(tRes.tasks || []);
      setMilestones(mRes.milestones || []);
      setNotesCount((nRes.notes || []).length);
      setFilesCount((fRes.files || []).length);
      setLoading(false);
    });
  }, [projectId]);

  React.useEffect(() => {
    labApi.experiments(projectId).then(r => {
      const experiments = r.experiments || [];
      const success = experiments.filter(e => (e.experiment_outcome || '').toLowerCase() === 'success').length;
      const failure = experiments.filter(e => ['failure', 'partial', 'failed'].includes((e.experiment_outcome || '').toLowerCase())).length;
      const openCount = experiments.length - success - failure;
      setExperimentsSummary({ total: experiments.length, success, failure, open: openCount });
    }).catch(() => setExperimentsSummary(null));
  }, [projectId]);

  const taskDone = tasks.filter(x => x.status === 'done').length;
  const progress = tasks.length ? Math.round((taskDone / tasks.length) * 100) : 0;
  const statusBreakdown = { todo: 0, in_progress: 0, done: 0 };
  tasks.forEach(t => {
    const s = t.status === 'in_review' ? 'in_progress' : t.status;
    if (statusBreakdown[s] !== undefined) statusBreakdown[s]++;
  });
  const maxStatus = Math.max(1, ...Object.values(statusBreakdown));
  const overdueTasks = tasks.filter(t => t.status !== 'done' && isOverdueDate(t.due_date));
  const milestonesDone = milestones.filter(m => m.completed_at).length;
  const milestonesProgress = milestones.length ? Math.round((milestonesDone / milestones.length) * 100) : 0;
  const priorityBreakdown = { high: 0, medium: 0, low: 0 };
  tasks.forEach(t => { if (priorityBreakdown[t.priority] !== undefined) priorityBreakdown[t.priority]++; });
  const maxPriority = Math.max(1, ...Object.values(priorityBreakdown));
  const upcoming = milestones.filter(m => !m.completed_at && m.due_date).sort((a, b) => (a.due_date || '').localeCompare(b.due_date || '')).slice(0, 5);

  const exportSummary = () => {
    const name = (project && project.name) || 'project';
    const lines = [name, project && project.description ? project.description : '', '', '--- משימות ---', ...tasks.map(x => `[${x.status}] ${x.priority} ${x.title}${x.due_date ? ' (' + x.due_date + ')' : ''}`), '', '--- אבני דרך ---', ...milestones.map(m => `${m.completed_at ? '[✓]' : '[ ]'} ${m.title}${m.due_date ? ' — ' + m.due_date : ''}${m.description ? '\n  ' + m.description : ''}`)];
    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${name.replace(/[^\w\s-]/g, '')}_summary.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  if (loading) return <div className="card tab-card"><p className="loading">{t.loading}</p></div>;

  return (
    <div className="card tab-card overview-card">
      <div className="flex" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', marginBottom: 16 }}>
        <h3>{t.overview}</h3>
        <button type="button" className="secondary" onClick={exportSummary}>{t.exportSummary}</button>
      </div>

      {experimentsSummary && experimentsSummary.total > 0 && (
        <div className="overview-experiments-summary">
          <label>{t.experimentsSummary}</label>
          <div className="overview-summary overview-summary-inline">
            <span>{t.labExperiments}: <strong>{experimentsSummary.total}</strong></span>
            <span>{t.successes}: <strong>{experimentsSummary.success}</strong></span>
            <span>{t.failures}: <strong>{experimentsSummary.failure}</strong></span>
            <span>{t.openExperiments}: <strong>{experimentsSummary.open}</strong></span>
          </div>
        </div>
      )}

      <div className="overview-summary">
        <span>{t.tasksCount}: <strong>{tasks.length}</strong></span>
        <span>{t.milestonesCount}: <strong>{milestones.length}</strong></span>
        <span>{t.notesCount}: <strong>{notesCount}</strong></span>
        <span>{t.filesCount}: <strong>{filesCount}</strong></span>
      </div>

      {tasks.length > 0 && (
        <>
          <div className="overview-section">
            <label>{t.taskProgress}</label>
            <div className="overview-stats-inline">{taskDone} / {tasks.length} {t.completed} — {progress}%</div>
            <div className="progress-bar"><div className="progress-fill" style={{ width: `${progress}%` }} /></div>
          </div>

          <div className="overview-section">
            <label>{t.taskStatusBreakdown}</label>
            <div className="overview-bar-chart">
              {TASK_COLUMNS.map(col => (
                <div key={col} className="overview-bar-row">
                  <span className="overview-bar-legend">{TASK_COLUMN_LABELS[col]}</span>
                  <div className="overview-bar-track">
                    <div className={`overview-bar-segment overview-bar-${col}`} style={{ width: `${(statusBreakdown[col] / maxStatus) * 100}%` }} />
                  </div>
                  <span className="overview-bar-value">{statusBreakdown[col]}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="overview-section">
            <label>{t.byPriority}</label>
            <div className="overview-bar-chart">
              {['high', 'medium', 'low'].map(p => (
                <div key={p} className="overview-bar-row">
                  <span className="overview-bar-legend">{p === 'high' ? t.high : p === 'medium' ? t.medium : t.low}</span>
                  <div className="overview-bar-track">
                    <div className={`overview-bar-segment overview-bar-priority-${p}`} style={{ width: `${(priorityBreakdown[p] / maxPriority) * 100}%` }} />
                  </div>
                  <span className="overview-bar-value">{priorityBreakdown[p]}</span>
                </div>
              ))}
            </div>
          </div>

          {overdueTasks.length > 0 && (
            <div className="overview-section overview-overdue">
              <label>{t.overdueTasks} ({overdueTasks.length})</label>
              <ul className="upcoming-list">
                {overdueTasks.slice(0, 8).map(t => <li key={t.id}>{t.title}{t.due_date ? ' — ' + t.due_date : ''}</li>)}
              </ul>
              {overdueTasks.length > 8 && <p style={{ color: 'var(--muted)', fontSize: '0.9rem' }}>+{overdueTasks.length - 8} עוד</p>}
            </div>
          )}
          {overdueTasks.length === 0 && tasks.some(t => t.status !== 'done') && <p style={{ color: 'var(--success)', fontSize: '0.9rem', marginTop: 8 }}>{t.noOverdue}</p>}
        </>
      )}

      {milestones.length > 0 && (
        <div className="overview-section">
          <label>{t.milestonesProgress}</label>
          <div className="overview-stats-inline">{milestonesDone} / {milestones.length} {t.completedMilestones} — {milestonesProgress}%</div>
          <div className="progress-bar"><div className="progress-fill" style={{ width: `${milestonesProgress}%` }} /></div>
        </div>
      )}

      {upcoming.length > 0 && (
        <div className="overview-section">
          <label>{t.upcomingMilestones}</label>
          <ul className="upcoming-list">
            {upcoming.map(m => <li key={m.id}>{m.title} — {m.due_date}</li>)}
          </ul>
        </div>
      )}
      {milestones.length > 0 && upcoming.length === 0 && <p style={{ color: 'var(--muted)', marginTop: 8 }}>{t.noUpcomingMilestones}</p>}
    </div>
  );
}

function isOverdue(dateStr) {
  if (!dateStr) return false;
  return dateStr < new Date().toISOString().slice(0, 10);
}

// Only three statuses: לביצוע, בביצוע, הושלם (בדיקה/בבדיקה removed)
const TASK_COLUMNS = ['todo', 'in_progress', 'done'];
const TASK_COLUMN_LABELS = { todo: t.todo, in_progress: t.inProgress, done: t.done };

function TasksTab({ projectId }) {
  const [list, setList] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [showNew, setShowNew] = React.useState(false);
  const [title, setTitle] = React.useState('');
  const [status, setStatus] = React.useState('todo');
  const [priority, setPriority] = React.useState('medium');
  const [search, setSearch] = React.useState('');
  const [creating, setCreating] = React.useState(false);
  const [removingId, setRemovingId] = React.useState(null);

  const load = () => tasksApi.list(projectId).then(d => { setList(d.tasks || []); setLoading(false); });
  React.useEffect(() => { load(); }, [projectId]);

  const create = () => {
    if (!title.trim()) return;
    setCreating(true);
    const today = new Date().toISOString().slice(0, 10);
    tasksApi.create(projectId, { title: title.trim(), status, priority, due_date: today })
      .then(() => { setTitle(''); setShowNew(false); load(); })
      .finally(() => setCreating(false));
  };

  const updateStatus = (taskId, newStatus) => {
    tasksApi.update(projectId, taskId, { status: newStatus }).then(load);
  };

  const remove = (taskId) => {
    if (!window.confirm(t.deleteTaskConfirm)) return;
    setRemovingId(taskId);
    tasksApi.delete(projectId, taskId).then(load).finally(() => setRemovingId(null));
  };

  const priorityLabel = (p) => ({ low: t.low, medium: t.medium, high: t.high }[p] || p);
  const filteredList = !search.trim() ? list : list.filter(task => (task.title || '').toLowerCase().includes(search.toLowerCase()));
  const byColumn = TASK_COLUMNS.reduce((acc, col) => {
    acc[col] = filteredList.filter(t => t.status === col || (col === 'in_progress' && t.status === 'in_review'));
    return acc;
  }, {});

  return (
    <div className="card tab-card tasks-kanban">
      <div className="flex" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', marginBottom: 16 }}>
        <h3>{t.tasks}</h3>
        <div className="flex gap" style={{ flexWrap: 'wrap' }}>
          <input type="search" placeholder={t.searchInList} value={search} onChange={e => setSearch(e.target.value)} style={{ maxWidth: 180 }} />
          <button onClick={() => setShowNew(!showNew)}>{showNew ? t.cancel : `+ ${t.addTask}`}</button>
        </div>
      </div>
      {showNew && (
        <div className="form-group flex gap" style={{ flexWrap: 'wrap', marginBottom: 16, padding: 12, background: 'var(--bg)', borderRadius: 8 }}>
          <input placeholder={t.taskTitle} value={title} onChange={e => setTitle(e.target.value)} style={{ maxWidth: 280 }} />
          <select value={status} onChange={e => setStatus(e.target.value)} style={{ width: 120 }}>
            {TASK_COLUMNS.map(col => <option key={col} value={col}>{TASK_COLUMN_LABELS[col]}</option>)}
          </select>
          <select value={priority} onChange={e => setPriority(e.target.value)} style={{ width: 100 }}>
            <option value="low">{t.low}</option>
            <option value="medium">{t.medium}</option>
            <option value="high">{t.high}</option>
          </select>
          <button onClick={create} disabled={creating} className={creating ? 'btn-loading' : ''}>{creating ? t.loading : t.add}</button>
        </div>
      )}
      {loading && <p className="loading">{t.loading}</p>}
      {!loading && (
        <div className="kanban-board">
          {TASK_COLUMNS.map(col => (
            <div key={col} className="kanban-column">
              <div className="kanban-column-header">
                <span>{TASK_COLUMN_LABELS[col]}</span>
                <span className="kanban-count">{(byColumn[col] || []).length}</span>
              </div>
              <div className="kanban-column-cards">
                {(byColumn[col] || []).map(task => (
                  <div key={task.id} className={`kanban-card ${task.status !== 'done' && isOverdue(task.due_date) ? 'overdue' : ''}`}>
                    <div className="kanban-card-body">
                      <span className={`badge badge-${task.priority}`}>{priorityLabel(task.priority)}</span>
                      <span className="kanban-card-title">{task.title}</span>
                      {task.due_date && <span className="kanban-card-meta">{task.due_date}{task.status !== 'done' && isOverdue(task.due_date) ? ' · ' + t.overdue : ''}</span>}
                    </div>
                    <div className="kanban-card-actions">
                      <select value={task.status === 'in_review' ? 'in_progress' : task.status} onChange={e => updateStatus(task.id, e.target.value)} className="kanban-move-select" aria-label={t.tasks}>
                        {TASK_COLUMNS.map(c => <option key={c} value={c}>{TASK_COLUMN_LABELS[c]}</option>)}
                      </select>
                      <button type="button" className={`secondary kanban-delete ${removingId === task.id ? 'btn-loading' : ''}`} onClick={() => remove(task.id)} disabled={removingId === task.id}>{removingId === task.id ? t.loading : t.delete}</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      {!loading && list.length === 0 && <p className="loading">{t.noTasksYet}</p>}
    </div>
  );
}

function MilestonesTab({ projectId }) {
  const [list, setList] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [showNew, setShowNew] = React.useState(false);
  const [title, setTitle] = React.useState('');
  const [dueDate, setDueDate] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [search, setSearch] = React.useState('');
  const [sortBy, setSortBy] = React.useState('date');
  const [creating, setCreating] = React.useState(false);
  const [togglingId, setTogglingId] = React.useState(null);
  const [removingId, setRemovingId] = React.useState(null);

  const load = () => milestonesApi.list(projectId).then(d => { setList(d.milestones || []); setLoading(false); });
  React.useEffect(() => { load(); }, [projectId]);

  const create = () => {
    if (!title.trim()) return;
    setCreating(true);
    milestonesApi.create(projectId, { title: title.trim(), due_date: dueDate || null, description: description.trim() || null })
      .then(() => { setTitle(''); setDueDate(''); setDescription(''); setShowNew(false); load(); })
      .finally(() => setCreating(false));
  };

  let filteredList = !search.trim() ? list : list.filter(m => (m.title || '').toLowerCase().includes(search.toLowerCase()) || (m.description || '').toLowerCase().includes(search.toLowerCase()));
  filteredList = [...filteredList].sort((a, b) => sortBy === 'title' ? (a.title || '').localeCompare(b.title || '') : (a.due_date || '').localeCompare(b.due_date || ''));

  const toggleComplete = (m) => {
    setTogglingId(m.id);
    milestonesApi.update(projectId, m.id, { completed_at: m.completed_at ? null : new Date().toISOString() }).then(load).finally(() => setTogglingId(null));
  };

  const remove = (milestoneId) => {
    if (!window.confirm(t.deleteMilestoneConfirm)) return;
    setRemovingId(milestoneId);
    milestonesApi.delete(projectId, milestoneId).then(load).finally(() => setRemovingId(null));
  };

  return (
    <div className="card tab-card">
      <div className="flex" style={{ justifyContent: 'space-between', marginBottom: 16 }}>
        <h3>{t.milestones}</h3>
        <button onClick={() => setShowNew(!showNew)}>{showNew ? t.cancel : `+ ${t.addMilestone}`}</button>
      </div>
      {showNew && (
        <div className="form-group" style={{ marginBottom: 16 }}>
          <div className="flex gap" style={{ flexWrap: 'wrap' }}>
            <input placeholder={t.milestoneTitle} value={title} onChange={e => setTitle(e.target.value)} style={{ maxWidth: 280 }} />
            <input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} style={{ width: 160 }} />
            <button onClick={create} disabled={creating} className={creating ? 'btn-loading' : ''}>{creating ? t.loading : t.add}</button>
          </div>
          <label className="mt-8">{t.milestoneDescription}</label>
          <textarea value={description} onChange={e => setDescription(e.target.value)} placeholder={t.optional} rows={2} style={{ marginTop: 4 }} />
        </div>
      )}
      <div className="flex gap" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
        <input type="search" placeholder={t.searchInList} value={search} onChange={e => setSearch(e.target.value)} style={{ maxWidth: 240 }} />
        <select value={sortBy} onChange={e => setSortBy(e.target.value)} style={{ width: 120 }}>
          <option value="date">{t.sortByDate}</option>
          <option value="title">{t.sortByTitle}</option>
        </select>
      </div>
      {loading && <p className="loading">{t.loading}</p>}
      {!loading && filteredList.map(m => (
        <div key={m.id} className={`list-item ${!m.completed_at && isOverdue(m.due_date) ? 'overdue' : ''}`}>
            <span>
              {m.title} {m.due_date && <span style={{ color: 'var(--muted)' }}>({m.due_date}{!m.completed_at && isOverdue(m.due_date) ? ' · ' + t.overdue : ''})</span>} {m.description && <span style={{ color: 'var(--muted)', fontSize: '0.9rem', display: 'block', marginTop: 4 }}>{m.description}</span>}
              <button type="button" className={`secondary ${togglingId === m.id ? 'btn-loading' : ''}`} style={{ marginTop: 6 }} onClick={() => toggleComplete(m)} disabled={togglingId === m.id}>{togglingId === m.id ? t.loading : (m.completed_at ? t.unmarkCompleted : t.markAsCompleted)}</button>
            </span>
          <button className={`secondary ${removingId === m.id ? 'btn-loading' : ''}`} onClick={() => remove(m.id)} disabled={removingId === m.id}>{removingId === m.id ? t.loading : t.delete}</button>
        </div>
      ))}
      {!loading && list.length === 0 && <p className="loading">{t.noMilestonesYet}</p>}
      {!loading && list.length > 0 && filteredList.length === 0 && <p className="loading">{t.noResults}</p>}
    </div>
  );
}

function DocumentsTab({ projectId }) {
  const [list, setList] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [showNew, setShowNew] = React.useState(false);
  const [editing, setEditing] = React.useState(null);
  const [title, setTitle] = React.useState('');
  const [content, setContent] = React.useState('');
  const [search, setSearch] = React.useState('');
  const [creating, setCreating] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [removingId, setRemovingId] = React.useState(null);

  const load = () => documentsApi.list(projectId).then(d => { setList(d.documents || []); setLoading(false); });
  React.useEffect(() => { load(); }, [projectId]);

  const filteredList = !search.trim() ? list : list.filter(d => (d.title || '').toLowerCase().includes(search.toLowerCase()) || (d.content || '').toLowerCase().includes(search.toLowerCase()));

  const create = () => {
    if (!title.trim()) return;
    setCreating(true);
    documentsApi.create(projectId, { title: title.trim(), content: content.trim() || null })
      .then(() => { setTitle(''); setContent(''); setShowNew(false); load(); })
      .finally(() => setCreating(false));
  };

  const saveEdit = () => {
    if (!editing || !title.trim()) return;
    setSaving(true);
    documentsApi.update(projectId, editing.id, { title: title.trim(), content: content.trim() || null })
      .then(() => { setEditing(null); setTitle(''); setContent(''); load(); })
      .finally(() => setSaving(false));
  };

  const remove = (docId) => {
    if (!window.confirm(t.deleteDocumentConfirm)) return;
    setRemovingId(docId);
    documentsApi.delete(projectId, docId).then(load).finally(() => setRemovingId(null));
  };

  return (
    <div className="card tab-card">
      <div className="flex" style={{ justifyContent: 'space-between', marginBottom: 16 }}>
        <h3>{t.documents}</h3>
        <button onClick={() => { setShowNew(!showNew); setEditing(null); }}>{showNew ? t.cancel : `+ ${t.addDocument}`}</button>
      </div>
      {showNew && !editing && (
        <div className="form-group" style={{ marginBottom: 16 }}>
          <label>{t.title}</label>
          <input value={title} onChange={e => setTitle(e.target.value)} placeholder={t.documentTitle} />
          <label className="mt-16">{t.content}</label>
          <textarea value={content} onChange={e => setContent(e.target.value)} placeholder={t.optionalContent} rows={4} />
          <div className="flex gap mt-16"><button onClick={create} disabled={creating} className={creating ? 'btn-loading' : ''}>{creating ? t.loading : t.create}</button></div>
        </div>
      )}
      {editing && (
        <div className="form-group" style={{ marginBottom: 16 }}>
          <label>{t.title}</label>
          <input value={title} onChange={e => setTitle(e.target.value)} />
          <label className="mt-16">{t.content}</label>
          <textarea value={content} onChange={e => setContent(e.target.value)} rows={4} />
          <div className="flex gap mt-16"><button onClick={saveEdit} disabled={saving} className={saving ? 'btn-loading' : ''}>{saving ? t.loading : t.save}</button><button className="secondary" onClick={() => { setEditing(null); setTitle(''); setContent(''); }} disabled={saving}>{t.cancel}</button></div>
        </div>
      )}
      <div style={{ marginBottom: 12 }}>
        <input type="search" placeholder={t.searchInList} value={search} onChange={e => setSearch(e.target.value)} style={{ maxWidth: 240 }} />
      </div>
      {loading && <p className="loading">{t.loading}</p>}
      {!loading && filteredList.map(d => (
        <div key={d.id} className="list-item">
          <span>{d.title}</span>
          <div className="flex gap">
            <button className="secondary" onClick={() => { setEditing(d); setTitle(d.title); setContent(d.content || ''); setShowNew(false); }} disabled={saving}>{t.edit}</button>
            <button className={`secondary ${removingId === d.id ? 'btn-loading' : ''}`} onClick={() => remove(d.id)} disabled={removingId === d.id}>{removingId === d.id ? t.loading : t.delete}</button>
          </div>
        </div>
      ))}
      {!loading && list.length === 0 && <p className="loading">{t.noDocumentsYet}</p>}
      {!loading && list.length > 0 && filteredList.length === 0 && <p className="loading">{t.noResults}</p>}
    </div>
  );
}

function NotesTab({ projectId }) {
  const [list, setList] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [showNew, setShowNew] = React.useState(false);
  const [editing, setEditing] = React.useState(null);
  const [title, setTitle] = React.useState('');
  const [body, setBody] = React.useState('');
  const [search, setSearch] = React.useState('');
  const [creating, setCreating] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [removingId, setRemovingId] = React.useState(null);

  const load = () => notesApi.list(projectId).then(d => { setList(d.notes || []); setLoading(false); });
  React.useEffect(() => { load(); }, [projectId]);

  const filteredList = !search.trim() ? list : list.filter(n => (n.title || '').toLowerCase().includes(search.toLowerCase()) || (n.body || '').toLowerCase().includes(search.toLowerCase()));

  const create = () => {
    setCreating(true);
    notesApi.create(projectId, { title: title.trim() || t.untitled, body: body.trim() || null })
      .then(() => { setTitle(''); setBody(''); setShowNew(false); load(); })
      .finally(() => setCreating(false));
  };

  const saveEdit = () => {
    if (!editing) return;
    setSaving(true);
    notesApi.update(projectId, editing.id, { title: title.trim() || t.untitled, body: body.trim() || null })
      .then(() => { setEditing(null); setTitle(''); setBody(''); load(); })
      .finally(() => setSaving(false));
  };

  const remove = (noteId) => {
    if (!window.confirm(t.deleteNoteConfirm)) return;
    setRemovingId(noteId);
    notesApi.delete(projectId, noteId).then(load).finally(() => setRemovingId(null));
  };

  return (
    <div className="card tab-card">
      <div className="flex" style={{ justifyContent: 'space-between', marginBottom: 16 }}>
        <h3>{t.notes}</h3>
        <button onClick={() => { setShowNew(!showNew); setEditing(null); }}>{showNew ? t.cancel : `+ ${t.addNote}`}</button>
      </div>
      {showNew && !editing && (
        <div className="form-group" style={{ marginBottom: 16 }}>
          <label>{t.title}</label>
          <input value={title} onChange={e => setTitle(e.target.value)} placeholder={t.noteTitle} />
          <label className="mt-16">{t.body}</label>
          <textarea value={body} onChange={e => setBody(e.target.value)} placeholder={t.noteContent} rows={4} />
          <div className="flex gap mt-16"><button onClick={create} disabled={creating} className={creating ? 'btn-loading' : ''}>{creating ? t.loading : t.create}</button></div>
        </div>
      )}
      {editing && (
        <div className="form-group" style={{ marginBottom: 16 }}>
          <label>{t.title}</label>
          <input value={title} onChange={e => setTitle(e.target.value)} />
          <label className="mt-16">{t.body}</label>
          <textarea value={body} onChange={e => setBody(e.target.value)} rows={4} />
          <div className="flex gap mt-16"><button onClick={saveEdit} disabled={saving} className={saving ? 'btn-loading' : ''}>{saving ? t.loading : t.save}</button><button className="secondary" onClick={() => { setEditing(null); setTitle(''); setBody(''); }} disabled={saving}>{t.cancel}</button></div>
        </div>
      )}
      <div style={{ marginBottom: 12 }}>
        <input type="search" placeholder={t.searchInList} value={search} onChange={e => setSearch(e.target.value)} style={{ maxWidth: 240 }} />
      </div>
      {loading && <p className="loading">{t.loading}</p>}
      {!loading && filteredList.map(n => (
        <div key={n.id} className="list-item">
          <span>{n.title || t.untitled}</span>
          <div className="flex gap">
            <button className="secondary" onClick={() => { setEditing(n); setTitle(n.title || ''); setBody(n.body || ''); setShowNew(false); }} disabled={saving}>{t.edit}</button>
            <button className={`secondary ${removingId === n.id ? 'btn-loading' : ''}`} onClick={() => remove(n.id)} disabled={removingId === n.id}>{removingId === n.id ? t.loading : t.delete}</button>
          </div>
        </div>
      ))}
      {!loading && list.length === 0 && <p className="loading">{t.noNotesYet}</p>}
      {!loading && list.length > 0 && filteredList.length === 0 && <p className="loading">{t.noResults}</p>}
    </div>
  );
}

function MaterialsLibraryTab({ projectId }) {
  const [rows, setRows] = React.useState([]);
  const [stats, setStats] = React.useState({ materials_count: 0, linked_experiments_count: 0, experiments_count: 0 });
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(null);
  const [name, setName] = React.useState('');
  const [role, setRole] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [search, setSearch] = React.useState('');

  const load = React.useCallback(() => {
    setLoading(true);
    setError(null);
    labApi
      .materialsOverview(projectId)
      .then((d) => {
        setRows(Array.isArray(d.materials) ? d.materials : []);
        setStats(d.stats || { materials_count: 0, linked_experiments_count: 0, experiments_count: 0 });
      })
      .catch((err) => setError(err.response?.data?.error || err.message))
      .finally(() => setLoading(false));
  }, [projectId]);

  React.useEffect(() => {
    if (projectId) load();
  }, [projectId, load]);

  const addMaterial = () => {
    const nm = name.trim();
    if (!nm) return;
    setSaving(true);
    setError(null);
    labApi
      .addMaterial(projectId, { name: nm, role_or_function: role.trim() || null })
      .then(() => {
        setName('');
        setRole('');
        load();
      })
      .catch((err) => setError(err.response?.data?.error || err.message))
      .finally(() => setSaving(false));
  };

  const filtered = rows.filter((r) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    const hay = `${r.material_name || ''} ${r.role_or_function || ''}`.toLowerCase();
    return hay.includes(q);
  });

  return (
    <div className="card tab-card">
      <h3>{t.materialLibraryTitle}</h3>
      <p className="muted" style={{ marginBottom: 12 }}>{t.materialLibraryIntro}</p>
      <p className="muted" style={{ marginBottom: 12 }}>
        {stats.materials_count || 0} {t.navMaterials} · {stats.linked_experiments_count || 0} {t.linkedExperiments} · {stats.experiments_count || 0} {t.labExperiments}
      </p>

      <div className="rag-section" style={{ marginBottom: 16 }}>
        <h4 style={{ fontSize: '1rem', marginBottom: 8 }}>{t.addMaterialToLibrary}</h4>
        <div className="flex gap" style={{ flexWrap: 'wrap' }}>
          <input className="form-control" value={name} onChange={(e) => setName(e.target.value)} placeholder={t.materialNamePlaceholder} style={{ flex: '1 1 220px' }} />
          <input className="form-control" value={role} onChange={(e) => setRole(e.target.value)} placeholder={t.materialRoleOrFunction} style={{ flex: '1 1 260px' }} />
          <button type="button" onClick={addMaterial} disabled={saving || !name.trim()}>{saving ? t.loading : t.add}</button>
        </div>
      </div>

      <div style={{ marginBottom: 12 }}>
        <input type="search" placeholder={t.searchInList} value={search} onChange={e => setSearch(e.target.value)} style={{ maxWidth: 260 }} />
      </div>

      {loading && <p className="loading">{t.loading}</p>}
      {error && <p className="error">{error}</p>}
      {!loading && !error && filtered.length === 0 && <p className="muted">{t.noMaterialsYet}</p>}
      {!loading && !error && filtered.length > 0 && (
        <div style={{ display: 'grid', gap: 10 }}>
          {filtered.map((row) => (
            <div key={row.material_name} className="list-item" style={{ alignItems: 'flex-start', flexDirection: 'column' }}>
              <div style={{ fontWeight: 600 }}>{row.material_name}</div>
              <div className="muted">{t.materialRoleOrFunction}: {row.role_or_function || '—'}</div>
              <div className="muted">{t.linkedExperiments}: {row.experiment_count || 0}</div>
              {Array.isArray(row.linked_experiments) && row.linked_experiments.length > 0 && (
                <div className="muted" style={{ fontSize: '0.88rem' }}>
                  {row.linked_experiments.slice(0, 6).map((link) => {
                    const pct = typeof link.percentage === 'number' ? `, ${link.percentage}${link.unit || '%'}` : '';
                    return `${link.experiment_id || '—'}${link.experiment_outcome ? ` (${link.experiment_outcome}${pct})` : pct ? ` (${pct.slice(2)})` : ''}`;
                  }).join(' · ')}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const LAB_AI_SECTION_IDS = ['insights', 'contradictions', 'failure-patterns', 'snapshot', 'formula-validate', 'formulation-intelligence', 'similar-experiments', 'relations', 'guard', 'experiments', 'suggestion-engine'];

function LabTab({ projectId }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [experiments, setExperiments] = React.useState([]);
  const [sessions, setSessions] = React.useState([]);
  const [materials, setMaterials] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(null);
  const [contradictions, setContradictions] = React.useState(null);
  const [failurePatterns, setFailurePatterns] = React.useState(null);
  const [snapshot, setSnapshot] = React.useState(null);
  const [relations, setRelations] = React.useState(null);
  const [insights, setInsights] = React.useState(null);
  const [formulaValidateInput, setFormulaValidateInput] = React.useState('');
  const [formulaValidateResult, setFormulaValidateResult] = React.useState(null);
  const [guardInput, setGuardInput] = React.useState('');
  const [guardResult, setGuardResult] = React.useState(null);
  const [formulationInput, setFormulationInput] = React.useState('');
  const [formulationResult, setFormulationResult] = React.useState(null);
  const [saveFormulationLoading, setSaveFormulationLoading] = React.useState(false);
  const [saveFormulationFeedback, setSaveFormulationFeedback] = React.useState(null);
  const [saveExperimentIdOptional, setSaveExperimentIdOptional] = React.useState('');
  const [similarExperimentId, setSimilarExperimentId] = React.useState('');
  const [similarResult, setSimilarResult] = React.useState(null);
  const [activeSection, setActiveSection] = React.useState('insights');
  const [experimentContext, setExperimentContext] = React.useState('');
  /** Structured sheets from last .xlsx/.xls parse (for spreadsheet UI only). */
  const [labExcelSheets, setLabExcelSheets] = React.useState(null);
  const [aiResultBySection, setAiResultBySection] = React.useState({});
  const [aiLoadingSection, setAiLoadingSection] = React.useState(null);
  const [savedExperiments, setSavedExperiments] = React.useState([]);
  const [savedExperimentName, setSavedExperimentName] = React.useState('');
  const [showSaveExperimentModal, setShowSaveExperimentModal] = React.useState(false);
  const [savingExperiment, setSavingExperiment] = React.useState(false);
  const [deletingSavedId, setDeletingSavedId] = React.useState(null);
  const labFileInputRef = React.useRef(null);
  const [emailImportLabLoading, setEmailImportLabLoading] = React.useState(false);
  const [compareTextA, setCompareTextA] = React.useState('');
  const [compareTextB, setCompareTextB] = React.useState('');
  const [compareLabelA, setCompareLabelA] = React.useState('גרסה A');
  const [compareLabelB, setCompareLabelB] = React.useState('גרסה B');
  const [compareExpA, setCompareExpA] = React.useState('');
  const [compareExpB, setCompareExpB] = React.useState('');
  const [compareResult, setCompareResult] = React.useState(null);
  const [compareLoading, setCompareLoading] = React.useState(false);
  const [compareError, setCompareError] = React.useState(null);

  /** After "ייבא למעבדה" from email: use server-parsed text if present, else fetch file + parse. */
  React.useEffect(() => {
    const payload = location.state && location.state.labEmailImport;
    if (!payload || !projectId) return undefined;
    if (payload.prefetchedText != null) {
      setError(null);
      setExperimentContext(String(payload.prefetchedText));
      setLabExcelSheets(
        Array.isArray(payload.prefetchedExcelSheets) && payload.prefetchedExcelSheets.length > 0
          ? payload.prefetchedExcelSheets
          : null
      );
      navigate(`/project/${projectId}/section/lab`, { replace: true, state: {} });
      return undefined;
    }
    if (!payload.fileId) return undefined;
    const { fileId, originalName } = payload;
    let cancelled = false;
    setEmailImportLabLoading(true);
    setError(null);
    projectFilesApi
      .fetchBlob(projectId, fileId)
      .then(async (blob) => {
        if (cancelled) return;
        const name = (originalName && String(originalName).trim()) || 'file';
        const lower = name.toLowerCase();
        const useParseApi =
          lower.endsWith('.xlsx') ||
          lower.endsWith('.xls') ||
          lower.endsWith('.csv') ||
          lower.endsWith('.txt') ||
          lower.endsWith('.json') ||
          lower.endsWith('.pdf');
        const file = new File([blob], name, { type: blob.type || 'application/octet-stream' });
        if (useParseApi) {
          const d = await labApi.parseExperimentFile(projectId, file);
          if (cancelled) return;
          setExperimentContext(d.text ?? '');
          setLabExcelSheets(Array.isArray(d.excelSheets) && d.excelSheets.length > 0 ? d.excelSheets : null);
        } else {
          const text = await blob.text();
          if (cancelled) return;
          setExperimentContext(text);
          setLabExcelSheets(null);
        }
        navigate(`/project/${projectId}/section/lab`, { replace: true, state: {} });
      })
      .catch((err) => {
        if (!cancelled) setError(errorMessageFromResponse(err, t.emailImportLabParseError));
      })
      .finally(() => {
        if (!cancelled) setEmailImportLabLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [location.state, projectId, navigate]);

  const load = () => {
    setLoading(true);
    setError(null);
    Promise.all([
      labApi.experiments(projectId),
      labApi.researchSessions(projectId),
      labApi.materialLibrary(projectId)
    ]).then(([eRes, sRes, mRes]) => {
      setExperiments(eRes.experiments || []);
      setSessions(sRes.sessions || []);
      setMaterials(mRes.materials || []);
      setLoading(false);
    }).catch(err => { setError(err.response?.data?.error || err.message); setLoading(false); });
  };
  React.useEffect(() => { if (projectId) load(); }, [projectId]);
  React.useEffect(() => { if (projectId && activeSection === 'insights' && !insights) loadInsights(); }, [projectId, activeSection]);

  const loadSavedExperiments = () => {
    if (!projectId) return;
    labApi.savedExperiments.list(projectId).then(d => setSavedExperiments(d.saved || [])).catch(() => setSavedExperiments([]));
  };
  React.useEffect(() => { if (projectId) loadSavedExperiments(); }, [projectId]);

  const saveExperiment = () => {
    const name = savedExperimentName.trim();
    if (!name) { setError(t.labSavedExperimentNameRequired); return; }
    if (!experimentContext.trim()) { setError(t.labSavedExperimentContentRequired); return; }
    setSavingExperiment(true);
    setError(null);
    labApi.savedExperiments.save(projectId, { name, content: experimentContext })
      .then(() => { setSavedExperimentName(''); setShowSaveExperimentModal(false); loadSavedExperiments(); setError(null); })
      .catch(err => setError(err.response?.data?.error || err.message))
      .finally(() => setSavingExperiment(false));
  };

  const loadSavedExperiment = (item) => {
    setExperimentContext(item.content || '');
    setLabExcelSheets(null);
    setError(null);
  };

  const deleteSavedExperiment = (id) => {
    if (!window.confirm(t.labSavedExperimentDeleteConfirm)) return;
    setDeletingSavedId(id);
    labApi.savedExperiments.delete(projectId, id).then(loadSavedExperiments).catch(err => setError(err.response?.data?.error || err.message)).finally(() => setDeletingSavedId(null));
  };

  const loadContradictions = () => labApi.analysis.contradictions(projectId).then(d => setContradictions(d)).catch(() => setContradictions({ contradictions: [] }));
  const loadFailurePatterns = () => labApi.analysis.failurePatterns(projectId).then(d => setFailurePatterns(d)).catch(() => setFailurePatterns(null));
  const loadSnapshot = () => labApi.analysis.researchSnapshot(projectId).then(d => setSnapshot(d)).catch(() => setSnapshot(null));
  const loadRelations = () => labApi.analysis.relations(projectId).then(d => setRelations(d)).catch(() => setRelations(null));
  const loadInsights = () => labApi.analysis.insights(projectId).then(d => setInsights(d)).catch(() => setInsights(null));

  const runFormulaValidate = () => {
    setFormulaValidateResult(null);
    labApi.analysis.formulaValidate(projectId, { formula: formulaValidateInput }).then(d => setFormulaValidateResult(d)).catch(err => setFormulaValidateResult({ valid: false, errors: [err.response?.data?.error || err.message] }));
  };
  const runGuard = () => {
    setGuardResult(null);
    labApi.guard(projectId, { formula: guardInput }).then(d => setGuardResult(d)).catch(err => setGuardResult({ allowed: false, warnings: [{ message: err.response?.data?.error || err.message }] }));
  };
  const runFormulationIntelligence = () => {
    setFormulationResult(null);
    const body = { formula: formulationInput };
    try {
      const parsed = formulationInput.trim() ? JSON.parse(formulationInput) : {};
      if (typeof parsed === 'object' && parsed !== null) {
        body.formula = parsed.formula ?? formulationInput;
        body.domain = parsed.domain;
        body.materials = parsed.materials;
        body.percentages = parsed.percentages;
      }
    } catch (_) { body.formula = formulationInput; }
    labApi.analysis.formulationIntelligence(projectId, body).then(d => setFormulationResult(d)).catch(err => setFormulationResult({ status: 'Risk', issues: [{ message: err.response?.data?.error || err.message }] }));
  };

  const buildFormulationSavePayload = () => {
    const raw = formulationInput.trim();
    if (!raw) return null;
    const body = {};
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) {
        if (parsed.formula != null) body.formula = parsed.formula;
        if (parsed.domain != null) body.domain = parsed.domain;
        if (parsed.technology_domain != null) body.technology_domain = parsed.technology_domain;
        if (parsed.materials != null) body.materials = parsed.materials;
        if (parsed.percentages != null) body.percentages = parsed.percentages;
        if (Object.keys(body).length === 0) body.formula = raw;
      } else {
        body.formula = raw;
      }
    } catch {
      body.formula = raw;
    }
    if (saveExperimentIdOptional.trim()) body.experiment_id = saveExperimentIdOptional.trim();
    return body;
  };

  const saveFormulationAsExperiment = () => {
    const body = buildFormulationSavePayload();
    if (!body) {
      setError(t.labFormulationSaveNeedInput);
      return;
    }
    setSaveFormulationLoading(true);
    setSaveFormulationFeedback(null);
    setError(null);
    labApi
      .saveExperimentFromFormulation(projectId, body)
      .then((d) => {
        const id = d.experiment?.experiment_id || '';
        const matN = d.materials_written || 0;
        setSaveFormulationFeedback(
          `${t.labSaveAsExperimentSuccess(id)} ${t.labSaveAsExperimentMaterialsCount(matN)}`.trim()
        );
        load();
      })
      .catch((err) => {
        setSaveFormulationFeedback(null);
        setError(errorMessageFromResponse(err, t.labSaveAsExperiment));
      })
      .finally(() => setSaveFormulationLoading(false));
  };

  const runSimilarExperiments = () => {
    setSimilarResult(null);
    labApi.analysis.similarExperiments(projectId, similarExperimentId.trim()).then(d => setSimilarResult(d)).catch(err => setSimilarResult({ error: err.response?.data?.error || err.message }));
  };

  const handleLabFileChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const name = (file.name || '').toLowerCase();
    if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
      setError(null);
      labApi.parseExperimentFile(projectId, file)
        .then((d) => {
          setExperimentContext(d.text ?? '');
          setLabExcelSheets(Array.isArray(d.excelSheets) && d.excelSheets.length > 0 ? d.excelSheets : null);
        })
        .catch((err) => setError(err.response?.data?.error || err.message));
    } else {
      const reader = new FileReader();
      reader.onload = () => {
        setExperimentContext(String(reader.result ?? ''));
        setLabExcelSheets(null);
        setError(null);
      };
      reader.onerror = () => setError('שגיאה בקריאת הקובץ');
      reader.readAsText(file, 'utf-8');
    }
    e.target.value = '';
  };

  const runComparePercentages = () => {
    setCompareError(null);
    setCompareResult(null);
    const expA = compareExpA.trim();
    const expB = compareExpB.trim();
    const ta = compareTextA.trim();
    const tb = compareTextB.trim();
    if (expA && expB) {
      setCompareLoading(true);
      labApi
        .comparePercentages(projectId, {
          experimentIdA: expA,
          experimentIdB: expB,
          labelA: compareLabelA.trim() || 'גרסה A',
          labelB: compareLabelB.trim() || 'גרסה B'
        })
        .then((d) => setCompareResult(d))
        .catch((err) => setCompareError(err.response?.data?.error || err.message))
        .finally(() => setCompareLoading(false));
      return;
    }
    if (ta && !tb) {
      setCompareLoading(true);
      labApi
        .comparePercentages(projectId, {
          textA: ta,
          textB: '',
          labelA: compareLabelA.trim() || 'גרסה A',
          labelB: compareLabelB.trim() || 'גרסה B'
        })
        .then((d) => setCompareResult(d))
        .catch((err) => setCompareError(err.response?.data?.error || err.message))
        .finally(() => setCompareLoading(false));
      return;
    }
    if (!ta || !tb) {
      setCompareError(t.labComparisonNeedInput);
      return;
    }
    setCompareLoading(true);
    labApi
      .comparePercentages(projectId, {
        textA: ta,
        textB: tb,
        labelA: compareLabelA.trim() || 'גרסה A',
        labelB: compareLabelB.trim() || 'גרסה B'
      })
      .then((d) => setCompareResult(d))
      .catch((err) => setCompareError(err.response?.data?.error || err.message))
      .finally(() => setCompareLoading(false));
  };

  const fetchAiInsight = (sectionId) => {
    if (!experimentContext.trim()) { setError(t.labAiNeedContext); return; }
    setAiLoadingSection(sectionId);
    setError(null);
    labApi.aiInsight(projectId, { experimentContext: experimentContext.trim(), insightType: sectionId })
      .then((d) => {
        setAiResultBySection(prev => ({ ...prev, [sectionId]: d.text }));
      })
      .catch((err) => setError(err.response?.data?.error || err.message))
      .finally(() => setAiLoadingSection(null));
  };

  const sections = [
    { id: 'insights', label: t.labInsights },
    { id: 'contradictions', label: t.labContradictions },
    { id: 'failure-patterns', label: t.labFailurePatterns },
    { id: 'snapshot', label: t.labResearchSnapshot },
    { id: 'formula-validate', label: t.labFormulaValidator },
    { id: 'comparison-percentages', label: t.labComparisonPercentages },
    { id: 'formulation-intelligence', label: t.labFormulationIntelligence },
    { id: 'similar-experiments', label: t.labSimilarExperiments },
    { id: 'relations', label: t.labRelations },
    { id: 'guard', label: t.labResearchGuard },
    { id: 'experiments', label: t.labExperimentsList },
    { id: 'suggestion-engine', label: t.labSuggestionEngine }
  ];

  if (loading && experiments.length === 0 && !experimentContext.trim() && !emailImportLabLoading) {
    return <div className="card tab-card"><p className="loading">{t.loading}</p></div>;
  }
  if (error) return <div className="card tab-card"><p className="error">{error}</p><button type="button" className="secondary" onClick={load}>{t.retry}</button></div>;

  return (
    <div className="card tab-card">
      <h3 style={{ marginBottom: 16 }}>{t.labTab}</h3>
      {emailImportLabLoading && <p className="loading" style={{ marginBottom: 12 }} aria-live="polite">{t.emailImportLabLoading}</p>}

      <section className="rag-section" style={{ marginBottom: 20 }}>
        <p className="muted" style={{ marginBottom: 8, fontSize: '0.9rem' }}>{t.labExperimentInputHint}</p>
        <div className="flex gap" style={{ flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
          <input
            ref={labFileInputRef}
            type="file"
            accept=".pdf,.txt,.csv,.json,.xlsx,.xls"
            onChange={handleLabFileChange}
            className="rag-file-input-hidden"
            id="lab-experiment-file"
            aria-label={t.labUploadExperimentFile}
          />
          <label htmlFor="lab-experiment-file" className="rag-file-button" style={{ cursor: 'pointer' }}>{t.labUploadExperimentFile}</label>
        </div>
        {labExcelSheets && labExcelSheets.length > 0 ? (
          <>
            <p className="muted" style={{ margin: '0 0 8px 0', fontSize: '0.85rem', fontWeight: 600 }}>
              {t.labExcelTablePreview}
            </p>
            <div style={{ marginBottom: 12, maxWidth: '100%', overflow: 'hidden' }}>
              <LabExcelSpreadsheet sheets={labExcelSheets} sheetTabsLabel={t.labExcelSheetTabsAria} />
            </div>
            <details style={{ marginBottom: 8 }}>
              <summary style={{ cursor: 'pointer', fontSize: '0.9rem', color: 'var(--muted, #666)' }}>
                {t.labExcelShowRawForAi}
              </summary>
              <textarea
                className="form-control"
                dir="auto"
                rows={6}
                placeholder={t.labExperimentInputPlaceholder}
                value={experimentContext}
                onChange={(e) => {
                  setExperimentContext(e.target.value);
                  setLabExcelSheets(null);
                  setError(null);
                }}
                style={{ width: '100%', marginTop: 8 }}
              />
            </details>
          </>
        ) : (
          <>
            <textarea
              className="form-control"
              dir="auto"
              rows={6}
              placeholder={t.labExperimentInputPlaceholder}
              value={experimentContext}
              onChange={(e) => {
                setExperimentContext(e.target.value);
                setLabExcelSheets(null);
                setError(null);
              }}
              style={{ width: '100%', marginBottom: 8 }}
            />
            {looksLikeMarkdownTables(experimentContext) && (
              <div
                className="lab-excel-table-preview"
                style={{
                  marginBottom: 12,
                  padding: 12,
                  borderRadius: 8,
                  border: '1px solid var(--border, #c9ccd1)',
                  background: 'var(--card-bg, #fff)',
                  maxHeight: 360,
                  overflow: 'auto'
                }}
              >
                <p className="muted" style={{ margin: '0 0 10px 0', fontSize: '0.85rem', fontWeight: 600 }}>
                  {t.labExcelTablePreview}
                </p>
                <div className="rag-result-markdown" dir="auto">
                  <ReactMarkdown components={labTableMarkdownComponents}>{experimentContext}</ReactMarkdown>
                </div>
              </div>
            )}
          </>
        )}
        <div className="flex gap" style={{ flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 8 }}>
          <button type="button" className="rag-file-button" disabled={!experimentContext.trim()} onClick={() => setShowSaveExperimentModal(true)}>
            {t.labSaveExperiment}
          </button>
        </div>
        {showSaveExperimentModal && (
          <div className="modal-overlay" onClick={() => !savingExperiment && setShowSaveExperimentModal(false)} role="dialog" aria-modal="true" aria-label={t.labSaveExperiment}>
            <div className="modal card" onClick={e => e.stopPropagation()} style={{ maxWidth: 360 }}>
              <h4 style={{ margin: '0 0 12px 0', fontSize: '1rem' }}>{t.labSaveExperiment}</h4>
              <label style={{ display: 'block', marginBottom: 4, fontSize: '0.9rem' }}>{t.labSavedExperimentNamePlaceholder}</label>
              <input
                type="text"
                className="form-control"
                placeholder={t.labSavedExperimentNamePlaceholder}
                value={savedExperimentName}
                onChange={e => setSavedExperimentName(e.target.value)}
                style={{ width: '100%', marginBottom: 12 }}
                aria-label={t.labSavedExperimentNamePlaceholder}
                autoFocus
              />
              <div className="flex gap">
                <button type="button" className="secondary" onClick={() => setShowSaveExperimentModal(false)} disabled={savingExperiment}>{t.cancel}</button>
                <button type="button" className="rag-file-button" disabled={savingExperiment || !savedExperimentName.trim()} onClick={saveExperiment}>
                  {savingExperiment ? t.loading : t.save}
                </button>
              </div>
            </div>
          </div>
        )}
      </section>

      <div className="form-group" style={{ marginBottom: 16, maxWidth: 360 }}>
        <label htmlFor="lab-section-select" style={{ display: 'block', marginBottom: 6, fontSize: '0.9rem', fontWeight: 500 }}>{t.labAnalysisType}</label>
        <select
          id="lab-section-select"
          className="form-control"
          value={activeSection}
          onChange={(e) => {
            const sectionId = e.target.value;
            setActiveSection(sectionId);
            if (experimentContext.trim() && LAB_AI_SECTION_IDS.includes(sectionId) && !aiResultBySection[sectionId] && aiLoadingSection !== sectionId) fetchAiInsight(sectionId);
            if (!experimentContext.trim()) {
              if (sectionId === 'contradictions' && !contradictions) loadContradictions();
              if (sectionId === 'failure-patterns' && !failurePatterns) loadFailurePatterns();
              if (sectionId === 'snapshot' && !snapshot) loadSnapshot();
              if (sectionId === 'relations' && !relations) loadRelations();
              if (sectionId === 'insights') loadInsights();
            }
          }}
          style={{ width: '100%', padding: '10px 12px', fontSize: '1rem' }}
          aria-label={t.labAnalysisType}
        >
          {sections.map(s => (
            <option key={s.id} value={s.id}>{s.label}</option>
          ))}
        </select>
      </div>

      {experimentContext.trim() && LAB_AI_SECTION_IDS.includes(activeSection) && (
        <section className="rag-section">
          {aiLoadingSection === activeSection && <p className="loading">{t.labAiThinking}</p>}
          {!aiLoadingSection && aiResultBySection[activeSection] && (
            <>
              <div className="rag-result rag-result-markdown" style={{ marginBottom: 12 }}>
                <ReactMarkdown>{aiResultBySection[activeSection]}</ReactMarkdown>
              </div>
              <div className="flex gap" style={{ flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                <button type="button" className="secondary" onClick={() => fetchAiInsight(activeSection)}>{t.refresh}</button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    const text = aiResultBySection[activeSection];
                    if (!text || !String(text).trim()) return;
                    const sectionLabel = sections.find(s => s.id === activeSection)?.label || t.labTab;
                    navigate(`/project/${projectId}/section/emails`, {
                      state: {
                        fromLabEmail: {
                          body: String(text).trim(),
                          subject: `${t.labEmailSubjectPrefix}${sectionLabel}`
                        }
                      }
                    });
                  }}
                >
                  {t.labSendAsEmail}
                </button>
              </div>
            </>
          )}
          {!aiLoadingSection && !aiResultBySection[activeSection] && (
            <button type="button" className="rag-file-button" onClick={() => fetchAiInsight(activeSection)}>{t.labGetAiInsight}</button>
          )}
        </section>
      )}

      {activeSection === 'insights' && !experimentContext.trim() && (
        <section className="rag-section">
          {insights ? (
            <div>
              <p><strong>{t.labInsightsSummary}</strong> {insights.total_experiments} {t.labExperiments}, {insights.success_rate_pct}% {t.labSuccessRate}, {insights.failure_count} {t.labFailures}.</p>
              {insights.by_domain?.length > 0 && <div style={{ marginTop: 12 }}><label>{t.labByDomain}</label><ul style={{ margin: 0, paddingRight: 20 }}>{insights.by_domain.slice(0, 10).map((d, i) => <li key={i}>{d.domain}: {d.total} ({d.success_rate}% success)</li>)}</ul></div>}
            </div>
          ) : <p className="muted">{t.labLoadInsights}</p>}
          <button type="button" className="secondary" onClick={loadInsights} style={{ marginTop: 8 }}>{t.refresh}</button>
        </section>
      )}

      {activeSection === 'contradictions' && !experimentContext.trim() && (
        <section className="rag-section">
          {contradictions && <div><p>{contradictions.contradictions?.length ? t.labContradictionsFound(contradictions.contradictions.length) : t.labNoContradictions}</p>{contradictions.contradictions?.map((c, i) => <div key={i} className="card" style={{ marginTop: 8, padding: 12 }}><strong>{t.labSameFormulaDifferentOutcomes}</strong><ul style={{ margin: 0, paddingRight: 20 }}>{c.experiments?.map((e, j) => <li key={j}>{e.experiment_id}: {e.experiment_outcome}</li>)}</ul></div>)}</div>}
          <button type="button" className="secondary" onClick={loadContradictions}>{contradictions ? t.refresh : t.load}</button>
        </section>
      )}

      {activeSection === 'failure-patterns' && !experimentContext.trim() && (
        <section className="rag-section">
          {failurePatterns && <div><p>{t.labFailureCount(failurePatterns.failure_count)}</p><p>{t.labByDomain}</p><ul style={{ margin: 0, paddingRight: 20 }}>{(failurePatterns.by_domain || []).map(([name, count], i) => <li key={i}>{name}: {count}</li>)}</ul><p style={{ marginTop: 8 }}>{t.labByMaterial}</p><ul style={{ margin: 0, paddingRight: 20 }}>{(failurePatterns.by_material || []).slice(0, 15).map(([name, count], i) => <li key={i}>{name}: {count}</li>)}</ul></div>}
          <button type="button" className="secondary" onClick={loadFailurePatterns}>{failurePatterns ? t.refresh : t.load}</button>
        </section>
      )}

      {activeSection === 'snapshot' && !experimentContext.trim() && (
        <section className="rag-section">
          {snapshot && <div><p>{t.labSnapshotTotal(snapshot.total)}</p><p>success: {snapshot.outcomes?.success ?? 0}, failure: {snapshot.outcomes?.failure ?? 0}, partial: {snapshot.outcomes?.partial ?? 0}, production: {snapshot.outcomes?.production_formula ?? 0}</p>{(snapshot.by_domain?.length > 0) && <ul style={{ margin: 0, paddingRight: 20 }}>{snapshot.by_domain.map(([d, n], i) => <li key={i}>{d}: {n}</li>)}</ul>}</div>}
          <button type="button" className="secondary" onClick={loadSnapshot}>{snapshot ? t.refresh : t.load}</button>
        </section>
      )}

      {activeSection === 'formula-validate' && !experimentContext.trim() && (
        <section className="rag-section">
          <label>{t.labFormulaValidator}</label>
          <textarea className="form-control" dir="ltr" rows={3} placeholder={t.labFormulaPlaceholder} value={formulaValidateInput} onChange={e => setFormulaValidateInput(e.target.value)} />
          <button type="button" onClick={runFormulaValidate} style={{ marginTop: 8 }}>{t.validate}</button>
          {formulaValidateResult && <div style={{ marginTop: 12, padding: 12, background: 'var(--bg-soft)', borderRadius: 8 }}><p>{formulaValidateResult.valid !== false ? t.labFormulaValid : t.labFormulaInvalid}</p>{(formulaValidateResult.warnings || []).length > 0 && <ul style={{ paddingRight: 20 }}>{formulaValidateResult.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}{(formulaValidateResult.errors || []).length > 0 && <ul style={{ paddingRight: 20 }}>{formulaValidateResult.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>}{(formulaValidateResult.similar_experiments || []).length > 0 && <p>{t.labSimilarExperiments}: {formulaValidateResult.similar_experiments.length}</p>}</div>}
        </section>
      )}

      {activeSection === 'comparison-percentages' && (
        <section className="rag-section">
          <p className="muted" style={{ marginBottom: 12 }}>{t.labComparisonPercentagesHint}</p>
          <div style={{ display: 'grid', gap: 12, maxWidth: 720 }}>
            <div className="flex gap" style={{ flexWrap: 'wrap', gap: 8 }}>
              <input type="text" className="form-control" style={{ flex: '1 1 140px' }} value={compareLabelA} onChange={e => setCompareLabelA(e.target.value)} placeholder={t.labComparisonLabelA} aria-label={t.labComparisonLabelA} />
              <input type="text" className="form-control" style={{ flex: '1 1 140px' }} value={compareLabelB} onChange={e => setCompareLabelB(e.target.value)} placeholder={t.labComparisonLabelB} aria-label={t.labComparisonLabelB} />
            </div>
            <div>
              <label style={{ display: 'block', marginBottom: 4, fontSize: '0.9rem' }}>{t.labComparisonExperimentA}</label>
              <select className="form-control" value={compareExpA} onChange={e => setCompareExpA(e.target.value)} aria-label={t.labComparisonExperimentA}>
                <option value="">{t.labComparisonPickExperiment}</option>
                {experiments.map((e) => (
                  <option key={`ca-${e.id}`} value={e.experiment_id}>{e.experiment_id}</option>
                ))}
              </select>
            </div>
            <div>
              <label style={{ display: 'block', marginBottom: 4, fontSize: '0.9rem' }}>{t.labComparisonExperimentB}</label>
              <select className="form-control" value={compareExpB} onChange={e => setCompareExpB(e.target.value)} aria-label={t.labComparisonExperimentB}>
                <option value="">{t.labComparisonPickExperiment}</option>
                {experiments.map((e) => (
                  <option key={`cb-${e.id}`} value={e.experiment_id}>{e.experiment_id}</option>
                ))}
              </select>
            </div>
            <div className="flex gap" style={{ flexWrap: 'wrap', gap: 8 }}>
              <button type="button" className="secondary" disabled={!experimentContext.trim()} onClick={() => setCompareTextA(experimentContext)}>{t.labComparisonFromContextA}</button>
              <button type="button" className="secondary" disabled={!experimentContext.trim()} onClick={() => setCompareTextB(experimentContext)}>{t.labComparisonFromContextB}</button>
            </div>
            <div>
              <label style={{ display: 'block', marginBottom: 4, fontSize: '0.9rem' }}>{t.labComparisonTextA}</label>
              <textarea className="form-control" dir="auto" rows={5} value={compareTextA} onChange={e => setCompareTextA(e.target.value)} />
            </div>
            <div>
              <label style={{ display: 'block', marginBottom: 4, fontSize: '0.9rem' }}>{t.labComparisonTextB}</label>
              <textarea className="form-control" dir="auto" rows={5} value={compareTextB} onChange={e => setCompareTextB(e.target.value)} />
            </div>
            <button type="button" className="rag-file-button" disabled={compareLoading} onClick={runComparePercentages}>{compareLoading ? t.loading : t.labComparisonRun}</button>
            {compareError && <p className="error" role="alert">{compareError}</p>}
            {compareLoading && <p className="loading">{t.loading}</p>}
            {compareResult?.markdownTable && (
              <div style={{ marginTop: 8, padding: 12, background: 'var(--bg-soft)', borderRadius: 8, overflow: 'auto' }}>
                {(compareResult.warnings || []).length > 0 && (
                  <ul style={{ paddingRight: 20, marginBottom: 12, color: 'var(--muted)' }}>
                    {compareResult.warnings.map((w, i) => <li key={i}>{w}</li>)}
                  </ul>
                )}
                <div className="rag-result-markdown">
                  <ReactMarkdown>{compareResult.markdownTable}</ReactMarkdown>
                </div>
                <p className="muted" style={{ marginTop: 8, fontSize: '0.85rem' }}>mode: {compareResult.mode || '—'} · ΣA ≈ {compareResult.sumA}% · ΣB ≈ {compareResult.sumB}%</p>
              </div>
            )}
          </div>
        </section>
      )}

      {activeSection === 'formulation-intelligence' && !experimentContext.trim() && (
        <section className="rag-section">
          <label>{t.labFormulationIntelligence}</label>
          <p className="muted" style={{ marginBottom: 8 }}>{t.labFormulationIntelligenceHint}</p>
          <textarea className="form-control" dir="ltr" rows={4} placeholder={t.labFormulationPlaceholder} value={formulationInput} onChange={e => { setFormulationInput(e.target.value); setSaveFormulationFeedback(null); }} />
          <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            <button type="button" onClick={runFormulationIntelligence}>{t.check}</button>
            <button type="button" className="secondary" disabled={saveFormulationLoading} onClick={saveFormulationAsExperiment}>
              {saveFormulationLoading ? t.loading : t.labSaveAsExperiment}
            </button>
          </div>
          <p className="muted" style={{ marginTop: 10, marginBottom: 6 }}>{t.labSaveAsExperimentHint}</p>
          <label className="muted" style={{ display: 'block', marginBottom: 4 }}>{t.labSaveExperimentIdOptional}</label>
          <input type="text" className="form-control" dir="ltr" style={{ maxWidth: 360 }} value={saveExperimentIdOptional} onChange={e => setSaveExperimentIdOptional(e.target.value)} placeholder="form-…" />
          {saveFormulationFeedback && (
            <p style={{ marginTop: 10, color: 'var(--success, #2e7d32)' }}>{saveFormulationFeedback}</p>
          )}
          {formulationResult && <div style={{ marginTop: 12, padding: 12, background: 'var(--bg-soft)', borderRadius: 8 }}><p><strong>{t.labStatus}:</strong> <span style={{ color: formulationResult.status === 'OK' ? 'green' : formulationResult.status === 'Warning' ? 'orange' : 'red' }}>{formulationResult.status}</span></p>{(formulationResult.issues || []).length > 0 && <ul style={{ paddingRight: 20 }}>{formulationResult.issues.map((issue, i) => <li key={i}>{issue.message || issue}</li>)}</ul>}</div>}
        </section>
      )}

      {activeSection === 'similar-experiments' && !experimentContext.trim() && (
        <section className="rag-section">
          <label>{t.labSimilarExperimentsTitle}</label>
          <p className="muted" style={{ marginBottom: 8 }}>{t.labSimilarExperimentsHint}</p>
          <input type="text" className="form-control" dir="ltr" placeholder={t.labExperimentIdPlaceholder} value={similarExperimentId} onChange={e => setSimilarExperimentId(e.target.value)} style={{ maxWidth: 320, marginBottom: 8 }} />
          <button type="button" onClick={runSimilarExperiments} disabled={!similarExperimentId.trim()} style={{ marginTop: 0 }}>{t.load}</button>
          {similarResult && (similarResult.error ? <p className="error" style={{ marginTop: 12 }}>{similarResult.error}</p> : <div style={{ marginTop: 12, padding: 12, background: 'var(--bg-soft)', borderRadius: 8 }}><p>{t.labSimilarTo(similarResult.source_experiment_id)}</p><ul style={{ margin: 0, paddingRight: 20 }}>{(similarResult.similar || []).map((s, i) => <li key={i}>{s.experiment_id} — {s.experiment_outcome} (score: {s.similarity_score})</li>)}</ul>{(similarResult.similar || []).length === 0 && <p className="muted">{t.labNoSimilarFound}</p>}</div>)}
        </section>
      )}

      {activeSection === 'relations' && !experimentContext.trim() && (
        <section className="rag-section">
          {relations && <div><p>{t.labRelationsSummary(relations.experiments_count, relations.material_library_count)}</p><p className="muted">{t.labRelationsList}</p><ul style={{ margin: 0, paddingRight: 20 }}>{(relations.relations || []).slice(0, 30).map((r, i) => <li key={i}>{r.type}: {r.experiment_id} {r.formula != null ? `— ${String(r.formula).slice(0, 40)}` : ''} {r.material != null ? `— ${r.material}` : ''}</li>)}</ul></div>}
          <button type="button" className="secondary" onClick={loadRelations}>{relations ? t.refresh : t.load}</button>
        </section>
      )}

      {activeSection === 'guard' && !experimentContext.trim() && (
        <section className="rag-section">
          <label>{t.labResearchGuard}</label>
          <textarea className="form-control" dir="ltr" rows={2} placeholder={t.labGuardPlaceholder} value={guardInput} onChange={e => setGuardInput(e.target.value)} />
          <button type="button" onClick={runGuard} style={{ marginTop: 8 }}>{t.check}</button>
          {guardResult && <div style={{ marginTop: 12, padding: 12, background: 'var(--bg-soft)', borderRadius: 8 }}><p>{guardResult.allowed !== false ? t.labGuardAllowed : t.labGuardBlocked}</p>{(guardResult.warnings || []).length > 0 && <ul style={{ paddingRight: 20 }}>{guardResult.warnings.map((w, i) => <li key={i}>{w.message || w}</li>)}</ul>}</div>}
        </section>
      )}

      {activeSection === 'suggestion-engine' && !experimentContext.trim() && (
        <section className="rag-section">
          <p className="muted">{t.labSuggestionEngineHint}</p>
        </section>
      )}

      {activeSection === 'experiments' && !experimentContext.trim() && (
        <section className="rag-section">
          <p>{t.labExperimentsCount(experiments.length)}</p>
          <p className="muted">{t.labSessionsCount(sessions.length)} {t.labMaterialsCount(materials.length)}</p>
          <button type="button" className="secondary" onClick={load} style={{ marginBottom: 8 }}>{t.refresh}</button>
          <ul style={{ margin: 0, paddingRight: 20, maxHeight: 300, overflow: 'auto' }}>{experiments.slice(0, 50).map(e => <li key={e.id}>{e.experiment_id} — {e.technology_domain} — {e.experiment_outcome} {e.formula ? `(${String(e.formula).slice(0, 30)}…)` : ''}</li>)}</ul>
          {experiments.length > 50 && <p className="muted">{t.labShowingFirst(50)}</p>}
        </section>
      )}

      <section className="rag-section" style={{ marginTop: 24, borderTop: '1px solid var(--border)', paddingTop: 16 }}>
        <h4 style={{ fontSize: '1rem', marginBottom: 8 }}>{t.labSavedExperimentsTitle}</h4>
        {savedExperiments.length === 0 && <p className="muted">{t.labSavedExperimentsEmpty}</p>}
        {savedExperiments.length > 0 && (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {savedExperiments.map((item) => (
              <li key={item.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                <button type="button" className="secondary" style={{ flex: 1, textAlign: 'right', minWidth: 0 }} onClick={() => loadSavedExperiment(item)} title={item.content ? String(item.content).slice(0, 100) + '…' : ''}>
                  <span style={{ fontWeight: 500 }}>{item.name}</span>
                  <span className="muted" style={{ marginRight: 8, fontSize: '0.85rem' }}>{item.created_at ? new Date(item.created_at).toLocaleDateString('he-IL') : ''}</span>
                </button>
                <button type="button" className="secondary" disabled={deletingSavedId === item.id} onClick={() => deleteSavedExperiment(item.id)}>{deletingSavedId === item.id ? t.loading : t.delete}</button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** Matches maneger-back lib/gptRagSync.js (OpenAI vector upload). */
const GPT_OPENAI_SYNC_FILE_RE = /\.(pdf|docx|doc|txt|xlsx|xls|pptx|csv|json|md|html|htm)$/i;

/** Match upload hints to rows from a fresh GET /files list (fallback when POST body omits id). */
function resolveProjectFileIdsFromHints(files, hints) {
  const list = Array.isArray(files) ? files : [];
  const hintList = (Array.isArray(hints) ? hints : []).map((h) => String(h || '').trim()).filter(Boolean);
  if (hintList.length === 0 || list.length === 0) return [];
  const seen = new Set();
  const out = [];
  for (const hint of hintList) {
    const base = hint.includes('/') || hint.includes('\\') ? hint.split(/[/\\]/).pop() : hint;
    const candidates = list.filter((f) => {
      const name = String(f.original_name || '').trim();
      if (!name) return false;
      return name === hint || name === base || (base && name.endsWith(base));
    });
    const pick = candidates.sort((a, b) => {
      const ta = new Date(a.created_at || 0).getTime();
      const tb = new Date(b.created_at || 0).getTime();
      return tb - ta;
    })[0];
    const id = pick?.id;
    if (id != null && !seen.has(String(id))) {
      seen.add(String(id));
      out.push(id);
    }
  }
  return out;
}

function isGptOpenAiEligibleProjectFile(f) {
  if (!f || !f.storage_path || !String(f.storage_path).trim()) return false;
  const orig = String(f.original_name || '').trim();
  const fromPath = String(f.storage_path).split('/').filter(Boolean).pop() || '';
  const base = orig || fromPath;
  return GPT_OPENAI_SYNC_FILE_RE.test(base);
}

function formatGptRagSourcesAppendix(sources) {
  if (!Array.isArray(sources) || sources.length === 0) return '';
  const lines = sources.map((s, i) => {
    const fn = (s && s.filename) || '—';
    const ex = (s && s.excerpt) || '';
    return `[${i + 1}] ${fn}\n${ex}`;
  });
  return `\n\n---\nמקורות (ציטוטים מהמסמכים):\n\n${lines.join('\n\n')}`;
}

function RagTab({ projectId }) {
  const [query, setQuery] = React.useState('');
  const [selectedProjectFileId, setSelectedProjectFileId] = React.useState('');
  const [result, setResult] = React.useState(null);
  /** OpenAI file_search snippets returned with the answer (filename + excerpt). */
  const [answerSources, setAnswerSources] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [health, setHealth] = React.useState(null);
  const [projectFiles, setProjectFiles] = React.useState([]);
  const [filesLoading, setFilesLoading] = React.useState(true);
  const [uploading, setUploading] = React.useState(false);
  const [uploadProgress, setUploadProgress] = React.useState({ current: 0, total: 0 });
  const [actionMessage, setActionMessage] = React.useState(null);
  const [removingFileId, setRemovingFileId] = React.useState(null);
  const [showSharepointPicker, setShowSharepointPicker] = React.useState(false);
  const [sharepointBucketFiles, setSharepointBucketFiles] = React.useState([]);
  const [sharepointDisplayNamesMap, setSharepointDisplayNamesMap] = React.useState({});
  const [sharepointBucketLoading, setSharepointBucketLoading] = React.useState(false);
  const [sharepointSearchQuery, setSharepointSearchQuery] = React.useState('');
  const [sharepointExpandedFolders, setSharepointExpandedFolders] = React.useState(() => new Set());
  const [addingFromBucket, setAddingFromBucket] = React.useState(null);
  const [addingFolderPath, setAddingFolderPath] = React.useState(null);
  const [addingFolderProgress, setAddingFolderProgress] = React.useState({ current: 0, total: 0 });
  const [projectFileFoldersCollapsed, setProjectFileFoldersCollapsed] = React.useState(() => new Set());
  const [showSharepointUploadModal, setShowSharepointUploadModal] = React.useState(false);
  const [sharepointUploadFiles, setSharepointUploadFiles] = React.useState([]);
  const [sharepointUploading, setSharepointUploading] = React.useState(false);
  const [sharepointUploadLoaded, setSharepointUploadLoaded] = React.useState(0);
  const [sharepointUploadTotal, setSharepointUploadTotal] = React.useState(0);
  const [sharepointServerProgress, setSharepointServerProgress] = React.useState(null);
  const [sharepointUploadFolderName, setSharepointUploadFolderName] = React.useState('');
  const sharepointProgressPollRef = React.useRef(null);
  const sharepointFolderInputRef = React.useRef(null);
  const [showUploadTypeChoice, setShowUploadTypeChoice] = React.useState(false);
  const ragFileInputRef = React.useRef(null);
  const ragFolderInputRef = React.useRef(null);
  /** Document Q&A uses OpenAI File search only (Matriya RAG selector hidden for now). */
  const [gptRagStatus, setGptRagStatus] = React.useState(null);
  const gptRagStatusRef = React.useRef(null);
  React.useEffect(() => {
    gptRagStatusRef.current = gptRagStatus;
  }, [gptRagStatus]);
  const [gptRagSyncing, setGptRagSyncing] = React.useState(false);
  /** Prevents duplicate auto-sync for the same project until user leaves OpenAI mode or changes project. */
  const gptAutoSyncForProjectRef = React.useRef('');
  const gptSyncLockRef = React.useRef(false);
  /** While a post-upload GPT sync is scheduled/running, skip the auto full sync effect (avoids syncing entire project + UI lock). */
  const ragDeferAutoFullGptSyncRef = React.useRef(false);
  const [gptSyncHadError, setGptSyncHadError] = React.useState(false);
  const [storageRepairLoading, setStorageRepairLoading] = React.useState(false);
  /** True while incremental POST /gpt-rag/sync after upload is in flight (same endpoint as manual sync). */
  const [gptBackgroundSyncBusy, setGptBackgroundSyncBusy] = React.useState(false);

  const loadFiles = React.useCallback(() => {
    if (!projectId) return Promise.resolve([]);
    return projectFilesApi
      .list(projectId)
      .then((d) => {
        const files = d.files || [];
        const filtered = files.filter(f => f.project_id == null || String(f.project_id) === String(projectId));
        setProjectFiles(filtered);
        const folderKeys = new Set();
        for (const f of filtered) {
          const path = f.folder_display_name != null && f.folder_display_name !== '' ? String(f.folder_display_name).trim() : '';
          if (path) {
            path.split(/[/\\>]+/).forEach((_, i, parts) => folderKeys.add(parts.slice(0, i + 1).join('/')));
          } else {
            folderKeys.add('\0');
          }
        }
        setProjectFileFoldersCollapsed(new Set(folderKeys));
        setFilesLoading(false);
        return filtered;
      })
      .catch(() => {
        setFilesLoading(false);
        return [];
      });
  }, [projectId]);

  React.useEffect(() => {
    ragApi.health()
      .then(data => setHealth(typeof data?.ok === 'boolean' ? data : { ok: false }))
      .catch(err => setHealth({ ok: false, error: err.response?.data?.error || err.message || null }));
  }, []);
  React.useEffect(() => {
    if (projectId) loadFiles();
  }, [projectId, loadFiles]);
  React.useEffect(() => {
    if (!selectedProjectFileId) return;
    if (!projectFiles.some((f) => String(f.id) === String(selectedProjectFileId))) {
      setSelectedProjectFileId('');
    }
  }, [projectFiles, selectedProjectFileId]);
  const refreshGptRagStatus = React.useCallback(() => {
    if (!projectId) return;
    gptRagApi
      .status(projectId)
      .then(setGptRagStatus)
      .catch(() => setGptRagStatus({ configured: false, openai: false, reason: 'status failed' }));
  }, [projectId]);

  React.useEffect(() => {
    if (!projectId) return;
    if (gptRagStatus?.vector_store_status !== 'in_progress') return;
    const id = window.setInterval(() => refreshGptRagStatus(), 3500);
    return () => clearInterval(id);
  }, [projectId, gptRagStatus?.vector_store_status, refreshGptRagStatus]);

  const runGptSync = React.useCallback(
    (onlyProjectFileIds) => {
      if (!projectId || gptSyncLockRef.current) return Promise.resolve();
      gptSyncLockRef.current = true;
      setGptRagSyncing(true);
      setError(null);
      const ids = Array.isArray(onlyProjectFileIds) ? onlyProjectFileIds.map(String).filter(Boolean) : [];
      const body = ids.length > 0 ? { only_project_file_ids: ids } : {};
      return gptRagApi
        .sync(projectId, body)
        .then((res) => {
          setGptSyncHadError(false);
          const base =
            res.uploaded != null ? `${t.ragGptSyncDone} (${res.uploaded} קבצים)` : t.ragGptSyncDone;
          const msg = res.indexing_pending ? `${base} — האינדוקס ב-OpenAI ממשיך ברקע` : base;
          setActionMessage(msg);
          setTimeout(() => setActionMessage(null), 4000);
          refreshGptRagStatus();
        })
        .catch((e) => {
          setGptSyncHadError(true);
          setError(e.response?.data?.error || e.message || 'סנכרון נכשל');
        })
        .finally(() => {
          gptSyncLockRef.current = false;
          setGptRagSyncing(false);
        });
    },
    [projectId, refreshGptRagStatus, t.ragGptSyncDone]
  );

  /**
   * Incremental OpenAI sync without locking the RAG UI (no gptRagSyncing). Same endpoint as manual sync; Matriya-style fire-and-forget after upload.
   */
  const runGptSyncInBackground = React.useCallback(
    (onlyProjectFileIds) => {
      if (!projectId) return Promise.resolve();
      const ids = Array.isArray(onlyProjectFileIds) ? onlyProjectFileIds.map(String).filter(Boolean) : [];
      const body = ids.length > 0 ? { only_project_file_ids: ids } : {};
      setGptBackgroundSyncBusy(true);
      return gptRagApi
        .sync(projectId, body)
        .then((res) => {
          setGptSyncHadError(false);
          const base =
            res.uploaded != null ? `${t.ragGptSyncDone} (${res.uploaded} קבצים)` : t.ragGptSyncDone;
          const msg = res.indexing_pending ? `${base} — האינדוקס ב-OpenAI ממשיך ברקע` : base;
          setActionMessage(msg);
          setTimeout(() => setActionMessage(null), 4000);
          refreshGptRagStatus();
        })
        .catch((e) => {
          setGptSyncHadError(true);
          setError(e.response?.data?.error || e.message || 'סנכרון נכשל');
          refreshGptRagStatus();
        })
        .finally(() => {
          setGptBackgroundSyncBusy(false);
        });
    },
    [projectId, refreshGptRagStatus, t.ragGptSyncDone]
  );

  /**
   * After new files land in the project, run incremental GPT sync in the background (when OpenAI is enabled).
   * Skips if uploaded names are all non–GPT-searchable extensions. Debounced slightly so the file list API includes new rows.
   */
  const queueGptResyncAfterUpload = React.useCallback(
    (fileNameHints, projectFileIds) => {
      const hints = Array.isArray(fileNameHints) ? fileNameHints : [];
      const ids = Array.isArray(projectFileIds) ? projectFileIds.map(String).filter(Boolean) : [];
      const unknownOrEligible =
        hints.length === 0 || hints.some((n) => GPT_OPENAI_SYNC_FILE_RE.test(String(n || '')));
      if (!unknownOrEligible) return;
      if (!gptRagStatusRef.current?.openai) return;
      ragDeferAutoFullGptSyncRef.current = true;
      window.setTimeout(() => {
        loadFiles()
          .then((freshFiles) => {
            let resolved = [...ids];
            if (resolved.length === 0 && hints.length > 0) {
              resolved = resolveProjectFileIdsFromHints(freshFiles, hints).map(String);
            }
            if (resolved.length > 0) {
              void runGptSyncInBackground(resolved).finally(() => {
                window.setTimeout(() => {
                  ragDeferAutoFullGptSyncRef.current = false;
                }, 500);
              });
            } else {
              refreshGptRagStatus();
              window.setTimeout(() => {
                ragDeferAutoFullGptSyncRef.current = false;
              }, 800);
            }
          })
          .catch(() => {
            refreshGptRagStatus();
            window.setTimeout(() => {
              ragDeferAutoFullGptSyncRef.current = false;
            }, 800);
          });
      }, 500);
    },
    [loadFiles, runGptSyncInBackground, refreshGptRagStatus]
  );

  React.useEffect(() => {
    gptAutoSyncForProjectRef.current = '';
    ragDeferAutoFullGptSyncRef.current = false;
    setGptSyncHadError(false);
  }, [projectId]);

  React.useEffect(() => {
    if (!projectId || filesLoading) return;
    if (ragDeferAutoFullGptSyncRef.current) return;
    const st = gptRagStatus;
    if (!st?.openai || st.vector_store_id || gptRagSyncing || gptBackgroundSyncBusy) return;
    const hasEligible = projectFiles.some(isGptOpenAiEligibleProjectFile);
    if (!hasEligible) return;
    if (gptAutoSyncForProjectRef.current === projectId) return;
    gptAutoSyncForProjectRef.current = projectId;
    runGptSync();
  }, [projectId, filesLoading, gptRagStatus, gptRagSyncing, gptBackgroundSyncBusy, projectFiles, runGptSync]);

  React.useEffect(() => {
    if (!projectId) return;
    refreshGptRagStatus();
  }, [projectId, refreshGptRagStatus]);

  const runStorageRepairFromRag = React.useCallback(() => {
    if (!projectId || storageRepairLoading) return;
    setStorageRepairLoading(true);
    setError(null);
    projectFilesApi
      .repairStorageFromRag(projectId)
      .then((res) => {
        const n = res.repaired_count ?? 0;
        const f = res.failed_count ?? 0;
        setActionMessage(
          n > 0
            ? `${t.gptRagRepairStorageFromRag}: ${n} מסמכים תוקנו${f > 0 ? `, ${f} נכשלו` : ''}.`
            : f > 0
              ? `לא שוחזר אף מסמך (${f} כשלויות — ודא שהשמות תואמים לאינדוקס).`
              : 'אין מסמכים ללא נתיב אחסון.'
        );
        setTimeout(() => setActionMessage(null), 6000);
        loadFiles();
        refreshGptRagStatus();
      })
      .catch((e) => {
        setError(e.response?.data?.error || e.message || 'שחזור נכשל');
      })
      .finally(() => setStorageRepairLoading(false));
  }, [projectId, storageRepairLoading, refreshGptRagStatus, loadFiles]);

  React.useEffect(() => {
    if (!projectId) return;
    const onVis = () => {
      if (document.visibilityState === 'visible') refreshGptRagStatus();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [projectId, refreshGptRagStatus]);
  React.useEffect(() => {
    const el = sharepointFolderInputRef.current;
    if (el) {
      el.setAttribute('webkitdirectory', '');
      el.setAttribute('directory', '');
    }
  }, [showSharepointUploadModal]);
  React.useEffect(() => {
    const el = ragFolderInputRef.current;
    if (el) {
      el.setAttribute('webkitdirectory', '');
      el.setAttribute('directory', '');
    }
  }, []);

  async function readDroppedFolder(entry, basePath = '') {
    const out = [];
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      const relPath = basePath ? `${basePath}/${file.name}` : file.name;
      out.push(new File([file], relPath, { type: file.type }));
      return out;
    }
    if (entry.isDirectory) {
      const reader = entry.createReader();
      const entries = await new Promise((res, rej) => reader.readEntries(res, rej));
      const name = entry.name || 'folder';
      const dirPath = basePath ? `${basePath}/${name}` : name;
      for (const e of entries) {
        out.push(...(await readDroppedFolder(e, dirPath)));
      }
    }
    return out;
  }
  function handleSharepointDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    const items = e.dataTransfer?.items;
    if (!items?.length) return;
    const promises = [];
    for (let i = 0; i < items.length; i++) {
      const entry = items[i].webkitGetAsEntry?.();
      if (entry) promises.push(readDroppedFolder(entry));
    }
    Promise.all(promises).then(arrays => {
      const flat = arrays.flat();
      if (flat.length) {
        setSharepointUploadFiles(flat);
        // Default folder name from dropped folder (first file's path is "FolderName/..." from readDroppedFolder)
        const firstPath = flat[0].name;
        const folderName = firstPath && firstPath.includes('/') ? firstPath.split('/')[0] : '';
        if (folderName) setSharepointUploadFolderName(folderName);
      }
    }).catch(() => {});
  }
  function handleSharepointDragOver(e) {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
  }

  const onFileChange = async (e) => {
    const fileList = e.target.files;
    if (!fileList?.length) return;
    setError(null);
    const files = Array.from(fileList);
    const folderDisplayName = files[0]?.webkitRelativePath ? files[0].webkitRelativePath.split('/')[0].trim() || null : null;
    setUploading(true);
    setUploadProgress({ current: 0, total: files.length });
    const errors = [];
    const uploadedOk = [];
    const uploadedIds = [];
    for (let i = 0; i < files.length; i++) {
      setUploadProgress(prev => ({ ...prev, current: i + 1 }));
      try {
        const row = await projectFilesApi.upload(projectId, files[i], folderDisplayName);
        uploadedOk.push(files[i].name || files[i].webkitRelativePath || 'file');
        if (row?.id != null) uploadedIds.push(row.id);
      } catch (err) {
        errors.push(files[i].name + ': ' + (err.response?.data?.error || err.message));
      }
    }
    e.target.value = '';
    setUploading(false);
    setUploadProgress({ current: 0, total: 0 });
    await loadFiles();
    queueGptResyncAfterUpload(uploadedOk, uploadedIds);
    if (errors.length) setError(errors.length === files.length ? errors.join('; ') : t.uploadSomeFailed + ' ' + errors.join('; '));
  };

  const removeFile = (fileId) => {
    if (!window.confirm(t.removeFileConfirm)) return;
    setRemovingFileId(fileId);
    projectFilesApi.delete(projectId, fileId).then(loadFiles).catch(err => setError(err.message)).finally(() => setRemovingFileId(null));
  };

  const INDEXABLE_EXT = /\.(pdf|docx|doc|txt|xlsx|xls)$/i;
  const isIndexableFileName = (name) => name && INDEXABLE_EXT.test(String(name).trim());

  /** Collect all file entries { path, displayName } under a folder node (recursive). */
  function collectFilesUnder(node, displayNamesMap = {}) {
    if (node.type === 'file') return [{ path: node.path, displayName: node.displayName ?? displayNamesMap[node.path] ?? node.name }];
    if (node.type === 'folder' && node.children) {
      return node.children.flatMap(child => collectFilesUnder(child, displayNamesMap));
    }
    return [];
  }

  /** True only when the string looks like a storage placeholder (bucket id or file_1-style), not a real filename. */
  function looksLikeStoragePlaceholder(str) {
    if (!str || typeof str !== 'string') return true;
    const s = str.trim();
    if (s.length === 0 || s === '_' || s === 'file') return true;
    if (/[\u0590-\u05FF\uFB1D-\uFB4F]/.test(s)) return false;
    const segment = s.split('/').pop() || s;
    if (/^[a-fA-F0-9]{8}(\.[a-zA-Z0-9]+)?$/.test(segment)) return true;
    if (/^file_\d+(\.[a-zA-Z0-9]+)?$/.test(segment) || /^folder_\d+$/.test(segment)) return true;
    return false;
  }
  function friendlyHebrewLabel(path, fallbackName) {
    const segment = (path || '').split('/').filter(Boolean).pop() || fallbackName || '';
    const extMatch = segment && segment.includes('.') ? segment.match(/\.([^.]+)$/) : null;
    const ext = extMatch ? extMatch[1] : null;
    if (ext) return `קובץ.${ext}`;
    return segment && segment.includes('.') ? 'קובץ' : 'תיקייה';
  }
  function looksMojibake(str) {
    if (!str || typeof str !== 'string') return false;
    return /[\uFFFD\u00A4¢]/.test(str);
  }
  function safeDisplayName(displayName, path, fallbackName) {
    const d = displayName ?? fallbackName ?? path ?? '';
    if (d === '' || d === '_') return friendlyHebrewLabel(path, fallbackName) || path || '';
    if (/[\uFFFD\u00A4]/.test(String(d))) return friendlyHebrewLabel(path, fallbackName) || path || '';
    if (looksMojibake(d)) return friendlyHebrewLabel(path, fallbackName) || path || '';
    if (looksLikeStoragePlaceholder(d)) return friendlyHebrewLabel(path, fallbackName) || d;
    return d;
  }
  function buildBucketTree(files, displayNamesMap = {}, currentProjectId = '') {
    const root = { type: 'folder', pathPrefix: '', children: [] };
    const pathToFolder = new Map();
    pathToFolder.set('', root);
    for (const f of files) {
      const path = f.path || '';
      const parts = path.split('/').filter(Boolean);
      if (parts.length === 0) continue;
      let prefix = '';
      for (let i = 0; i < parts.length - 1; i++) {
        const segment = parts[i];
        const nextPrefix = prefix ? `${prefix}/${segment}` : segment;
        if (!pathToFolder.has(nextPrefix)) {
          const displayPath = displayNamesMap[nextPrefix];
          const rawFolderDisplay = displayPath ? displayPath.split('/').pop() : segment;
          const folder = { type: 'folder', name: segment, pathPrefix: nextPrefix, displayName: safeDisplayName(rawFolderDisplay, nextPrefix, segment), children: [] };
          pathToFolder.set(nextPrefix, folder);
          const parent = pathToFolder.get(prefix);
          if (parent && parent.children) parent.children.push(folder);
        }
        prefix = prefix ? `${prefix}/${segment}` : segment;
      }
      const fileDisplayFromMap = displayNamesMap[f.path];
      const fileNode = { type: 'file', path: f.path, name: parts[parts.length - 1], displayName: safeDisplayName(fileDisplayFromMap ?? f.displayName, f.path, f.name) };
      const parent = pathToFolder.get(prefix);
      if (parent && parent.children) parent.children.push(fileNode);
    }
    const sortNodes = (nodes) => {
      nodes.sort((a, b) => {
        const aIsFolder = a.type === 'folder' ? 1 : 0;
        const bIsFolder = b.type === 'folder' ? 1 : 0;
        if (bIsFolder !== aIsFolder) return bIsFolder - aIsFolder;
        return String(a.name || a.pathPrefix).localeCompare(String(b.name || b.pathPrefix), undefined, { sensitivity: 'base' });
      });
      nodes.forEach(n => { if (n.children) sortNodes(n.children); });
    };
    sortNodes(root.children);
    let topLevel = root.children;
    if (currentProjectId) {
      const projectPrefix = 'project_' + currentProjectId;
      const idx = topLevel.findIndex(n => n.type === 'folder' && n.pathPrefix === projectPrefix);
      if (idx !== -1) {
        const projectNode = topLevel[idx];
        const rest = topLevel.filter((_, i) => i !== idx);
        topLevel = [...(projectNode.children || []), ...rest];
        sortNodes(topLevel);
      }
    }
    const manualIdx = topLevel.findIndex(n => n.type === 'folder' && n.pathPrefix === 'manual');
    if (manualIdx !== -1) {
      const manualNode = topLevel[manualIdx];
      const rest = topLevel.filter((_, i) => i !== manualIdx);
      topLevel = [...(manualNode.children || []), ...rest];
      sortNodes(topLevel);
    }
    return topLevel;
  }

  const toggleBucketFolder = (pathPrefix) => {
    setSharepointExpandedFolders(prev => {
      const next = new Set(prev);
      if (next.has(pathPrefix)) next.delete(pathPrefix);
      else next.add(pathPrefix);
      return next;
    });
  };

  const runSearch = () => {
    if (!query.trim()) return;
    if (loading) return;
    if (
      gptRagSyncing ||
      gptBackgroundSyncBusy ||
      uploading ||
      addingFromBucket != null ||
      addingFolderPath != null ||
      sharepointUploading ||
      gptRagStatus?.vector_store_status === 'in_progress'
    ) {
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    setAnswerSources(null);
    gptRagApi
      .query(
        projectId,
        selectedProjectFileId
          ? { query: query.trim(), only_project_file_ids: [selectedProjectFileId] }
          : { query: query.trim() }
      )
      .then(data => {
        const out = data.outputs || {};
        const text = (out.synthesis || out.research || out.analysis || '').trim();
        setAnswerSources(Array.isArray(data.sources) ? data.sources : []);
        if (text) setResult(text);
        else if (data.run_id != null) {
          setResult('לא נוצר טקסט. נסה שוב או בדוק את מפתח OpenAI והמאגר.');
        } else {
          setResult(JSON.stringify(data, null, 2));
        }
      })
      .catch(e =>
        setError(
          e.response?.data?.error ||
            e.message ||
            (e.code === 'ECONNABORTED' ? 'הבקשה ארכה יותר מדי – נסה שוב.' : 'שגיאה בביצוע השאילתה.')
        )
      )
      .finally(() => setLoading(false));
  };

  const copyAnswer = () => {
    if (!result) return;
    const appendix = formatGptRagSourcesAppendix(answerSources);
    const payload = String(result) + appendix;
    navigator.clipboard.writeText(payload).then(() => { setActionMessage(t.copySuccess); setTimeout(() => setActionMessage(null), 2000); }).catch(() => setError(t.copySuccess));
  };
  const saveAnswerAsNote = () => {
    if (!result) return;
    const title = (query || '').slice(0, 80) || t.askQuestion;
    const body = String(result) + formatGptRagSourcesAppendix(answerSources);
    notesApi.create(projectId, { title, body }).then(() => { setActionMessage(t.saveAsNoteSuccess); setTimeout(() => setActionMessage(null), 2000); }).catch(e => setError(e.response?.data?.error || e.message));
  };

  const ragUploadOrAddInProgress =
    uploading ||
    addingFromBucket != null ||
    addingFolderPath != null ||
    sharepointUploading;
  const ragGptVectorIndexing = gptRagStatus?.vector_store_status === 'in_progress';
  const ragAskPipelineBusy =
    ragUploadOrAddInProgress ||
    gptRagSyncing ||
    gptBackgroundSyncBusy ||
    ragGptVectorIndexing;
  const ragAskButtonTitle = ragUploadOrAddInProgress
    ? t.ragGptAskBlockedUploadTitle
    : gptRagSyncing || gptBackgroundSyncBusy || ragGptVectorIndexing
      ? t.ragGptRunWhileSyncingTitle
      : !gptRagStatus?.vector_store_id
        ? t.ragGptNoVectorTitle
        : undefined;

  return (
    <div className="card tab-card rag-tab">
      <h3>{t.docsManagementTitle}</h3>
      <p style={{ color: 'var(--muted)', fontSize: '0.95rem', marginBottom: 20 }}>{t.docsManagementIntro}</p>
      {health && <p style={{ color: health.ok ? 'var(--success)' : 'var(--muted)', fontSize: '0.85rem', marginBottom: 16 }}>{health.ok ? t.ragConnected : (health.error || t.ragNotAvailable)}</p>}
      {error && <p className="error" style={{ marginBottom: 12 }}>{error}</p>}

      <section className="rag-section" aria-labelledby="docs-upload-heading">
        <h4 id="docs-upload-heading" style={{ fontSize: '1rem', marginBottom: 8 }}>{t.docsUploadSection}</h4>
        <p style={{ color: 'var(--muted)', fontSize: '0.9rem', marginBottom: 12 }}>{t.docsUploadHint}</p>
        <div className="flex gap" style={{ marginBottom: 16, alignItems: 'center' }}>
          <button
            type="button"
            className="rag-file-button"
            disabled={!health?.ok}
            title={!health?.ok ? (health?.error || t.ragNotAvailable) : undefined}
            onClick={() => {
              if (!health?.ok) return;
              setSharepointSearchQuery('');
              setShowSharepointPicker(true);
              setSharepointBucketLoading(true);
              projectFilesApi.listSharepointBucket(projectId).then(d => {
                const files = d.files || [];
                const displayNamesMap = d.displayNamesMap || {};
                setSharepointBucketFiles(files);
                setSharepointDisplayNamesMap(displayNamesMap);
                setSharepointBucketLoading(false);
                // Auto-expand "manual" so uploaded files (with Hebrew/English display names) are visible
                const hasManual = files.some(f => (f.path || '').startsWith('manual/'));
                if (hasManual) setSharepointExpandedFolders(prev => new Set(prev).add('manual'));
              }).catch(err => {
                console.warn('[SharePoint decode] list failed:', err);
                setSharepointBucketLoading(false); setSharepointBucketFiles([]); setSharepointDisplayNamesMap({});
              });
            }}
          >
            {t.chooseFromSharepoint}
          </button>
          <input
            ref={ragFileInputRef}
            id="rag-file-upload"
            type="file"
            multiple
            accept=".pdf,.docx,.doc,.txt,.xlsx,.xls,.pptx,.jpg,.jpeg,.png"
            onChange={onFileChange}
            className="rag-file-input-hidden"
            aria-label={t.chooseFile}
            tabIndex={-1}
          />
          <input
            ref={ragFolderInputRef}
            id="rag-folder-upload"
            type="file"
            multiple
            onChange={(e) => { onFileChange(e); e.target.value = ''; }}
            className="rag-file-input-hidden"
            aria-label={t.uploadFolderOption}
            tabIndex={-1}
          />
          <button
            type="button"
            className="rag-file-button"
            onClick={() => setShowUploadTypeChoice(true)}
          >
            {t.chooseFileMultiple}
          </button>
          {showUploadTypeChoice && (
            <div className="modal-overlay" onClick={() => setShowUploadTypeChoice(false)} role="dialog" aria-modal="true" aria-label={t.uploadChoiceTitle}>
              <div className="rag-upload-choice-modal modal card" onClick={e => e.stopPropagation()}>
                <h4 style={{ margin: '0 0 12px 0', fontSize: '1rem' }}>{t.uploadChoiceTitle}</h4>
                <div className="flex gap" style={{ gap: 10 }}>
                  <button type="button" className="rag-file-button" onClick={() => { setShowUploadTypeChoice(false); ragFileInputRef.current?.click(); }}>
                    📄 {t.uploadFilesOption}
                  </button>
                  <button type="button" className="rag-file-button" onClick={() => { setShowUploadTypeChoice(false); ragFolderInputRef.current?.click(); }}>
                    📁 {t.uploadFolderOption}
                  </button>
                </div>
                <button type="button" className="secondary" style={{ marginTop: 12 }} onClick={() => setShowUploadTypeChoice(false)}>{t.cancel}</button>
              </div>
            </div>
          )}
          {uploading && (
            <div className="rag-upload-progress" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span className="loading" style={{ margin: 0 }}>
                {typeof t.uploadingProgress === 'function' ? t.uploadingProgress(uploadProgress.current, uploadProgress.total) : t.uploading}
              </span>
              {uploadProgress.total > 0 && (
                <div className="progress-bar" style={{ width: 120, flexShrink: 0 }}>
                  <div className="progress-fill" style={{ width: `${(uploadProgress.current / uploadProgress.total) * 100}%` }} />
                </div>
              )}
            </div>
          )}
        </div>
        {showSharepointPicker && (
          <div className="modal-overlay" onClick={() => setShowSharepointPicker(false)} role="dialog" aria-modal="true" aria-label={t.sharepointBucketList}>
            <div className="modal card" onClick={e => e.stopPropagation()} style={{ maxWidth: 520, maxHeight: '80vh', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              <div className="flex gap" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <h4 style={{ margin: 0 }}>{t.sharepointBucketList}</h4>
                <div className="flex gap" style={{ alignItems: 'center' }}>
                  <button type="button" className="rag-file-button" onClick={() => { setSharepointUploadFiles([]); setShowSharepointUploadModal(true); }}>{t.uploadToSharepointManual}</button>
                  <button type="button" className="secondary" onClick={() => setShowSharepointPicker(false)}>×</button>
                </div>
              </div>
              {!sharepointBucketLoading && sharepointBucketFiles.length > 0 && (
                <input
                  type="search"
                  className="form-control"
                  placeholder={t.searchSharepointFiles}
                  value={sharepointSearchQuery}
                  onChange={e => setSharepointSearchQuery(e.target.value)}
                  style={{ marginBottom: 12 }}
                  aria-label={t.searchSharepointFiles}
                />
              )}
              <div className="modal-scroll" style={{ overflow: 'auto', flex: 1, minHeight: 200 }}>
                {sharepointBucketLoading && <p className="loading">{t.loadingSharepointFiles}</p>}
                {!sharepointBucketLoading && sharepointBucketFiles.length === 0 && <p className="muted">{t.noSharepointFiles}</p>}
                {!sharepointBucketLoading && sharepointBucketFiles.length > 0 && (() => {
                  const q = sharepointSearchQuery.trim().toLowerCase();
                  const filtered = q ? sharepointBucketFiles.filter(f => (f.displayName || f.name || f.path || '').toLowerCase().includes(q)) : sharepointBucketFiles;
                  if (filtered.length === 0) return <p className="muted">{t.noSharepointFiles}</p>;
                  const isSearch = !!q;
                  function renderBucketNode(node, depth = 0, parentFolderDisplayName = null) {
                    const pathKey = node.path || node.pathPrefix || '';
                    const displayFromMap = sharepointDisplayNamesMap[pathKey];
                    const display = displayFromMap ?? node.displayName;
                    const finalDisplay = safeDisplayName(display, node.path, node.name);
                    if (node.type === 'file') {
                      return (
                        <li key={node.path} className="list-item" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: '1px solid var(--border)', paddingRight: depth * 16 }}>
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginRight: 8 }} title={node.path}>{finalDisplay}</span>
                          <button type="button" className="secondary" disabled={addingFromBucket === node.path || addingFolderPath} onClick={() => { setAddingFromBucket(node.path); const hint = [finalDisplay || node.path]; projectFilesApi.addFromBucket(projectId, node.path, safeDisplayName(display, node.path, node.name), parentFolderDisplayName).then((row) => { loadFiles(); queueGptResyncAfterUpload(hint, row?.id != null ? [row.id] : []); setAddingFromBucket(null); }).catch(err => { setError(err.response?.data?.error || err.message); setAddingFromBucket(null); }); }}>{addingFromBucket === node.path ? t.uploading : t.addToProject}</button>
                        </li>
                      );
                    }
                    const expanded = sharepointExpandedFolders.has(node.pathPrefix);
                    const isAddingThisFolder = addingFolderPath === node.pathPrefix;
                    return (
                      <li key={node.pathPrefix || node.name} style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                          <button type="button" className="secondary" style={{ flex: 1, minWidth: 0, justifyContent: 'flex-start', textAlign: 'right', padding: '6px 8px', background: 'var(--bg)' }} onClick={() => toggleBucketFolder(node.pathPrefix)} aria-expanded={expanded}>
                            <span style={{ marginLeft: 8 }}>{expanded ? '▼' : '▶'}</span>
                            <span style={{ marginRight: 6 }}>{finalDisplay}</span>
                          </button>
                          <button type="button" className="secondary" disabled={isAddingThisFolder || addingFromBucket != null} onClick={() => { (async () => { const bucketFiles = collectFilesUnder(node, sharepointDisplayNamesMap); if (bucketFiles.length === 0) return; setAddingFolderPath(node.pathPrefix); setAddingFolderProgress({ current: 0, total: bucketFiles.length }); const hints = []; const addedIds = []; for (let i = 0; i < bucketFiles.length; i++) { setAddingFolderProgress(prev => ({ ...prev, current: i + 1 })); try { const row = await projectFilesApi.addFromBucket(projectId, bucketFiles[i].path, bucketFiles[i].displayName ?? bucketFiles[i].path.split('/').pop(), finalDisplay); hints.push(bucketFiles[i].displayName ?? bucketFiles[i].path.split('/').pop()); if (row?.id != null) addedIds.push(row.id); } catch (err) { setError(err.response?.data?.error || err.message); } } await loadFiles(); queueGptResyncAfterUpload(hints, addedIds); setAddingFolderPath(null); setAddingFolderProgress({ current: 0, total: 0 }); })(); }}>{isAddingThisFolder && addingFolderProgress.total ? `${t.uploading} (${addingFolderProgress.current}/${addingFolderProgress.total})` : isAddingThisFolder ? t.uploading : t.addFolderToProject}</button>
                        </div>
                        {expanded && node.children && node.children.length > 0 && (
                          <ul style={{ listStyle: 'none', padding: 0, margin: 0, borderRight: '1px solid var(--border)', marginRight: 8 }}>
                            {node.children.map(child => renderBucketNode(child, depth + 1, finalDisplay))}
                          </ul>
                        )}
                      </li>
                    );
                  }
                  if (isSearch) {
                    return (
                      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                        {filtered.map(f => {
                          const fileDisplay = sharepointDisplayNamesMap[f.path] ?? f.displayName;
                          const pathParts = (f.path || '').split('/').filter(Boolean);
                          const parentPath = pathParts.length > 1 ? pathParts.slice(0, -1).join('/') : '';
                          const folderDisplayName = parentPath ? (sharepointDisplayNamesMap[parentPath] ?? pathParts[pathParts.length - 2] ?? null) : null;
                          return (
                            <li key={f.path} className="list-item" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f.path}>{safeDisplayName(fileDisplay, f.path, f.name)}</span>
                              <button type="button" className="secondary" disabled={addingFromBucket === f.path} onClick={() => { setAddingFromBucket(f.path); const hint = [safeDisplayName(fileDisplay, f.path, f.name)]; projectFilesApi.addFromBucket(projectId, f.path, safeDisplayName(fileDisplay, f.path, f.name), folderDisplayName).then((row) => { loadFiles(); queueGptResyncAfterUpload(hint, row?.id != null ? [row.id] : []); setAddingFromBucket(null); }).catch(err => { setError(err.response?.data?.error || err.message); setAddingFromBucket(null); }); }}>{addingFromBucket === f.path ? t.uploading : t.addToProject}</button>
                            </li>
                          );
                        })}
                      </ul>
                    );
                  }
                  const tree = buildBucketTree(filtered, sharepointDisplayNamesMap, projectId);
                  return (
                    <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                      {tree.map(node => renderBucketNode(node))}
                    </ul>
                  );
                })()}
              </div>
            </div>
          </div>
        )}
        {showSharepointUploadModal && (
          <div className="modal-overlay" onClick={() => !sharepointUploading && setShowSharepointUploadModal(false)} role="dialog" aria-modal="true" aria-label={t.uploadToSharepoint}>
            <div className="modal card" onClick={e => e.stopPropagation()} style={{ maxWidth: 480 }}>
              <div className="flex gap" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <h4 style={{ margin: 0 }}>{t.uploadToSharepoint}</h4>
                <button type="button" className="secondary" disabled={sharepointUploading} onClick={() => setShowSharepointUploadModal(false)}>×</button>
              </div>
              <input
                type="file"
                multiple
                id="sharepoint-upload-files"
                className="rag-file-input-hidden"
                onChange={e => {
                  const list = e.target.files;
                  const files = list ? Array.from(list) : [];
                  setSharepointUploadFiles(files);
                  setSharepointUploadFolderName(''); // no folder context when picking individual files
                  e.target.value = '';
                }}
              />
              <input
                ref={sharepointFolderInputRef}
                type="file"
                multiple
                id="sharepoint-upload-folder"
                className="rag-file-input-hidden"
                onChange={e => {
                  const list = e.target.files;
                  const files = list ? Array.from(list) : [];
                  setSharepointUploadFiles(files);
                  if (files.length > 0) {
                    const path = files[0].webkitRelativePath;
                    const folderName = path ? path.split('/')[0] : '';
                    if (folderName) setSharepointUploadFolderName(folderName);
                  }
                  e.target.value = '';
                }}
              />
              <div
                onDrop={handleSharepointDrop}
                onDragOver={handleSharepointDragOver}
                style={{ border: '2px dashed var(--border)', borderRadius: 8, padding: 24, marginBottom: 12, textAlign: 'center', color: 'var(--muted)', fontSize: '0.9rem' }}
              >
                גרור תיקייה לכאן או בחר קבצים/תיקייה
              </div>
              <div className="flex gap" style={{ marginBottom: 12 }}>
                {/* Files upload to bucket with ASCII paths; Hebrew names are stored as display names and shown in the UI (Supabase bucket does not support Hebrew in paths). */}
                <label htmlFor="sharepoint-upload-files" className="rag-file-button" style={{ display: 'inline-block' }}>בחר קבצים</label>
                <button type="button" className="rag-file-button" onClick={() => sharepointFolderInputRef.current?.click()}>בחר תיקייה</button>
              </div>
              {sharepointUploadFiles.length > 0 && !sharepointUploading && (
                <>
                  <p className="muted" style={{ marginBottom: 8 }}>{sharepointUploadFiles.length} קבצים נבחרו</p>
                  {sharepointUploadFiles.length > 1 && (
                    <div style={{ marginBottom: 12 }}>
                      <label style={{ display: 'block', marginBottom: 4, color: 'var(--muted)', fontSize: '0.9rem' }}>{t.sharepointFolderName}</label>
                      <input
                        type="text"
                        className="form-control"
                        placeholder="למשל: דוחות-2024"
                        value={sharepointUploadFolderName}
                        onChange={e => setSharepointUploadFolderName(e.target.value)}
                        dir="ltr"
                      />
                    </div>
                  )}
                </>
              )}
              {sharepointUploading && (() => {
                const total = sharepointUploadTotal || sharepointUploadFiles.reduce((s, f) => s + (f.size || 0), 0);
                const loaded = sharepointUploadLoaded;
                const format = (n) => n >= 1024 * 1024 ? (n / (1024 * 1024)).toFixed(1) + ' MB' : n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B';
                const pct = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
                const waitingOnServer = total > 0 && loaded >= total;
                const server = sharepointServerProgress;
                const serverLine = server?.phase === 'displayNames'
                  ? 'שומר שמות תצוגה...'
                  : server?.file != null && server?.total
                    ? `מעלה קובץ ${server.file} מתוך ${server.total}`
                    : waitingOnServer
                      ? 'מעבד בשרת...'
                      : null;
                return (
                  <div style={{ marginBottom: 12 }} role="status" aria-live="polite">
                    <p className="loading" style={{ marginBottom: 6 }}>
                      {waitingOnServer ? (serverLine || 'מעבד בשרת...') : `מעלה ${sharepointUploadFiles.length} קבצים — ${format(loaded)} / ${format(total)}`}
                    </p>
                    <div style={{ height: 8, background: 'var(--border)', borderRadius: 4, overflow: 'hidden' }}>
                      <div
                        style={{
                          height: '100%',
                          width: `${pct}%`,
                          background: 'var(--accent)',
                          borderRadius: 4,
                          transition: 'width 0.2s ease'
                        }}
                      />
                    </div>
                    {waitingOnServer && serverLine && <p className="muted" style={{ marginTop: 6, fontSize: '0.85rem' }}>{serverLine}</p>}
                  </div>
                );
              })()}
              <div className="flex gap">
                <button type="button" className="secondary" onClick={() => setShowSharepointUploadModal(false)} disabled={sharepointUploading}>ביטול</button>
                <button
                  type="button"
                  disabled={sharepointUploadFiles.length === 0 || sharepointUploading}
                  onClick={() => {
                    if (sharepointUploadFiles.length === 0) {
                      setError('בחר קבצים או תיקייה להעלאה');
                      return;
                    }
                    if (!projectId) {
                      setError('פרויקט לא זמין');
                      return;
                    }
                    setSharepointUploading(true);
                    setSharepointServerProgress(null);
                    const totalBytes = sharepointUploadFiles.reduce((s, f) => s + (f.size || 0), 0);
                    setSharepointUploadLoaded(0);
                    setSharepointUploadTotal(totalBytes);
                    setError(null);
                    const folderPath = sharepointUploadFolderName.trim() || (sharepointUploadFiles.length > 1 ? 'upload' : '');
                    const filesToUpload = [...sharepointUploadFiles];
                    const gptHintNames = filesToUpload.map((f) => f.name || f.webkitRelativePath || '');
                    const uploadId = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `upload-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
                    const progressOpts = {
                      uploadId,
                      onUploadProgress: (e) => {
                        if (e.loaded != null) setSharepointUploadLoaded(e.loaded);
                        if (e.total != null) setSharepointUploadTotal(e.total);
                        if (e.total && e.loaded >= e.total && !sharepointProgressPollRef.current) {
                          sharepointProgressPollRef.current = setInterval(() => {
                            projectFilesApi.getSharepointUploadProgress(projectId, uploadId).then(setSharepointServerProgress).catch(() => {});
                          }, 800);
                        }
                      },
                      onProgress: (loaded, total) => {
                        setSharepointUploadLoaded(loaded);
                        if (total != null) setSharepointUploadTotal(total);
                      }
                    };
                    projectFilesApi.uploadToSharepointBucketDirect(projectId, filesToUpload, folderPath, progressOpts)
                      .then(res => {
                        setActionMessage(res.failed > 0 ? t.sharepointUploadSomeFailed : t.sharepointUploadSuccess);
                        setTimeout(() => setActionMessage(null), 3000);
                        setShowSharepointUploadModal(false);
                        setSharepointUploadFiles([]);
                        setSharepointUploadFolderName('');
                        const afterSharepointIngest = (registeredIds) =>
                          loadFiles()
                            .catch(() => {})
                            .finally(() => queueGptResyncAfterUpload(gptHintNames, registeredIds));
                        if (res.uploaded_paths?.length) {
                          projectFilesApi
                            .registerAndIngest(projectId, res.uploaded_paths)
                            .then((reg) => afterSharepointIngest(reg?.registered_ids))
                            .catch(() => afterSharepointIngest(null));
                        } else {
                          afterSharepointIngest(null);
                        }
                        if (showSharepointPicker) {
                          setSharepointBucketLoading(true);
                          projectFilesApi.listSharepointBucket(projectId).then(d => {
                            const files = d.files || [];
                            setSharepointBucketFiles(files);
                            setSharepointDisplayNamesMap(d.displayNamesMap || {});
                            setSharepointBucketLoading(false);
                            setSharepointExpandedFolders(prev => new Set(prev).add('manual'));
                          }).catch(() => setSharepointBucketLoading(false));
                        }
                      })
                      .catch(err => {
                        setError(getNetworkErrorMessage(err));
                      })
                      .finally(() => {
                        if (sharepointProgressPollRef.current) {
                          clearInterval(sharepointProgressPollRef.current);
                          sharepointProgressPollRef.current = null;
                        }
                        setSharepointUploading(false);
                        setSharepointUploadLoaded(0);
                        setSharepointUploadTotal(0);
                        setSharepointServerProgress(null);
                      });
                  }}
                >
                  {sharepointUploading ? t.uploading : 'העלה'}
                </button>
              </div>
            </div>
          </div>
        )}
      </section>

      <section className="rag-section" aria-labelledby="docs-list-heading">
        <h4 id="docs-list-heading" style={{ fontSize: '1rem', marginBottom: 8 }}>{t.docsListSection}</h4>
        {filesLoading && <p className="loading">{t.loading}</p>}
        {!filesLoading && projectFiles.length === 0 && <p className="muted">{t.noFilesYet}</p>}
        {!filesLoading && projectFiles.length > 0 && (() => {
          const FOLDER_SEP = /[/\\>]+/;
          function buildTree(files) {
            const root = { type: 'folder', pathFull: '', children: [], files: [] };
            for (const f of files) {
              const pathStr = f.folder_display_name != null && f.folder_display_name !== '' ? String(f.folder_display_name).trim() : '';
              const segments = pathStr ? pathStr.split(FOLDER_SEP).map(s => s.trim()).filter(Boolean) : [];
              let node = root;
              for (let i = 0; i < segments.length; i++) {
                const pathFull = segments.slice(0, i + 1).join('/');
                let child = node.children.find(c => c.type === 'folder' && c.pathFull === pathFull);
                if (!child) {
                  child = { type: 'folder', pathSegment: segments[i], pathFull, children: [], files: [] };
                  node.children.push(child);
                }
                node = child;
              }
              node.files.push(f);
            }
            if (root.files.length > 0) {
              root.children.push({ type: 'folder', pathSegment: t.noFolder, pathFull: '\0', children: [], files: root.files });
              root.files = [];
            }
            root.children.sort((a, b) => (a.pathFull === '\0' ? 1 : b.pathFull === '\0' ? -1 : (a.pathSegment || '').localeCompare(b.pathSegment || '')));
            function sortNode(n) {
              n.children.sort((a, b) => (a.pathFull === '\0' ? 1 : b.pathFull === '\0' ? -1 : (a.pathSegment || '').localeCompare(b.pathSegment || '')));
              n.children.forEach(sortNode);
            }
            sortNode(root);
            return root;
          }
          const tree = buildTree(projectFiles);
          const toggleProjectFolder = (pathFull) => {
            setProjectFileFoldersCollapsed(prev => {
              const next = new Set(prev);
              if (next.has(pathFull)) next.delete(pathFull);
              else next.add(pathFull);
              return next;
            });
          };
          function countItems(node) {
            let n = node.files.length;
            for (const c of node.children) n += countItems(c);
            return n;
          }
          function renderFolderNode(node, depth = 0) {
            const isRoot = node.pathFull === '';
            const isCollapsed = !isRoot && projectFileFoldersCollapsed.has(node.pathFull);
            const label = isRoot ? null : node.pathSegment;
            const count = countItems(node);
            const hasNested = node.children.length > 0 || node.files.length > 0;
            return (
              <div key={node.pathFull || 'root'} className="rag-folder-group" style={isRoot ? {} : { marginLeft: Math.min(depth * 16, 80) }}>
                {!isRoot && (
                  <button type="button" className="rag-folder-toggle" onClick={() => toggleProjectFolder(node.pathFull)} aria-expanded={!isCollapsed}>
                    <span className="rag-folder-chevron" aria-hidden style={{ transform: isCollapsed ? 'rotate(-90deg)' : undefined }}>▼</span>
                    <span className="rag-folder-name">📁 {label}</span>
                    <span className="rag-folder-count">{count}</span>
                  </button>
                )}
                {(!isRoot ? !isCollapsed : true) && (
                  <div className="rag-folder-files">
                    {node.files.map(f => (
                      <div key={f.id} className="list-item">
                        <div>
                          <span>{f.original_name}</span>
                          {f.ingest_error && (
                            <div className="rag-file-index-error" role="alert">{f.ingest_error}</div>
                          )}
                          {!f.ingest_error && !isIndexableFileName(f.original_name) && (
                            <div className="rag-file-index-error" role="alert">{t.fileCannotBeIndexed}</div>
                          )}
                        </div>
                        <div className="flex gap">
                          <button type="button" className="secondary" title={f.storage_path ? t.download : t.downloadNotAvailable} disabled={!f.storage_path} onClick={() => f.storage_path && projectFilesApi.download(projectId, f.id, f.original_name).catch(err => setError(err.response?.data?.error || err.message))}>{t.download}</button>
                          <button type="button" className={`secondary ${removingFileId === f.id ? 'btn-loading' : ''}`} onClick={() => removeFile(f.id)} disabled={removingFileId === f.id}>{removingFileId === f.id ? t.loading : t.remove}</button>
                        </div>
                      </div>
                    ))}
                    {node.children.map(c => renderFolderNode(c, depth + 1))}
                  </div>
                )}
              </div>
            );
          }
          return (
            <div className="rag-file-list">
              {renderFolderNode(tree)}
            </div>
          );
        })()}
      </section>

      <section className="rag-section rag-section-ask" aria-labelledby="docs-ask-heading">
        <h4 id="docs-ask-heading" style={{ fontSize: '1rem', marginBottom: 8 }}>{t.docsAskSection}</h4>
        {(() => {
          const hasAnyProjectFile = projectFiles.length > 0;
          const hasStoredFile = projectFiles.some(f => f.storage_path && String(f.storage_path).trim());
          const hasGptEligibleFile = projectFiles.some(isGptOpenAiEligibleProjectFile);
          let dotColor = 'var(--border)';
          let label = t.gptRagIndicatorLoading;
          let hintId = undefined;
          if (gptRagStatus) {
            if (!gptRagStatus.openai) {
              dotColor = 'var(--error, #c0392b)';
              label = gptRagStatus.reason || t.ragGptOpenAiUnavailable;
              hintId = 'rag-query-disabled-hint-gpt';
            } else if (ragUploadOrAddInProgress) {
              dotColor = 'var(--accent)';
              label = t.gptRagIndicatorUploadBusy;
              hintId = 'rag-query-disabled-hint-gpt';
            } else if (gptRagSyncing || gptBackgroundSyncBusy) {
              dotColor = 'var(--accent)';
              label = t.gptRagIndicatorSyncing;
              hintId = 'rag-query-disabled-hint-gpt';
            } else if (ragGptVectorIndexing) {
              dotColor = 'var(--accent)';
              label = t.gptRagIndicatorIndexing;
              hintId = 'rag-query-disabled-hint-gpt';
            } else if (gptRagStatus.vector_store_id) {
              dotColor = 'var(--success)';
              label = t.gptRagIndicatorSynced;
            } else if (!hasGptEligibleFile) {
              dotColor = 'var(--muted)';
              if (!hasAnyProjectFile) {
                label = t.gptRagIndicatorNoFiles;
              } else if (!hasStoredFile) {
                label = t.gptRagIndicatorNoStoragePath;
              } else {
                label = t.gptRagIndicatorNoSupportedFiles;
              }
              hintId = 'rag-query-disabled-hint-gpt';
            } else if (gptSyncHadError) {
              dotColor = 'var(--error, #c0392b)';
              label = t.gptRagIndicatorSyncFailed;
              hintId = 'rag-query-disabled-hint-gpt';
            } else {
              dotColor = 'var(--accent)';
              label = t.gptRagIndicatorPending;
              hintId = 'rag-query-disabled-hint-gpt';
            }
          }
          return (
            <div
              className="form-group rag-gpt-status-row"
              style={{
                padding: '10px 12px',
                background: 'var(--bg-soft)',
                borderRadius: 8,
                border: '1px solid var(--border)',
                marginBottom: 12
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span
                  aria-hidden
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: '50%',
                    flexShrink: 0,
                    background: dotColor
                  }}
                />
                <span id={hintId} style={{ fontSize: '0.9rem', flex: '1 1 200px' }}>
                  {label}
                </span>
                {gptRagStatus?.openai &&
                  gptRagStatus.vector_store_id &&
                  !gptRagSyncing &&
                  !gptBackgroundSyncBusy &&
                  !ragGptVectorIndexing &&
                  !ragUploadOrAddInProgress && (
                  <button
                    type="button"
                    className="secondary"
                    style={{ fontSize: '0.85rem', padding: '4px 10px' }}
                    disabled={!hasGptEligibleFile}
                    onClick={runGptSync}
                  >
                    {t.gptRagResyncShort}
                  </button>
                )}
                {gptRagStatus?.openai &&
                  !gptRagStatus.vector_store_id &&
                  !gptRagSyncing &&
                  !gptBackgroundSyncBusy &&
                  hasGptEligibleFile &&
                  gptSyncHadError && (
                    <button
                      type="button"
                      className="secondary"
                      style={{ fontSize: '0.85rem', padding: '4px 10px' }}
                      onClick={() => {
                        gptAutoSyncForProjectRef.current = '';
                        setGptSyncHadError(false);
                        runGptSync();
                      }}
                    >
                      {t.gptRagRetrySync}
                    </button>
                  )}
                <button
                  type="button"
                  className="secondary"
                  style={{ fontSize: '0.85rem', padding: '4px 10px' }}
                  disabled={gptRagSyncing || gptBackgroundSyncBusy}
                  onClick={refreshGptRagStatus}
                >
                  {t.gptRagRefreshStatus}
                </button>
                {hasAnyProjectFile &&
                  projectFiles.some((f) => !f.storage_path || !String(f.storage_path).trim()) &&
                  health?.ok &&
                  !gptRagSyncing &&
                  !gptBackgroundSyncBusy &&
                  !storageRepairLoading && (
                    <button
                      type="button"
                      className="secondary"
                      style={{ fontSize: '0.85rem', padding: '4px 10px' }}
                      onClick={runStorageRepairFromRag}
                      title={t.gptRagIndicatorNoStoragePath}
                    >
                      {t.gptRagRepairStorageFromRag}
                    </button>
                  )}
                {storageRepairLoading && (
                  <span style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>{t.gptRagRepairStorageRunning}</span>
                )}
              </div>
            </div>
          );
        })()}
        <p className="muted" style={{ fontSize: '0.88rem', marginBottom: 10 }}>{t.ragComparePercentagesLabHint}</p>
        <label htmlFor="rag-query-scope">{t.queryOver}</label>
        <select
          id="rag-query-scope"
          value={selectedProjectFileId}
          onChange={(e) => setSelectedProjectFileId(e.target.value)}
          disabled={loading || projectFiles.length === 0}
          style={{ marginBottom: 10 }}
        >
          <option value="">{t.allFiles}</option>
          {projectFiles.map((f) => (
            <option key={f.id} value={String(f.id)}>
              {f.original_name || f.storage_path || `#${f.id}`}
            </option>
          ))}
        </select>
        <label htmlFor="rag-query-input">{t.askQuestion}</label>
        <textarea
          id="rag-query-input"
          dir="auto"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={t.questionPlaceholder}
          rows={4}
          disabled={
            loading ||
            ragAskPipelineBusy ||
            projectFiles.length === 0 ||
            !gptRagStatus?.openai ||
            !gptRagStatus?.vector_store_id
          }
          aria-describedby={
            gptRagStatus &&
            (!gptRagStatus.openai ||
              !gptRagStatus.vector_store_id ||
              ragAskPipelineBusy)
              ? 'rag-query-disabled-hint-gpt'
              : undefined
          }
        />
        <button
          type="button"
          onClick={runSearch}
          disabled={
            loading ||
            ragAskPipelineBusy ||
            projectFiles.length === 0 ||
            !gptRagStatus?.openai ||
            !gptRagStatus?.vector_store_id
          }
          className={loading ? 'btn-loading' : ''}
          title={ragAskButtonTitle}
        >
          {loading ? t.loading : t.run}
        </button>
        {actionMessage && !result && (
          <p style={{ color: 'var(--success)', fontSize: '0.9rem', marginTop: 12 }}>{actionMessage}</p>
        )}
        {result && (
          <>
            <div className="flex gap mt-16" style={{ flexWrap: 'wrap' }}>
              <button type="button" className="secondary" onClick={copyAnswer}>{t.copyAnswer}</button>
              <button type="button" className="secondary" onClick={saveAnswerAsNote}>{t.saveAnswerAsNote}</button>
            </div>
            {actionMessage && <p style={{ color: 'var(--success)', fontSize: '0.9rem', marginTop: 8 }}>{actionMessage}</p>}
            <div className="rag-result mt-16">{result}</div>
            {Array.isArray(answerSources) && answerSources.length > 0 && (
              <section className="rag-answer-sources mt-16" aria-label={t.ragAnswerSourcesTitle}>
                <h4 className="rag-answer-sources__title">{t.ragAnswerSourcesTitle}</h4>
                <p className="rag-answer-sources__hint muted">{t.ragAnswerSourcesHint}</p>
                <ul className="rag-answer-sources__list">
                  {answerSources.map((s, i) => (
                    <li key={`${s.filename}-${i}`} className="rag-source-card">
                      <div className="rag-source-card__file">{s.filename || '—'}</div>
                      <blockquote className="rag-source-card__quote">{s.excerpt || ''}</blockquote>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
        {loading && <p className="loading mt-16">{t.running}</p>}
      </section>
    </div>
  );
}

function stripHtmlPreview(html) {
  if (!html) return '';
  return String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function fileToBase64Part(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result || '');
      const i = s.indexOf(',');
      resolve(i >= 0 ? s.slice(i + 1) : s);
    };
    r.onerror = () => reject(new Error('read failed'));
    r.readAsDataURL(file);
  });
}

function emailAttachmentsList(row) {
  if (!row || row.attachments == null) return [];
  const a = row.attachments;
  if (Array.isArray(a)) return a;
  if (typeof a === 'string') {
    try {
      const p = JSON.parse(a);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  return [];
}

function EmailsTab({ projectId }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [list, setList] = React.useState([]);
  const [listLoading, setListLoading] = React.useState(true);
  const [listError, setListError] = React.useState(null);
  const [selectedId, setSelectedId] = React.useState(null);
  const [selected, setSelected] = React.useState(null);
  /** 'sent' | 'received' — matches API `direction` (backend + Resend inbound already store received). */
  const [mailFolder, setMailFolder] = React.useState('sent');

  const [showCompose, setShowCompose] = React.useState(false);
  const [to, setTo] = React.useState('');
  const [subject, setSubject] = React.useState('');
  const [body, setBody] = React.useState('');
  const [sending, setSending] = React.useState(false);
  const [formError, setFormError] = React.useState(null);
  const [formSuccess, setFormSuccess] = React.useState(false);
  const [importingKey, setImportingKey] = React.useState(null);
  const [importNotice, setImportNotice] = React.useState(null);
  const [composeFilesList, setComposeFilesList] = React.useState([]);
  const [composeFilesLoading, setComposeFilesLoading] = React.useState(false);
  const [composeAttachIds, setComposeAttachIds] = React.useState([]);
  const [composeLocalFiles, setComposeLocalFiles] = React.useState([]);
  const [showProjectAttachModal, setShowProjectAttachModal] = React.useState(false);
  const pcAttachInputRef = React.useRef(null);
  const composeAttachIdsRef = React.useRef([]);
  const composeLocalFilesLenRef = React.useRef(0);
  React.useEffect(() => {
    composeAttachIdsRef.current = composeAttachIds;
  }, [composeAttachIds]);
  React.useEffect(() => {
    composeLocalFilesLenRef.current = composeLocalFiles.length;
  }, [composeLocalFiles.length]);

  const attachableComposeFiles = React.useMemo(
    () => composeFilesList.filter(f => f.storage_path && String(f.storage_path).trim()),
    [composeFilesList]
  );

  React.useEffect(() => {
    const allowed = new Set(attachableComposeFiles.map(f => f.id));
    setComposeAttachIds(ids => ids.filter(id => allowed.has(id)));
  }, [attachableComposeFiles]);

  const fetchEmails = React.useCallback(() => {
    setListLoading(true);
    setListError(null);
    emailsApi.list(projectId, { direction: mailFolder, limit: 80, offset: 0 })
      .then(d => {
        const emails = d.emails || [];
        setList(emails);
        setSelectedId(cur => (cur && !emails.some(e => e.id === cur) ? null : cur));
      })
      .catch(e => setListError(errorMessageFromResponse(e, t.emailLoadError)))
      .finally(() => setListLoading(false));
  }, [projectId, mailFolder]);

  React.useEffect(() => { fetchEmails(); }, [fetchEmails]);

  React.useEffect(() => {
    const prefill = location.state?.fromLabEmail;
    if (!prefill || typeof prefill.body !== 'string' || !prefill.body.trim()) return;
    setBody(prefill.body.trim());
    if (typeof prefill.subject === 'string' && prefill.subject.trim()) setSubject(prefill.subject.trim());
    setTo('');
    setComposeAttachIds([]);
    setComposeLocalFiles([]);
    setShowCompose(true);
    setSelectedId(null);
    setSelected(null);
    setFormError(null);
    setFormSuccess(false);
    navigate(`/project/${projectId}/section/emails`, { replace: true, state: {} });
  }, [location.state, projectId, navigate]);

  React.useEffect(() => {
    if (!selectedId) {
      setSelected(null);
      return;
    }
    const row = list.find(e => e.id === selectedId);
    if (row) setSelected(row);
    else setSelected(null);
  }, [list, selectedId]);

  React.useEffect(() => {
    if (!showCompose) return undefined;
    let cancelled = false;
    setComposeFilesLoading(true);
    projectFilesApi
      .list(projectId, { limit: 100, offset: 0 })
      .then(d => {
        if (!cancelled) setComposeFilesList(d.files || []);
      })
      .catch(() => {
        if (!cancelled) setComposeFilesList([]);
      })
      .finally(() => {
        if (!cancelled) setComposeFilesLoading(false);
      });
    return () => { cancelled = true; };
  }, [showCompose, projectId]);

  const send = async () => {
    const addr = (to || '').trim();
    const sub = (subject || '').trim();
    const text = (body || '').trim();
    if (!addr || !sub || !text || sending) return;
    if (composeAttachIds.length + composeLocalFiles.length > 15) {
      setFormError(t.emailAttachTooMany);
      return;
    }
    setSending(true);
    setFormError(null);
    setFormSuccess(false);
    let inline_attachments;
    try {
      inline_attachments = [];
      for (const f of composeLocalFiles) {
        const content_base64 = await fileToBase64Part(f);
        inline_attachments.push({ filename: f.name, content_base64 });
      }
    } catch {
      setFormError(t.emailAttachReadError);
      setSending(false);
      return;
    }
    const payload = { to: addr, subject: sub, text };
    if (composeAttachIds.length > 0) payload.attachment_file_ids = composeAttachIds;
    if (inline_attachments.length > 0) payload.inline_attachments = inline_attachments;
    emailsApi
      .send(projectId, payload)
      .then(() => {
        setFormSuccess(true);
        setBody('');
        setComposeAttachIds([]);
        setComposeLocalFiles([]);
        setComposeFilesList([]);
        setShowProjectAttachModal(false);
        setShowCompose(false);
        setSelectedId(null);
        setMailFolder('sent');
        fetchEmails();
      })
      .catch(e => setFormError(errorMessageFromResponse(e, t.emailConfigMissing)))
      .finally(() => setSending(false));
  };

  const importAttachment = (storedEmailId, attachmentId, destination) => {
    if (!attachmentId || importingKey) return;
    const key = `${attachmentId}:${destination}`;
    setImportingKey(key);
    setImportNotice(null);
    emailsApi.importAttachment(projectId, storedEmailId, { attachment_id: attachmentId, destination })
      .then((res) => {
        setImportNotice({ ok: true, text: t.emailImportDone });
        const row = res && res.file;
        const fileId = row && row.id;
        const originalName = (row && (row.original_name || row.originalName)) || 'file';
        const prefetched =
          res && res.lab_parsed_text != null && res.lab_parsed_text !== undefined ? res.lab_parsed_text : null;
        const prefetchedSheets =
          res && Array.isArray(res.lab_parsed_excel_sheets) && res.lab_parsed_excel_sheets.length > 0
            ? res.lab_parsed_excel_sheets
            : null;
        if (destination === 'lab' && fileId) {
          navigate(`/project/${projectId}/section/lab`, {
            state: {
              labEmailImport:
                prefetched != null
                  ? { fileId, originalName, prefetchedText: prefetched, prefetchedExcelSheets: prefetchedSheets }
                  : { fileId, originalName, prefetchedExcelSheets: prefetchedSheets }
            }
          });
        } else if (destination === 'lab') {
          navigate(`/project/${projectId}/section/lab`);
        } else {
          navigate(`/project/${projectId}/section/rag`);
        }
      })
      .catch(e => setImportNotice({ ok: false, text: errorMessageFromResponse(e, '') }))
      .finally(() => setImportingKey(null));
  };

  return (
    <div className="card tab-card emails-tab">
      <div className="emails-toolbar">
        <div className="emails-toolbar-left">
          <div className="emails-folder-switch" role="tablist" aria-label={t.emailsTab}>
            <button
              type="button"
              role="tab"
              aria-selected={mailFolder === 'sent'}
              className={`emails-folder-btn ${mailFolder === 'sent' ? 'active' : ''}`}
              onClick={() => {
                if (mailFolder === 'sent') return;
                setMailFolder('sent');
                setSelectedId(null);
                setSelected(null);
                setImportNotice(null);
              }}
            >
              {t.emailFolderSent}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mailFolder === 'received'}
              className={`emails-folder-btn ${mailFolder === 'received' ? 'active' : ''}`}
              onClick={() => {
                if (mailFolder === 'received') return;
                setMailFolder('received');
                setSelectedId(null);
                setSelected(null);
                setImportNotice(null);
              }}
            >
              {t.emailFolderReceived}
            </button>
          </div>
          {!listLoading && list.length > 0 && (
            <span className="emails-toolbar-count" aria-live="polite">{list.length}</span>
          )}
        </div>
        <button
          type="button"
          onClick={() => {
            setShowCompose(v => {
              const next = !v;
              if (!next) {
                setComposeAttachIds([]);
                setComposeLocalFiles([]);
                setComposeFilesList([]);
                setShowProjectAttachModal(false);
              }
              return next;
            });
            setFormError(null);
            setFormSuccess(false);
          }}
        >
          {showCompose ? t.cancel : t.emailCompose}
        </button>
      </div>

      {showCompose && (
        <div className="emails-compose-panel">
          {formError && <p className="error" style={{ marginBottom: 8 }}>{formError}</p>}
          {formSuccess && <p style={{ marginBottom: 8, color: 'var(--success)', fontWeight: 600 }}>{t.emailSent}</p>}
          <div className="form-group">
            <label htmlFor="email-to">{t.emailTo}</label>
            <input id="email-to" type="email" dir="ltr" value={to} onChange={e => setTo(e.target.value)} placeholder="name@example.com" />
          </div>
          <div className="form-group">
            <label htmlFor="email-subject">{t.emailSubject}</label>
            <input id="email-subject" type="text" value={subject} onChange={e => setSubject(e.target.value)} />
          </div>
          <div className="form-group">
            <label htmlFor="email-body">{t.emailBody}</label>
            <textarea id="email-body" rows={8} value={body} onChange={e => setBody(e.target.value)} />
          </div>
          <div className="form-group">
            <span className="emails-compose-attach-label">{t.emailAttachmentsComposeLabel}</span>
            <div className="emails-compose-attach-buttons">
              <button
                type="button"
                className="secondary"
                disabled={sending}
                onClick={() => setShowProjectAttachModal(true)}
              >
                {t.emailAttachFromProjectBtn}
              </button>
              <button
                type="button"
                className="secondary"
                disabled={sending}
                onClick={() => pcAttachInputRef.current?.click()}
              >
                {t.emailAttachFromPcBtn}
              </button>
              <input
                ref={pcAttachInputRef}
                type="file"
                multiple
                className="emails-file-input-hidden"
                aria-hidden
                tabIndex={-1}
                onChange={e => {
                  const picked = Array.from(e.target.files || []);
                  const inputEl = e.target;
                  setComposeLocalFiles(prev => {
                    const additions = [];
                    const nProj = composeAttachIdsRef.current.length;
                    for (const file of picked) {
                      if (nProj + prev.length + additions.length >= 15) break;
                      if (prev.length + additions.length >= 8) break;
                      additions.push(file);
                    }
                    return [...prev, ...additions];
                  });
                  inputEl.value = '';
                }}
              />
            </div>
            {(composeAttachIds.length > 0 || composeLocalFiles.length > 0) && (
              <ul className="emails-compose-attach-chips">
                {composeAttachIds.map(id => {
                  const f = composeFilesList.find(x => x.id === id);
                  return (
                    <li key={`p-${id}`} className="emails-compose-chip">
                      <span dir="ltr" className="emails-compose-chip-text">{f?.original_name || id}</span>
                      <button
                        type="button"
                        className="emails-compose-chip-remove"
                        aria-label={t.remove}
                        disabled={sending}
                        onClick={() => setComposeAttachIds(ids => ids.filter(i => i !== id))}
                      >
                        ×
                      </button>
                    </li>
                  );
                })}
                {composeLocalFiles.map((f, i) => (
                  <li key={`l-${f.name}-${f.size}-${f.lastModified}-${i}`} className="emails-compose-chip">
                    <span dir="ltr" className="emails-compose-chip-text">{f.name}</span>
                    <button
                      type="button"
                      className="emails-compose-chip-remove"
                      aria-label={t.remove}
                      disabled={sending}
                      onClick={() => setComposeLocalFiles(prev => prev.filter((_, j) => j !== i))}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <button type="button" onClick={send} disabled={sending || !to.trim() || !subject.trim() || !body.trim()} className={sending ? 'btn-loading' : ''}>{sending ? t.loading : t.emailSend}</button>
        </div>
      )}

      {showCompose && showProjectAttachModal && (
        <div
          className="modal-overlay"
          onClick={() => setShowProjectAttachModal(false)}
          role="dialog"
          aria-modal="true"
          aria-label={t.emailAttachModalTitle}
        >
          <div className="modal card emails-attach-modal" onClick={e => e.stopPropagation()}>
            <h4 className="emails-attach-modal-title">{t.emailAttachModalTitle}</h4>
            {composeFilesLoading && <p className="loading">{t.loading}</p>}
            {!composeFilesLoading && composeFilesList.length === 0 && (
              <p className="loading">{t.emailAttachNoFiles}</p>
            )}
            {!composeFilesLoading && composeFilesList.length > 0 && attachableComposeFiles.length === 0 && (
              <p className="loading">{t.emailAttachNoAttachableFiles}</p>
            )}
            {!composeFilesLoading && attachableComposeFiles.length > 0 && (
              <ul className="emails-compose-attach-list emails-attach-modal-list modal-scroll">
                {attachableComposeFiles.map(f => {
                  const checked = composeAttachIds.includes(f.id);
                  return (
                    <li key={f.id}>
                      <label className="emails-compose-attach-item">
                        <input
                          type="checkbox"
                          disabled={sending}
                          checked={checked}
                          onChange={e => {
                            setComposeAttachIds(ids => {
                              if (e.target.checked) {
                                if (ids.length + composeLocalFilesLenRef.current >= 15) return ids;
                                if (ids.includes(f.id)) return ids;
                                return [...ids, f.id];
                              }
                              return ids.filter(x => x !== f.id);
                            });
                          }}
                        />
                        <span dir="auto" className="emails-compose-attach-name">{f.original_name || f.id}</span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="emails-attach-modal-footer">
              <button type="button" className="secondary" onClick={() => setShowProjectAttachModal(false)}>
                {t.emailAttachModalClose}
              </button>
            </div>
          </div>
        </div>
      )}

      {listError && <p className="error" style={{ marginBottom: 8 }}>{listError}</p>}

      <div className={`emails-split ${selectedId ? 'emails-split--with-detail' : 'emails-split--list-only'}`}>
        <div className="emails-list-pane">
          {listLoading && <p className="loading">{t.loading}</p>}
          {!listLoading && list.length === 0 && (
            <div className="emails-empty-folder">
              <p className="loading">{t.emailEmptyList}</p>
              {mailFolder === 'received' && (
                <p className="emails-empty-folder-hint muted">{t.emailReceivedSetupHint}</p>
              )}
            </div>
          )}
          {!listLoading && list.map(item => {
            const preview = item.body_text || stripHtmlPreview(item.body_html) || '—';
            const short = preview.length > 120 ? `${preview.slice(0, 120)}…` : preview;
            const when = item.created_at ? new Date(item.created_at).toLocaleString('he-IL') : '';
            const fromTo = item.direction === 'sent'
              ? `${t.emailToLabel}: ${Array.isArray(item.to_emails) ? item.to_emails.join(', ') : ''}`
              : `${t.emailFrom}: ${item.from_email || '—'}`;
            return (
              <button
                type="button"
                key={item.id}
                className={`emails-list-item ${selectedId === item.id ? 'active' : ''}`}
                onClick={() => {
                  if (selectedId === item.id) {
                    setSelectedId(null);
                    setSelected(null);
                  } else {
                    setSelectedId(item.id);
                    setSelected(item);
                  }
                }}
              >
                <span className="emails-list-subject">{item.subject || '(ללא נושא)'}</span>
                <span className="emails-list-meta">{fromTo}</span>
                <span className="emails-list-preview">{short}</span>
                <span className="emails-list-date">{when}</span>
              </button>
            );
          })}
        </div>
        <div className="emails-detail-pane">
          {!selectedId && <p className="loading emails-detail-empty">{t.emailNoSelection}</p>}
          {selectedId && selected && (
            <div className="emails-detail-content">
              <h4 className="emails-detail-subject">{selected.subject || '(ללא נושא)'}</h4>
              <div className="emails-detail-headers">
                <div><strong>{t.emailFrom}:</strong> <span dir="ltr">{selected.from_email}</span></div>
                <div><strong>{t.emailToLabel}:</strong> <span dir="ltr">{Array.isArray(selected.to_emails) ? selected.to_emails.join(', ') : JSON.stringify(selected.to_emails)}</span></div>
                <div><strong>{t.emailDate}:</strong> {selected.created_at ? new Date(selected.created_at).toLocaleString('he-IL') : ''}</div>
                {selected.direction === 'sent' && selected.sent_by_username && (
                  <div><strong>{t.emailSentBy}:</strong> {selected.sent_by_username}</div>
                )}
              </div>
              <div className="emails-detail-body">
                {selected.body_text ? (
                  <pre className="emails-body-text">{selected.body_text}</pre>
                ) : selected.body_html ? (
                  <iframe title="email-html" className="emails-body-html-frame" sandbox="" srcDoc={selected.body_html} />
                ) : (
                  <p className="loading">—</p>
                )}
              </div>
              {selected.direction === 'sent' && emailAttachmentsList(selected).length > 0 && (
                <div className="emails-attachments">
                  <h5>{t.emailAttachments}</h5>
                  {emailAttachmentsList(selected).map((att, idx) => {
                    const key = att.project_file_id || `${att.filename || 'file'}-${idx}`;
                    return (
                      <div key={key} className="emails-attachment-row emails-attachment-row-readonly">
                        <span className="emails-attachment-name" dir="ltr">{att.filename || att.project_file_id || 'file'}</span>
                      </div>
                    );
                  })}
                </div>
              )}
              {selected.direction === 'received' && (
                <div className="emails-attachments">
                  <h5>{t.emailAttachments}</h5>
                  {importNotice && (
                    <p className={importNotice.ok ? 'loading' : 'error'} style={{ marginBottom: 8 }}>{importNotice.text}</p>
                  )}
                  {emailAttachmentsList(selected).length === 0 && (
                    <p className="loading">{t.emailNoAttachments}</p>
                  )}
                  {emailAttachmentsList(selected).map(att => {
                    const aid = att.id || att.attachment_id;
                    return (
                      <div key={aid || att.filename} className="emails-attachment-row">
                        <span className="emails-attachment-name" dir="ltr">
                          {att.filename || aid || 'file'}
                          {att.content_type ? ` · ${att.content_type}` : ''}
                        </span>
                        <div className="emails-attachment-actions">
                          <button
                            type="button"
                            className="secondary"
                            disabled={!aid || !!importingKey}
                            onClick={() => importAttachment(selected.id, aid, 'project_files')}
                          >
                            {importingKey === `${aid}:project_files` ? t.emailImporting : t.emailImportToDocuments}
                          </button>
                          <button
                            type="button"
                            className="secondary"
                            disabled={!aid || !!importingKey}
                            onClick={() => importAttachment(selected.id, aid, 'lab')}
                          >
                            {importingKey === `${aid}:lab` ? t.emailImporting : t.emailImportToLab}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ChatTab({ projectId, onUnreadChange }) {
  const [messages, setMessages] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [input, setInput] = React.useState('');
  const [sending, setSending] = React.useState(false);
  const [error, setError] = React.useState(null);
  const listRef = React.useRef(null);

  const markReadThroughMessages = React.useCallback((msgs) => {
    if (!msgs || msgs.length === 0) {
      return chatApi.markRead(projectId).then(() => { onUnreadChange?.(); });
    }
    let maxMs = 0;
    for (const m of msgs) {
      if (!m.created_at) continue;
      const t = Date.parse(m.created_at);
      if (!Number.isNaN(t) && t > maxMs) maxMs = t;
    }
    const iso = maxMs > 0 ? new Date(maxMs).toISOString() : undefined;
    return (iso ? chatApi.markRead(projectId, iso) : chatApi.markRead(projectId))
      .then(() => { onUnreadChange?.(); })
      .catch(() => {});
  }, [projectId, onUnreadChange]);

  const load = () => {
    chatApi.list(projectId)
      .then(d => {
        const msgs = d.messages || [];
        setMessages(msgs);
        setError(null);
        return markReadThroughMessages(msgs);
      })
      .catch(e => setError(e.response?.data?.error || e.message))
      .finally(() => setLoading(false));
  };
  React.useEffect(() => { setLoading(true); load(); }, [projectId]);
  React.useEffect(() => { if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight; }, [messages]);

  const send = () => {
    const text = (input || '').trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    chatApi.send(projectId, text)
      .then(msg => {
        setMessages(prev => [...prev, msg]);
        setInput('');
        const ts = msg.created_at || new Date().toISOString();
        return chatApi.markRead(projectId, ts);
      })
      .then(() => { onUnreadChange?.(); })
      .catch(e => setError(e.response?.data?.error || e.message))
      .finally(() => setSending(false));
  };

  const formatTime = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div className="card tab-card chat-tab">
      <h3>💬 {t.chat}</h3>
      {error && <p className="error" style={{ marginBottom: 12 }}>{error}</p>}
      <div ref={listRef} className="chat-messages" aria-live="polite">
        {loading && <p className="loading">{t.loading}</p>}
        {!loading && messages.length === 0 && <p className="loading">{t.noChatYet}</p>}
        {!loading && messages.map(m => (
          <div key={m.id} className="chat-message">
            <span className="chat-message-meta">{m.username} · {formatTime(m.created_at)}</span>
            <p className="chat-message-body">{m.body}</p>
          </div>
        ))}
      </div>
      <div className="chat-input-row">
        <textarea value={input} onChange={e => setInput(e.target.value)} placeholder={t.chatPlaceholder} rows={2} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
        <button type="button" onClick={send} disabled={sending || !input.trim()} className={sending ? 'btn-loading' : ''}>{sending ? t.loading : t.chatSend}</button>
      </div>
    </div>
  );
}

function MembersTab({ projectId }) {
  const [requests, setRequests] = React.useState([]);
  const [members, setMembers] = React.useState([]);
  const [addableUsers, setAddableUsers] = React.useState([]);
  const [selectedUsername, setSelectedUsername] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(null);
  const [addingMember, setAddingMember] = React.useState(false);
  const [actingRequestId, setActingRequestId] = React.useState(null);

  const load = () => {
    Promise.all([
      projectsApi.getRequests(projectId),
      projectsApi.getMembers(projectId),
      usersApi.list(projectId).catch(() => ({ users: [] }))
    ])
      .then(([rRes, mRes, uRes]) => {
        setRequests(rRes.requests || []);
        setMembers(mRes.members || []);
        setAddableUsers(uRes.users || []);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  };
  React.useEffect(() => { load(); }, [projectId]);

  const approve = (requestId) => {
    setActingRequestId(requestId);
    projectsApi.approveRequest(projectId, requestId).then(() => load()).catch(e => setError(e.response?.data?.error || e.message)).finally(() => setActingRequestId(null));
  };
  const reject = (requestId) => {
    setActingRequestId(requestId);
    projectsApi.rejectRequest(projectId, requestId).then(() => load()).catch(e => setError(e.message)).finally(() => setActingRequestId(null));
  };
  const addMember = () => {
    if (!selectedUsername.trim()) return;
    setAddingMember(true);
    projectsApi.addMember(projectId, selectedUsername.trim())
      .then(() => { setSelectedUsername(''); load(); setError(null); })
      .catch(e => setError(e.response?.data?.error || t.userNotFound || e.message))
      .finally(() => setAddingMember(false));
  };

  return (
    <div className="card tab-card">
      <h3>{t.members}</h3>
      {error && <p className="error">{error}</p>}
      <div className="form-group">
        <label>{t.addMember}</label>
        {!loading && (
          <>
            <div className="flex gap" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
              <select
                value={selectedUsername}
                onChange={e => setSelectedUsername(e.target.value)}
                style={{ minWidth: 180 }}
                aria-label={t.selectUser}
              >
                <option value="">{t.selectUser}</option>
                {addableUsers.map(u => (
                  <option key={u.user_id} value={u.username}>{u.username}</option>
                ))}
              </select>
              <button onClick={addMember} disabled={!selectedUsername || addingMember} className={addingMember ? 'btn-loading' : ''}>{addingMember ? t.loading : t.add}</button>
            </div>
            {addableUsers.length === 0 && (
              <p style={{ fontSize: '0.85rem', color: 'var(--muted)', marginTop: 4 }}>{t.noUsersToAdd}</p>
            )}
          </>
        )}
      </div>
      <div className="form-group">
        <label>{t.pendingRequests}</label>
        {loading && <p className="loading">{t.loading}</p>}
        {!loading && requests.length === 0 && <p className="loading">{t.noPendingRequests}</p>}
        {!loading && requests.map(req => (
          <div key={req.id} className="list-item">
            <span>{req.username}</span>
            <div className="flex gap">
              <button onClick={() => approve(req.id)} disabled={actingRequestId === req.id} className={actingRequestId === req.id ? 'btn-loading' : ''}>{actingRequestId === req.id ? t.loading : t.approve}</button>
              <button className="secondary" onClick={() => reject(req.id)} disabled={actingRequestId === req.id}>{actingRequestId === req.id ? t.loading : t.reject}</button>
            </div>
          </div>
        ))}
      </div>
      <div className="form-group">
        <label>{t.members}</label>
        {!loading && members.map(m => (
          <div key={m.user_id} className="list-item">
            <span>{m.username} <span className="badge badge-todo">{m.role === 'owner' ? t.owner : t.member}</span></span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SettingsTab({ projectId, project, setProject, navigate, projectRole, user: currentUser }) {
  const [name, setName] = React.useState(project?.name || '');
  const [description, setDescription] = React.useState(project?.description || '');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [requests, setRequests] = React.useState([]);
  const [members, setMembers] = React.useState([]);
  const [permLoading, setPermLoading] = React.useState(false);
  const [addableUsers, setAddableUsers] = React.useState([]);
  const [selectedUsername, setSelectedUsername] = React.useState('');
  const [deletingProject, setDeletingProject] = React.useState(false);
  const [addingMember, setAddingMember] = React.useState(false);
  const [actingRequestId, setActingRequestId] = React.useState(null);
  const [removingUserId, setRemovingUserId] = React.useState(null);

  React.useEffect(() => {
    setName(project?.name || '');
    setDescription(project?.description || '');
  }, [project]);

  const loadPerms = () => {
    if (projectRole !== 'owner') return;
    setPermLoading(true);
    Promise.all([
      projectsApi.getRequests(projectId),
      projectsApi.getMembers(projectId),
      usersApi.list(projectId).catch(() => ({ users: [] }))
    ])
      .then(([rRes, mRes, uRes]) => {
        setRequests(rRes.requests || []);
        setMembers(mRes.members || []);
        setAddableUsers(uRes.users || []);
      })
      .catch(() => {})
      .finally(() => setPermLoading(false));
  };
  React.useEffect(() => { loadPerms(); }, [projectId, projectRole]);

  const save = () => {
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    projectsApi.update(projectId, { name: name.trim(), description: description.trim() || null })
      .then(updated => { setProject(updated); setSaving(false); })
      .catch(e => { setError(e.message); setSaving(false); });
  };

  const deleteProject = () => {
    if (!window.confirm(t.deleteProjectConfirm)) return;
    setDeletingProject(true);
    projectsApi.delete(projectId)
      .then(() => navigate('/'))
      .catch(e => { setError(e.message); setDeletingProject(false); });
  };

  const approveRequest = (requestId) => {
    setActingRequestId(requestId);
    projectsApi.approveRequest(projectId, requestId).then(loadPerms).catch(e => setError(e.response?.data?.error || e.message)).finally(() => setActingRequestId(null));
  };
  const rejectRequest = (requestId) => {
    setActingRequestId(requestId);
    projectsApi.rejectRequest(projectId, requestId).then(loadPerms).catch(e => setError(e.message)).finally(() => setActingRequestId(null));
  };
  const addMember = () => {
    if (!selectedUsername.trim()) return;
    setAddingMember(true);
    projectsApi.addMember(projectId, selectedUsername.trim())
      .then(() => { setSelectedUsername(''); loadPerms(); setError(null); })
      .catch(e => setError(e.response?.data?.error || t.userNotFound || e.message))
      .finally(() => setAddingMember(false));
  };
  const removeMember = (userId) => {
    if (!window.confirm(t.removeFromProject + '?')) return;
    setRemovingUserId(userId);
    projectsApi.removeMember(projectId, userId).then(loadPerms).catch(e => setError(e.response?.data?.error || e.message)).finally(() => setRemovingUserId(null));
  };

  const isOwner = projectRole === 'owner';

  return (
    <div className="card tab-card">
      <h3>{t.projectSettings}</h3>
      {error && <p className="error">{error}</p>}
      {isOwner ? (
        <>
          <div className="form-group">
            <label>{t.name}</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder={t.projectName} />
          </div>
          <div className="form-group">
            <label>{t.description}</label>
            <textarea value={description} onChange={e => setDescription(e.target.value)} placeholder={t.optional} rows={3} />
          </div>
          <div className="flex gap">
            <button onClick={save} disabled={saving} className={saving ? 'btn-loading' : ''}>{saving ? t.loading : t.saveChanges}</button>
            <button className={`danger ${deletingProject ? 'btn-loading' : ''}`} onClick={deleteProject} disabled={deletingProject}>{deletingProject ? t.loading : t.deleteProject}</button>
          </div>
        </>
      ) : (
        <>
          <div className="form-group">
            <label>{t.name}</label>
            <p style={{ margin: 0 }}>{project?.name || ''}</p>
          </div>
          <div className="form-group">
            <label>{t.description}</label>
            <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{project?.description || t.noDescription}</p>
          </div>
        </>
      )}

      {/* הרשאות פרויקט – only for project owner (opener) */}
      {isOwner && (
        <>
          <hr className="settings-divider" />
          <h3 style={{ marginTop: 24 }}>{t.projectPermissions}</h3>
          <div className="form-group">
            <label>{t.pendingRequests}</label>
            {permLoading && <p className="loading">{t.loading}</p>}
            {!permLoading && requests.length === 0 && <p className="loading">{t.noPendingRequests}</p>}
            {!permLoading && requests.map(req => (
              <div key={req.id} className="list-item">
                <span>{req.username}</span>
                <div className="flex gap">
                  <button type="button" onClick={() => approveRequest(req.id)} disabled={actingRequestId === req.id} className={actingRequestId === req.id ? 'btn-loading' : ''}>{actingRequestId === req.id ? t.loading : t.approve}</button>
                  <button type="button" className="secondary" onClick={() => rejectRequest(req.id)} disabled={actingRequestId === req.id}>{actingRequestId === req.id ? t.loading : t.reject}</button>
                </div>
              </div>
            ))}
          </div>
          <div className="form-group">
            <label>{t.addMember}</label>
            {!permLoading && (
              <>
                <div className="flex gap" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
                  <select
                    value={selectedUsername}
                    onChange={e => setSelectedUsername(e.target.value)}
                    style={{ minWidth: 180 }}
                    aria-label={t.selectUser}
                  >
                    <option value="">{t.selectUser}</option>
                    {addableUsers.map(u => (
                      <option key={u.user_id} value={u.username}>{u.username}</option>
                    ))}
                  </select>
                  <button type="button" onClick={addMember} disabled={!selectedUsername || addingMember} className={addingMember ? 'btn-loading' : ''}>{addingMember ? t.loading : t.add}</button>
                </div>
                {addableUsers.length === 0 && (
                  <p style={{ fontSize: '0.85rem', color: 'var(--muted)', marginTop: 4 }}>{t.noUsersToAdd}</p>
                )}
              </>
            )}
          </div>
          <div className="form-group">
            <label>{t.members}</label>
            {!permLoading && members.map(m => (
              <div key={m.user_id} className="list-item">
                <span>{m.username} <span className="badge badge-todo">{m.role === 'owner' ? t.owner : t.member}</span></span>
                {m.role === 'member' && currentUser && m.user_id !== currentUser.id && (
                  <button type="button" className={`secondary ${removingUserId === m.user_id ? 'btn-loading' : ''}`} onClick={() => removeMember(m.user_id)} disabled={removingUserId === m.user_id}>{removingUserId === m.user_id ? t.loading : t.removeFromProject}</button>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function AuthPasswordField({ id, value, onChange, autoComplete }) {
  const [show, setShow] = React.useState(false);
  return (
    <div className="auth-password-field">
      <input
        id={id}
        type={show ? 'text' : 'password'}
        value={value}
        onChange={onChange}
        autoComplete={autoComplete}
        required
      />
      <button
        type="button"
        className="auth-password-toggle"
        onClick={() => setShow((s) => !s)}
        aria-label={show ? 'הסתר סיסמה' : 'הצג סיסמה'}
        aria-pressed={show}
      >
        {show ? <HiEyeSlash size={20} aria-hidden /> : <HiEye size={20} aria-hidden />}
      </button>
    </div>
  );
}

function LoginView({ onLogin }) {
  const [username, setUsername] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const navigate = useNavigate();

  const submit = (e) => {
    e.preventDefault();
    if (!username.trim() || !password) return;
    setError(null);
    setLoading(true);
    authApi.login(username.trim(), password)
      .then(data => {
        setAuth(data.access_token, data.user);
        onLogin(data.user);
        navigate('/');
      })
      .catch(err => {
        setError(errorMessageFromResponse(err, t.loginError));
        setLoading(false);
      });
  };

  return (
    <div className="app-shell" dir="rtl">
      <div className="card tab-card auth-card" style={{ maxWidth: 340, margin: '40px auto' }}>
        <h2 className="page-title">{t.loginTitle}</h2>
        {error && <p className="error">{typeof error === 'string' ? error : String(error)}</p>}
        <form onSubmit={submit}>
          <div className="form-group">
            <label>{t.username}</label>
            <input value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" required />
          </div>
          <div className="form-group">
            <label htmlFor="login-password">{t.password}</label>
            <AuthPasswordField
              id="login-password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </div>
          <div className="flex gap">
            <button type="submit" disabled={loading} className={loading ? 'btn-loading' : ''}>{loading ? t.loading : t.loginButton}</button>
            <Link to="/signup" className="secondary" style={{ alignSelf: 'center' }}>{t.signup}</Link>
          </div>
        </form>
        <p className="auth-footer-p" style={{ color: 'var(--muted)' }}>{t.noAccount} <Link to="/signup">{t.signup}</Link></p>
      </div>
    </div>
  );
}

function SignupView({ onSignup }) {
  const [username, setUsername] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [fullName, setFullName] = React.useState('');
  const [error, setError] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const navigate = useNavigate();

  const submit = (e) => {
    e.preventDefault();
    if (!username.trim() || !email.trim() || !password) return;
    setError(null);
    setLoading(true);
    authApi.signup(username.trim(), email.trim(), password, fullName.trim() || null)
      .then(data => {
        setAuth(data.access_token, data.user);
        onSignup(data.user);
        navigate('/');
      })
      .catch(err => {
        setError(errorMessageFromResponse(err, t.signupError));
        setLoading(false);
      });
  };

  return (
    <div className="app-shell" dir="rtl">
      <div className="card tab-card auth-card" style={{ maxWidth: 340, margin: '40px auto' }}>
        <h2 className="page-title">{t.signupTitle}</h2>
        {error && <p className="error">{typeof error === 'string' ? error : String(error)}</p>}
        <form onSubmit={submit}>
          <div className="form-group">
            <label>{t.username}</label>
            <input value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" required />
          </div>
          <div className="form-group">
            <label>{t.email}</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" required />
          </div>
          <div className="form-group">
            <label htmlFor="signup-password">{t.password}</label>
            <AuthPasswordField
              id="signup-password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              autoComplete="new-password"
            />
          </div>
          <div className="form-group">
            <label>{t.fullName}</label>
            <input value={fullName} onChange={e => setFullName(e.target.value)} placeholder={t.optional} autoComplete="name" />
          </div>
          <div className="flex gap">
            <button type="submit" disabled={loading} className={loading ? 'btn-loading' : ''}>{loading ? t.loading : t.signupButton}</button>
            <Link to="/login" style={{ alignSelf: 'center' }}>{t.login}</Link>
          </div>
        </form>
        <p className="auth-footer-p" style={{ color: 'var(--muted)' }}>{t.haveAccount} <Link to="/login">{t.login}</Link></p>
      </div>
    </div>
  );
}

function ProtectedRoute({ user, children }) {
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

export default function App() {
  const [user, setUser] = React.useState(null);
  const [authChecked, setAuthChecked] = React.useState(false);

  React.useEffect(() => {
    const token = getStoredToken();
    const storedUser = getStoredUser();
    if (token) {
      setAuth(token, storedUser);
      setUser(storedUser || null);
      authApi
        .me()
        .then((me) => setUser(me))
        .catch(() => {
          clearAuth();
          setUser(null);
        })
        .finally(() => setAuthChecked(true));
    } else {
      setUser(storedUser);
      setAuthChecked(true);
    }
  }, []);

  const handleLogout = () => {
    clearAuth();
    setUser(null);
  };

  if (!authChecked) return <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}>{t.loading}</div>;

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={user ? <Navigate to="/" replace /> : <LoginView onLogin={setUser} />} />
        <Route path="/signup" element={user ? <Navigate to="/" replace /> : <SignupView onSignup={setUser} />} />
        <Route path="/" element={<ProtectedRoute user={user}><AuthenticatedLayout user={user} onLogout={handleLogout} /></ProtectedRoute>}>
          <Route index element={<Home user={user} onLogout={handleLogout} dashboardMode />} />
          <Route path="projects" element={<Home user={user} onLogout={handleLogout} />} />
          <Route path="project/:id" element={<ProjectView user={user} onLogout={handleLogout} />} />
          <Route path="project/:id/section/:sectionId" element={<ProjectView user={user} onLogout={handleLogout} />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
