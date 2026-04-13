import axios from 'axios';
import { createClient } from '@supabase/supabase-js';

// Backend URL from .env (VITE_MANEGER_API_URL) – used for all API and file uploads
export const API_BASE = (import.meta.env.VITE_MANEGER_API_URL || 'http://localhost:8001').replace(/\/$/, '');

export const api = axios.create({
  baseURL: API_BASE,
  timeout: 60000,
  headers: { 'Content-Type': 'application/json' }
});

const AUTH_TOKEN_KEY = 'maneger_token';
const AUTH_USER_KEY = 'maneger_user';

export function getStoredToken() {
  return localStorage.getItem(AUTH_TOKEN_KEY);
}
export function getStoredUser() {
  try {
    const u = localStorage.getItem(AUTH_USER_KEY);
    return u ? JSON.parse(u) : null;
  } catch {
    return null;
  }
}
export function setAuth(token, user) {
  if (token) localStorage.setItem(AUTH_TOKEN_KEY, token);
  else localStorage.removeItem(AUTH_TOKEN_KEY);
  if (user) localStorage.setItem(AUTH_USER_KEY, JSON.stringify(user));
  else localStorage.removeItem(AUTH_USER_KEY);
  api.defaults.headers.common.Authorization = token ? `Bearer ${token}` : '';
}
export function clearAuth() {
  setAuth(null, null);
}

/** Turn axios network/request errors into a clearer message for the user. */
export function getNetworkErrorMessage(err) {
  if (!err) return 'שגיאה לא ידועה';
  const serverMsg = err.response?.data?.error;
  if (serverMsg && typeof serverMsg === 'string') {
    if (serverMsg === 'Too many uploads') return 'יותר מדי העלאות ברגע זה. המתן דקה ונסה שוב או העלה פחות קבצים.';
    return serverMsg;
  }
  const status = err.response?.status;
  const msg = err.message || '';
  const code = err.code || '';
  if (code === 'ECONNABORTED' || msg.includes('timeout')) return 'הבקשה ארכה יותר מדי (timeout). נסה שוב או להעלות פחות קבצים.';
  if (status === 404) return 'השרת החזיר 404 – ייתכן שהנתיב לא קיים. בדוק שהשרת מעודכן (Vercel).';
  if (status === 413) return 'הקבצים גדולים מדי. נסה להעלות פחות קבצים או קבצים קטנים יותר.';
  if (status >= 500) return `שגיאת שרת (${status}). נסה שוב מאוחר יותר.`;
  if (code === 'ERR_NETWORK' || msg === 'Network Error') return 'שגיאת רשת: לא ניתן להתחבר לשרת. בדוק ש־השרת רץ ו־VITE_MANEGER_API_URL נכון.';
  if (code === 'ERR_CONNECTION_REFUSED' || msg.includes('refused')) return 'החיבור נדחה. וודא שהשרת רץ (npm run dev).';
  return msg || String(err);
}

api.interceptors.request.use(config => {
  const token = getStoredToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  if (config.data instanceof FormData) delete config.headers['Content-Type'];
  return config;
});

api.interceptors.response.use(
  r => r,
  err => {
    if (err.response?.status === 401) {
      const url = err.config?.url || '';
      if (!url.includes('/api/auth/login') && !url.includes('/api/auth/signup') && !url.includes('/api/auth/me')) {
        clearAuth();
        window.location.replace('/login');
      }
    }
    return Promise.reject(err);
  }
);

export const auth = {
  login: (username, password) =>
    api.post('/api/auth/login', { username, password }).then(r => r.data),
  signup: (username, email, password, full_name) =>
    api.post('/api/auth/signup', { username, email, password, full_name }).then(r => r.data),
  me: () => api.get('/api/auth/me').then(r => r.data)
};

export const users = {
  list: (projectId) =>
    api.get('/api/users', { params: projectId ? { projectId } : {} }).then(r => r.data)
};

