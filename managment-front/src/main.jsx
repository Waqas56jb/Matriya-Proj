import React from 'react';
import ReactDOM from 'react-dom/client';
import { setAuth } from './api.js';
import App from './App';
import './index.css';

/** Embedded from Matriya: same JWT as Matriya login (maneger auth proxies to Matriya). */
try {
  const h = window.location.hash || '';
  if (h.startsWith('#matriya_token=')) {
    const token = decodeURIComponent(h.slice('#matriya_token='.length).trim());
    if (token) setAuth(token, null);
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }
} catch (_) {
  /* ignore */
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
