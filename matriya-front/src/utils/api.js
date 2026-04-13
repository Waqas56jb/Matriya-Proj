/**
 * API utility with authentication
 */
import axios from 'axios';

// Matriya API base URL — MUST be set at build time (CRA inlines env at compile).
// Do not default to matriya-back.vercel.app: that deployment is legacy and rejects
// flow=lab (returns session_id required). Point at YOUR Matriya API project, e.g.
// https://matriya-proj-hfmn.vercel.app
let API_BASE_URL = (process.env.REACT_APP_API_BASE_URL || '').trim();

if (process.env.NODE_ENV === 'development') {
    console.log('REACT_APP_API_BASE_URL from env:', process.env.REACT_APP_API_BASE_URL);
}

if (!API_BASE_URL) {
    if (process.env.NODE_ENV === 'development') {
        API_BASE_URL = 'http://localhost:8000';
        console.warn('REACT_APP_API_BASE_URL not set; using http://localhost:8000');
    } else {
        throw new Error(
            'Matriya UI: REACT_APP_API_BASE_URL is missing at build time. In Vercel open the matriya-front project → Settings → Environment Variables → add REACT_APP_API_BASE_URL = your Matriya API URL (no trailing slash), then Redeploy.'
        );
    }
}

API_BASE_URL = API_BASE_URL.replace(/\/$/, '');

// Create axios instance
const api = axios.create({
    baseURL: API_BASE_URL,
    timeout: 60000, // default; heavy routes override (e.g. gpt-rag/sync, ask-matriya)
    headers: {
        'Content-Type': 'application/json'
    }
});

// Add token to requests if available
api.interceptors.request.use(
    (config) => {
        const token = localStorage.getItem('token');
        if (token) {
            config.headers.Authorization = `Bearer ${token}`;
        }
        // Let the browser set multipart boundary + UTF-8 filenames; default JSON Content-Type breaks FormData in axios transformRequest
        if (typeof FormData !== 'undefined' && config.data instanceof FormData) {
            delete config.headers['Content-Type'];
        }
        return config;
    },
    (error) => {
        return Promise.reject(error);
    }
);

// Handle 401 errors (unauthorized)
api.interceptors.response.use(
    (response) => response,
    (error) => {
        if (error.response?.status === 401) {
            // Token expired or invalid
            localStorage.removeItem('token');
            localStorage.removeItem('user');
            window.location.reload();
        }
        return Promise.reject(error);
    }
);

export default api;
export { API_BASE_URL };