export const projects = {
  list: () => api.get('/api/projects').then(r => r.data),
  get: (id) => api.get(`/api/projects/${id}`).then(r => r.data),
  getAccess: (id) => api.get(`/api/projects/${id}/access`).then(r => r.data),
  create: (body) => api.post('/api/projects', body).then(r => r.data),
  update: (id, body) => api.patch(`/api/projects/${id}`, body).then(r => r.data),
  delete: (id) => api.delete(`/api/projects/${id}`).then(r => r.data),
  requestJoin: (id) => api.post(`/api/projects/${id}/request`).then(r => r.data),
  getRequests: (id) => api.get(`/api/projects/${id}/requests`).then(r => r.data),
  approveRequest: (projectId, requestId) => api.post(`/api/projects/${projectId}/requests/${requestId}/approve`).then(r => r.data),
  rejectRequest: (projectId, requestId) => api.post(`/api/projects/${projectId}/requests/${requestId}/reject`).then(r => r.data),
  getMembers: (id) => api.get(`/api/projects/${id}/members`).then(r => r.data),
  addMember: (id, username) => api.post(`/api/projects/${id}/members`, { username }).then(r => r.data),
  removeMember: (id, userId) => api.delete(`/api/projects/${id}/members/${userId}`).then(r => r.data)
};

export const chat = {
  list: (projectId) => api.get(`/api/projects/${projectId}/chat`).then(r => r.data),
  count: (projectId) => api.get(`/api/projects/${projectId}/chat/count`).then(r => r.data),
  /** Server-side unread count (per user, survives reload/devices). */
  unread: (projectId) => api.get(`/api/projects/${projectId}/chat/unread`).then(r => r.data),
  /** Mark messages through this ISO time as read (omit = latest message or now). */
  markRead: (projectId, readThrough) =>
    api
      .post(`/api/projects/${projectId}/chat/read`, readThrough ? { read_through: readThrough } : {})
      .then(r => r.data),
  send: (projectId, body) => api.post(`/api/projects/${projectId}/chat`, { body }).then(r => r.data)
};

/** Emails: Resend send + stored sent/received in project_emails. */
export const emails = {
  list: (projectId, params) => api.get(`/api/projects/${projectId}/emails`, { params }).then(r => r.data),
  get: (projectId, emailId) => api.get(`/api/projects/${projectId}/emails/${emailId}`).then(r => r.data),
  send: (projectId, body) =>
    api.post(`/api/projects/${projectId}/emails/send`, body, { timeout: 180000 }).then(r => r.data),
  importAttachment: (projectId, emailId, body) =>
    api.post(`/api/projects/${projectId}/emails/${emailId}/import-attachment`, body, { timeout: 120000 }).then(r => r.data)
};

export const tasks = {
  list: (projectId) => api.get(`/api/projects/${projectId}/tasks`).then(r => r.data),
  create: (projectId, body) => api.post(`/api/projects/${projectId}/tasks`, body).then(r => r.data),
  update: (projectId, taskId, body) => api.patch(`/api/projects/${projectId}/tasks/${taskId}`, body).then(r => r.data),
  delete: (projectId, taskId) => api.delete(`/api/projects/${projectId}/tasks/${taskId}`).then(r => r.data)
};

export const milestones = {
  list: (projectId) => api.get(`/api/projects/${projectId}/milestones`).then(r => r.data),
  create: (projectId, body) => api.post(`/api/projects/${projectId}/milestones`, body).then(r => r.data),
  update: (projectId, milestoneId, body) => api.patch(`/api/projects/${projectId}/milestones/${milestoneId}`, body).then(r => r.data),
  delete: (projectId, milestoneId) => api.delete(`/api/projects/${projectId}/milestones/${milestoneId}`).then(r => r.data)
};

export const documents = {
  list: (projectId) => api.get(`/api/projects/${projectId}/documents`).then(r => r.data),
  create: (projectId, body) => api.post(`/api/projects/${projectId}/documents`, body).then(r => r.data),
  update: (projectId, docId, body) => api.patch(`/api/projects/${projectId}/documents/${docId}`, body).then(r => r.data),
  delete: (projectId, docId) => api.delete(`/api/projects/${projectId}/documents/${docId}`).then(r => r.data)
};

