/**
 * Axios client for management backend — uses the same Bearer token as Matriya (localStorage `token`).
 */
import axios from 'axios';
import { MANAGEMENT_API_URL } from './managementConfig';

const managementApi = axios.create({
  baseURL: MANAGEMENT_API_URL || 'https://invalid.local',
  timeout: 30000,
  headers: { 'Content-Type': 'application/json' }
});

managementApi.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

export default managementApi;
