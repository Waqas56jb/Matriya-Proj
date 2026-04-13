/**
 * API utility with authentication
 */
import axios from 'axios';

// Use environment variable for API URL (REQUIRED)
// Set REACT_APP_API_BASE_URL in .env file or Vercel environment variables
// IMPORTANT: React environment variables must be available at BUILD TIME, not runtime
let API_BASE_URL = process.env.REACT_APP_API_BASE_URL;

// Debug logging (will be removed in production build)
if (process.env.NODE_ENV === 'development') {
    console.log('REACT_APP_API_BASE_URL from env:', process.env.REACT_APP_API_BASE_URL);
}

// Fallback to default if not set
if (!API_BASE_URL || API_BASE_URL.trim() === '') {
    API_BASE_URL = 'https://matriya-back.vercel.app';
    console.warn('REACT_APP_API_BASE_URL is not set! Using default: https://matriya-back.vercel.app');
    console.warn('For local development, create a .env file with: REACT_APP_API_BASE_URL=http://localhost:8000');
    console.warn('For production, set it in Vercel Dashboard → Settings → Environment Variables');
}

// Ensure no trailing slash
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