export const notes = {
  list: (projectId) => api.get(`/api/projects/${projectId}/notes`).then(r => r.data),
  create: (projectId, body) => api.post(`/api/projects/${projectId}/notes`, body).then(r => r.data),
  update: (projectId, noteId, body) => api.patch(`/api/projects/${projectId}/notes/${noteId}`, body).then(r => r.data),
  delete: (projectId, noteId) => api.delete(`/api/projects/${projectId}/notes/${noteId}`).then(r => r.data)
};

const FILE_INGEST_TIMEOUT = 180000; // 3 min – ingest (chunking + embeddings) can be slow

export const projectFiles = {
  list: (projectId, params) =>
    api.get(`/api/projects/${projectId}/files`, { params: params || {}, timeout: 60000 }).then(r => r.data),
  upload: (projectId, file, folderDisplayName) => {
    const form = new FormData();
    form.append('file', file);
    form.append('originalName', file.name || '');
    if (folderDisplayName) form.append('folder_display_name', folderDisplayName);
    const headers = {};
    const token = getStoredToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    return axios.post(`${API_BASE}/api/projects/${projectId}/files`, form, { timeout: 120000, headers }).then(r => r.data);
  },
  delete: (projectId, fileId) => api.delete(`/api/projects/${projectId}/files/${fileId}`).then(r => r.data),
  /** Backfill storage_path from management RAG text (legacy rows without bucket file). */
  repairStorageFromRag: (projectId) =>
    api.post(`/api/projects/${projectId}/files/repair-storage-from-rag`, {}, { timeout: 300000 }).then(r => r.data),
  download: async (projectId, fileId, filename) => {
    const token = getStoredToken();
    const r = await axios.get(`${API_BASE}/api/projects/${projectId}/files/${fileId}/download`, { responseType: 'blob', validateStatus: () => true, headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (r.status !== 200) {
      const blob = r.data;
      let msg = 'Download failed';
      if (blob && (blob.type || '').startsWith('application/json')) {
        try { const j = JSON.parse(await blob.text()); msg = j.error || msg; } catch (_) {}
      }
      throw Object.assign(new Error(msg), { response: { data: { error: msg } } });
    }
    const url = URL.createObjectURL(r.data);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'download';
    a.click();
    URL.revokeObjectURL(url);
  },
  /** Same as download but returns the Blob (e.g. lab: load imported email attachment into experiment text). */
  fetchBlob: async (projectId, fileId) => {
    const token = getStoredToken();
    const r = await axios.get(`${API_BASE}/api/projects/${projectId}/files/${fileId}/download`, {
      responseType: 'blob',
      validateStatus: () => true,
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    });
    if (r.status !== 200) {
      const blob = r.data;
      let msg = 'Download failed';
      if (blob && (blob.type || '').startsWith('application/json')) {
        try {
          const j = JSON.parse(await blob.text());
          msg = j.error || msg;
        } catch (_) {}
      }
      throw Object.assign(new Error(msg), { response: { data: { error: msg } } });
    }
    return r.data;
  },
  listSharepointBucket: (projectId) => api.get(`/api/projects/${projectId}/files/sharepoint-bucket`, { params: { _: Date.now() }, timeout: 60000 }).then(r => r.data),
  addFromBucket: (projectId, path, displayName, folderDisplayName) =>
    api.post(`/api/projects/${projectId}/files/from-bucket`, { path, displayName, folder_display_name: folderDisplayName || undefined }, { timeout: FILE_INGEST_TIMEOUT }).then(r => r.data),
  /** Register uploaded paths (e.g. after direct-to-bucket upload) into project_files and trigger Matriya indexing so they can be asked on. */
  registerAndIngest: (projectId, paths) =>
    api.post(`/api/projects/${projectId}/files/register-and-ingest`, { paths }, { timeout: 120000 }).then(r => r.data),
  /** Upload one batch via backend. For chunked upload, pass folderId from previous response. */
  uploadToSharepointBucket: (projectId, files, folderPath = '', options = {}) => {
    const form = new FormData();
    if (folderPath) form.append('folderPath', folderPath);
    if (options.folderId) form.append('folderId', options.folderId);
    const names = files.map(f => f.name || f.webkitRelativePath || 'file');
    form.append('fileNames', JSON.stringify(names));
    try {
      form.append('fileNamesB64', btoa(unescape(encodeURIComponent(JSON.stringify(names)))));
    } catch (_) {}
    for (let i = 0; i < files.length; i++) form.append('files', files[i], `file-${i}`);
    const headers = options.uploadId ? { 'X-Upload-ID': options.uploadId } : {};
    return api.post(`/api/projects/${projectId}/files/upload-to-sharepoint-bucket`, form, { timeout: 900000, onUploadProgress: options.onUploadProgress, headers }).then(r => r.data);
  },
  getSharepointUploadProgress: (projectId, uploadId) => api.get(`/api/projects/${projectId}/files/upload-to-sharepoint-bucket/progress`, { params: { uploadId } }).then(r => r.data),
  /** Direct-to-bucket upload using signed URLs when Supabase is set (env or API config); otherwise chunked backend upload. Prefer direct to avoid 413 on Vercel. */
  async uploadToSharepointBucketDirect(projectId, files, folderPath = '', options = {}) {
    let supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
    let supabaseAnon = import.meta.env.VITE_SUPABASE_ANON_KEY;
    if (!supabaseUrl || !supabaseAnon) {
      try {
        const cfg = await api.get(`/api/projects/${projectId}/files/upload-to-sharepoint-bucket/config`).then(r => r.data);
        if (cfg?.useDirectUpload && cfg.supabaseUrl && cfg.supabaseAnonKey) {
          supabaseUrl = cfg.supabaseUrl;
          supabaseAnon = cfg.supabaseAnonKey;
        }
      } catch (_) {}
    }
    const totalBytes = files.reduce((s, f) => s + (f.size || 0), 0);
    if (!supabaseUrl || !supabaseAnon) {
      const CHUNK_MAX_BYTES = 3 * 1024 * 1024; // 3 MB per request (under Vercel ~4.5 MB limit)
      const CHUNK_MAX_FILES = 50;
      if (totalBytes <= CHUNK_MAX_BYTES && files.length <= CHUNK_MAX_FILES) {
        return this.uploadToSharepointBucket(projectId, files, folderPath, options);
      }
      const batches = [];
      let batch = [];
      let batchBytes = 0;
      for (const file of files) {
        const size = file.size || 0;
        if (batch.length > 0 && (batchBytes + size > CHUNK_MAX_BYTES || batch.length >= CHUNK_MAX_FILES)) {
          batches.push(batch);
          batch = [];
          batchBytes = 0;
        }
        batch.push(file);
        batchBytes += size;
      }
      if (batch.length) batches.push(batch);
      let folderId = null;
      const allUploaded = [];
      let totalFailed = 0;
      const allErrors = [];
      let loadedSoFar = 0;
      for (let i = 0; i < batches.length; i++) {
        const chunkOpts = { ...options, folderId: folderId || undefined };
        if (options.onUploadProgress) {
          chunkOpts.onUploadProgress = (e) => {
            const chunkLoaded = e.loaded != null ? e.loaded : 0;
            const loaded = loadedSoFar + chunkLoaded;
            options.onUploadProgress({ loaded, total: totalBytes });
            if (options.onProgress) options.onProgress(loaded, totalBytes);
          };
        }
        const res = await this.uploadToSharepointBucket(projectId, batches[i], folderPath, chunkOpts);
        if (res.folderId) folderId = res.folderId;
        if (res.uploaded_paths) allUploaded.push(...res.uploaded_paths);
        if (res.failed) totalFailed += res.failed;
        if (res.errors) allErrors.push(...res.errors);
        loadedSoFar += batches[i].reduce((s, f) => s + (f.size || 0), 0);
        if (options.onUploadProgress) options.onUploadProgress({ loaded: loadedSoFar, total: totalBytes });
        if (options.onProgress) options.onProgress(loadedSoFar, totalBytes);
      }
      return { uploaded: allUploaded.length, failed: totalFailed, uploaded_paths: allUploaded, errors: allErrors.length ? allErrors : undefined };
    }
    const token = getStoredToken();
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const supabase = createClient(supabaseUrl, supabaseAnon);
    const allUploaded = [];
    const allFailed = [];
    const onProgress = options.onProgress;
    let loadedBytes = 0;
    const DIRECT_BATCH_SIZE = 50; // backend max per signed-urls request
    let folderId = null;
    for (let offset = 0; offset < files.length; offset += DIRECT_BATCH_SIZE) {
      const batch = files.slice(offset, offset + DIRECT_BATCH_SIZE);
      const fileDescriptors = batch.map(f => ({
        relativeName: f.name || f.webkitRelativePath || 'file',
        contentType: f.type || undefined
      }));
      const { data } = await axios.post(
        `${API_BASE}/api/projects/${projectId}/files/upload-to-sharepoint-bucket/signed-urls`,
        { folderPath, files: fileDescriptors, folderId: folderId || undefined },
        { headers, timeout: 120000 }
      );
      const { bucket, urls, returnedFolderId } = data;
      if (!bucket || !Array.isArray(urls) || urls.length !== batch.length) {
        throw new Error('Invalid signed URLs response');
      }
      if (returnedFolderId) folderId = returnedFolderId;
      for (let i = 0; i < batch.length; i++) {
        const file = batch[i];
        const relativeName = fileDescriptors[i].relativeName;
        const { path, token: uploadToken } = urls[i];
        let error = null;
        let result = await supabase.storage.from(bucket).uploadToSignedUrl(path, uploadToken, file, { contentType: file.type || 'application/octet-stream' });
        error = result.error;
        if (error) {
          result = await supabase.storage.from(bucket).uploadToSignedUrl(path, uploadToken, file, { contentType: file.type || 'application/octet-stream' });
          error = result.error;
        }
        if (!error) {
          loadedBytes += (file.size || 0);
          allUploaded.push({ path, name: relativeName });
        } else {
          allFailed.push({ name: relativeName, error: error.message });
        }
        if (onProgress) onProgress(loadedBytes, totalBytes);
      }
    }
    if (allUploaded.length > 0) {
      const mappings = {};
      const folderPathNorm = (folderPath && String(folderPath).trim()) ? String(folderPath).trim().replace(/\/+/g, '/') : '';
      allUploaded.forEach(u => {
        const displayName = folderPathNorm ? `${folderPathNorm}/${u.name}`.replace(/\/+/g, '/') : u.name;
        mappings[u.path] = displayName;
      });
      axios.post(
        `${API_BASE}/api/projects/${projectId}/files/upload-to-sharepoint-bucket/update-display-names`,
        { mappings },
        { headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' }, timeout: 15000 }
      ).catch(err => { console.warn('SharePoint display names update failed:', err.response?.data?.error || err.message); });
      axios.post(`${API_BASE}/api/projects/${projectId}/files/upload-to-sharepoint-bucket/invalidate-cache`, {}, { headers }).catch(() => {});
    }
    return { uploaded: allUploaded.length, failed: allFailed.length, uploaded_paths: allUploaded, errors: allFailed.length ? allFailed : undefined };
  }
};

export const lab = {
  experiments: (projectId, params) => api.get(`/api/projects/${projectId}/experiments`, { params }).then(r => r.data),
  materialsOverview: (projectId) => api.get(`/api/projects/${projectId}/materials-overview`).then(r => r.data),
  saveExperimentFromFormulation: (projectId, body) =>
    api.post(`/api/projects/${projectId}/experiments/from-formulation`, body).then((r) => r.data),
  researchSessions: (projectId) => api.get(`/api/projects/${projectId}/research-sessions`).then(r => r.data),
  createResearchSession: (projectId, body) => api.post(`/api/projects/${projectId}/research-sessions`, body).then(r => r.data),
  materialLibrary: (projectId) => api.get(`/api/projects/${projectId}/material-library`).then(r => r.data),
  addMaterial: (projectId, body) => api.post(`/api/projects/${projectId}/material-library`, body).then(r => r.data),
  importLog: (projectId, params) => api.get(`/api/projects/${projectId}/import/log`, { params }).then(r => r.data),
  syncToMatriya: (projectId) => api.post(`/api/projects/${projectId}/experiments/sync-to-matriya`).then(r => r.data),
  analysis: {
    contradictions: (projectId) => api.get(`/api/projects/${projectId}/analysis/contradictions`).then(r => r.data),
    failurePatterns: (projectId) => api.get(`/api/projects/${projectId}/analysis/failure-patterns`).then(r => r.data),
    researchSnapshot: (projectId, params) => api.get(`/api/projects/${projectId}/analysis/research-snapshot`, { params }).then(r => r.data),
    formulaValidate: (projectId, body) => api.post(`/api/projects/${projectId}/analysis/formula-validate`, body).then(r => r.data),
    relations: (projectId) => api.get(`/api/projects/${projectId}/analysis/relations`).then(r => r.data),
    insights: (projectId) => api.get(`/api/projects/${projectId}/analysis/insights`).then(r => r.data),
    formulationIntelligence: (projectId, body) => api.post(`/api/projects/${projectId}/analysis/formulation-intelligence`, body).then(r => r.data),
    similarExperiments: (projectId, experimentId) => api.get(`/api/projects/${projectId}/analysis/similar-experiments`, { params: { experiment_id: experimentId } }).then(r => r.data)
  },
  guard: (projectId, body) => api.post(`/api/projects/${projectId}/guard/check`, body).then(r => r.data),
  aiInsight: (projectId, body) => api.post(`/api/projects/${projectId}/lab/ai-insight`, body, { timeout: 60000 }).then(r => r.data),
  /** Deterministic A vs B composition table (רכיב | %A | %B | Δ). */
  comparePercentages: (projectId, body) =>
    api.post(`/api/projects/${projectId}/lab/compare-percentages`, body, { timeout: 30000 }).then((r) => r.data),
  parseExperimentFile: (projectId, file) => {
    const form = new FormData();
    form.append('file', file, file.name || 'file');
    return api.post(`/api/projects/${projectId}/lab/parse-experiment-file`, form, { timeout: 60000 }).then(r => r.data);
  },
  savedExperiments: {
    list: (projectId) => api.get(`/api/projects/${projectId}/lab/saved-experiments`).then(r => r.data),
    save: (projectId, body) => api.post(`/api/projects/${projectId}/lab/saved-experiments`, body).then(r => r.data),
    delete: (projectId, id) => api.delete(`/api/projects/${projectId}/lab/saved-experiments/${id}`).then(r => r.data)
  }
};

export const runs = {
  list: (projectId, params) => api.get(`/api/projects/${projectId}/runs`, { params }).then(r => r.data),
  get: (projectId, runId) => api.get(`/api/projects/${projectId}/runs/${runId}`).then(r => r.data),
  create: (projectId, body) => api.post(`/api/projects/${projectId}/runs`, body).then(r => r.data),
  update: (projectId, runId, body) => api.patch(`/api/projects/${projectId}/runs/${runId}`, body).then(r => r.data),
  trace: (projectId, runId) => api.get(`/api/projects/${projectId}/runs/${runId}/trace`).then(r => r.data)
};

const RAG_RUN_TIMEOUT = 120000; // 2 min – research loop runs 4 agents
const GPT_RAG_SYNC_TIMEOUT = 600000; // 10 min – upload many files + OpenAI indexing
const GPT_RAG_QUERY_TIMEOUT = 240000; // file_search + grounded chat completion (sequential)

export const rag = {
  health: () => api.get('/api/rag/health').then(r => r.data),
  files: () => api.get('/api/rag/files').then(r => r.data?.files || []),
  search: (body) => api.post('/api/rag/search', body).then(r => r.data),
  researchRun: (body) => api.post('/api/rag/research/run', body, { timeout: RAG_RUN_TIMEOUT }).then(r => r.data),
  researchSession: () => api.post('/api/rag/research/session', {}, { timeout: 15000 }).then(r => r.data)
};

/** OpenAI-hosted RAG: vector store + Responses API `file_search` (management back). */
export const gptRag = {
  status: (projectId) => api.get(`/api/projects/${projectId}/gpt-rag/status`).then(r => r.data),
  sync: (projectId, body = {}) =>
    api.post(`/api/projects/${projectId}/gpt-rag/sync`, body, { timeout: GPT_RAG_SYNC_TIMEOUT }).then((r) => r.data),
  query: (projectId, body) =>
    api.post(`/api/projects/${projectId}/gpt-rag/query`, body, { timeout: GPT_RAG_QUERY_TIMEOUT }).then(r => r.data)
};
