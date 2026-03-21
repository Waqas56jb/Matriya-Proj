/**
 * Configuration settings for the RAG system
 */
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, mkdirSync } from 'fs';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

class Settings {
  constructor() {
    // Vector Database Settings
    this.CHROMA_DB_PATH = process.env.CHROMA_DB_PATH || "./chroma_db";
    this.COLLECTION_NAME = process.env.COLLECTION_NAME || "rag_documents";
    
    // Embedding Model (local)
    this.EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "sentence-transformers/all-MiniLM-L6-v2";
    
    // Document Processing
    this.UPLOAD_DIR = process.env.UPLOAD_DIR || "./uploads";
    this.MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE) || 50 * 1024 * 1024; // 50MB
    this.ALLOWED_EXTENSIONS = [".pdf", ".docx", ".txt", ".doc", ".xlsx", ".xls"];
    
    // Chunking Settings
    this.CHUNK_SIZE = parseInt(process.env.CHUNK_SIZE) || 500;
    this.CHUNK_OVERLAP = parseInt(process.env.CHUNK_OVERLAP) || 100;
    
    // API Settings
    this.API_HOST = process.env.API_HOST || "0.0.0.0";
    this.API_PORT = parseInt(process.env.API_PORT) || 8000;
    
    // Supabase Settings (optional - only for Supabase client features)
    this.SUPABASE_URL = process.env.SUPABASE_URL || null;
    this.SUPABASE_KEY = process.env.SUPABASE_KEY || null;
    
    // LLM API Configuration (Together AI or Hugging Face)
    this.LLM_PROVIDER = process.env.LLM_PROVIDER || "together";
    this.TOGETHER_API_KEY = process.env.TOGETHER_API_KEY || null;
    this.TOGETHER_MODEL = process.env.TOGETHER_MODEL || "mistralai/Mistral-7B-Instruct-v0.2";
    this.HF_API_TOKEN = process.env.HF_API_TOKEN || null;
    this.HF_MODEL = process.env.HF_MODEL || "microsoft/phi-2";

    // OpenAI (for Ask Matriya chat)
    this.OPENAI_API_KEY = process.env.OPENAI_API_KEY || null;
    // OpenAI File Search (Responses API): set USE_OPENAI_FILE_SEARCH=true and sync documents (or MATRIYA_OPENAI_VECTOR_STORE_ID)
    this.OPENAI_API_BASE = process.env.OPENAI_API_BASE || 'https://api.openai.com/v1';
    this.OPENAI_RAG_MODEL = process.env.OPENAI_RAG_MODEL || 'gpt-4o-mini';
  }
}

// Create directories if they don't exist
const settings = new Settings();

// Only create uploads directory if not on Vercel (Vercel uses /tmp)
if (!process.env.VERCEL) {
  try {
    if (!existsSync(settings.UPLOAD_DIR)) {
      mkdirSync(settings.UPLOAD_DIR, { recursive: true });
    }
  } catch (e) {
    // On Vercel, we'll use /tmp for uploads
  }
}

export default settings;
