/**
 * Configuration settings for the RAG system
 */
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { existsSync, mkdirSync } from 'fs';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const VERCEL_DEPLOY =
  process.env.VERCEL === '1' || process.env.VERCEL === 'true' || Boolean(process.env.VERCEL_ENV);

/** Multer temp files: must live under /tmp on Vercel (project dir is read-only). */
function resolveUploadDir() {
  if (VERCEL_DEPLOY) {
    const fromEnv = (process.env.UPLOAD_DIR || '').trim();
    if (fromEnv.startsWith('/tmp')) {
      return fromEnv.replace(/\/$/, '') || '/tmp/matriya-uploads';
    }
    return '/tmp/matriya-uploads';
  }
  return (process.env.UPLOAD_DIR || './uploads').replace(/\/$/, '') || './uploads';
}

class Settings {
  constructor() {
    // Vector Database Settings
    this.CHROMA_DB_PATH = process.env.CHROMA_DB_PATH || "./chroma_db";
    this.COLLECTION_NAME = process.env.COLLECTION_NAME || "rag_documents";
    
    // Embedding Model (local)
    this.EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "sentence-transformers/all-MiniLM-L6-v2";
    
    // Document Processing — Vercel serverless: only /tmp is writable. Do not use ./uploads even if UPLOAD_DIR is copied from local .env.
    this.UPLOAD_DIR = resolveUploadDir();
    this.MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE) || 50 * 1024 * 1024; // 50MB
    this.ALLOWED_EXTENSIONS = [".pdf", ".docx", ".txt", ".doc", ".xlsx", ".xls"];
    
    // Chunking Settings
    this.CHUNK_SIZE = parseInt(process.env.CHUNK_SIZE) || 500;
    this.CHUNK_OVERLAP = parseInt(process.env.CHUNK_OVERLAP) || 100;
    
    // API Settings
    this.API_HOST = process.env.API_HOST || "0.0.0.0";
    this.API_PORT = parseInt(process.env.API_PORT) || 8000;
    /**
     * JSON / urlencoded body size cap. Default Express is 100kb — too small for POST /ask-matriya when
     * "כל הקבצים" sends hundreds of long logical paths (413 Payload Too Large).
     * If 413 persists behind nginx, raise client_max_body_size to match or exceed this.
     */
    this.EXPRESS_BODY_LIMIT = (process.env.EXPRESS_BODY_LIMIT || '15mb').trim() || '15mb';
    
    // Supabase Settings (optional - only for Supabase client features)
    this.SUPABASE_URL = process.env.SUPABASE_URL || null;
    this.SUPABASE_KEY = process.env.SUPABASE_KEY || null;
    
    // LLM API Configuration (Together AI or Hugging Face)
    this.LLM_PROVIDER = process.env.LLM_PROVIDER || "together";
    this.TOGETHER_API_KEY = process.env.TOGETHER_API_KEY || null;
    this.TOGETHER_MODEL = process.env.TOGETHER_MODEL || "mistralai/Mistral-7B-Instruct-v0.2";
    this.HF_API_TOKEN = process.env.HF_API_TOKEN || null;
    this.HF_MODEL = process.env.HF_MODEL || "microsoft/phi-2";
    /** RAG/local LLM decoding: default 0 for repeatable answers (scope sign-off §8). Override with MATRIYA_LLM_TEMPERATURE. */
    this.LLM_TEMPERATURE = (() => {
      const t = parseFloat(process.env.MATRIYA_LLM_TEMPERATURE ?? '0');
      if (!Number.isFinite(t) || t < 0) return 0;
      return Math.min(2, t);
    })();

    // OpenAI (for Ask Matriya chat)
    this.OPENAI_API_KEY = process.env.OPENAI_API_KEY || null;
    // OpenAI File Search (Responses API): set USE_OPENAI_FILE_SEARCH=true and sync documents (or MATRIYA_OPENAI_VECTOR_STORE_ID)
    this.OPENAI_API_BASE = process.env.OPENAI_API_BASE || 'https://api.openai.com/v1';
    this.OPENAI_RAG_MODEL = process.env.OPENAI_RAG_MODEL || 'gpt-4o-mini';
  }
}

// Create directories if they don't exist
const settings = new Settings();

// Ensure upload dir exists (Vercel: /tmp/matriya-uploads — mkdir each cold start is cheap)
try {
  if (!existsSync(settings.UPLOAD_DIR)) {
    mkdirSync(settings.UPLOAD_DIR, { recursive: true });
  }
} catch (e) {
  // Non-fatal; multer destination also mkdirs
}

export default settings;
