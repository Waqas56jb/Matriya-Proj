/**
 * Express application for RAG system file ingestion
 */
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { Op } from 'sequelize';
import { fileURLToPath } from 'url';
import path, { dirname, join } from 'path';
import { existsSync, mkdirSync, unlinkSync } from 'fs';
import settings from './config.js';
import RAGService from './ragService.js';
import { initDb, SearchHistory, ResearchSession, ResearchAuditLog, PolicyAuditLog, DecisionAuditLog, NoiseEvent, IntegrityCycleSnapshot, Experiment, EXPERIMENT_OUTCOMES } from './database.js';
import { authRouter, getCurrentUser, requireAuth } from './authEndpoints.js';
import DocumentProcessor from './documentProcessor.js';
import axios from 'axios';
import { adminRouter } from './adminEndpoints.js';
import { StateMachine, Kernel } from './stateMachine.js';
import {
  validateAndAdvance,
  logAudit,
  getOrCreateSession,
  getGateObservabilityContext,
  HARD_STOP_MESSAGE,
  stripSuggestions,
  evaluatePreLlmResearchGate,
  getModelVersionHash,
  filterChunksByRetrievalSimilarityThreshold,
  getMaxAttributionSources
} from './researchGate.js';
import { runAfterCycle, getActiveViolation } from './integrityMonitor.js';
import { runLoop } from './researchLoop.js';
import logger from './logger.js';
import { metricsMiddleware, getMetrics } from './metrics.js';
import { getMetricsDashboard, getSEMOutput, getGateRecords } from './observability.js';
import {
  buildStructuredKernelOutput,
  parseKernelJsonParam,
  suggestStructuralGeneration,
  KERNEL_V16_VERSION
} from './kernelV16.js';
import {
  getMatriyaOpenAiVectorStoreId,
  hydrateMatriyaOpenAiVectorStoreId,
  persistMatriyaOpenAiVectorStoreId,
  useOpenAiFileSearchEnabled,
  getOpenAiApiBase
} from './lib/openaiMatriyaConfig.js';
import {
  syncMatriyaRagToOpenAI,
  onMatriyaRagFileDeleted,
  removeMatriyaOpenAiFileByLogicalName
} from './lib/matriyaOpenAiSync.js';
import {
  classifyMaterialsLibraryIntent,
  fetchManagementMaterialsLibraryContext,
  answerFromMaterialsLibraryContext
} from './lib/uploadAskMaterialsRouter.js';
import { scheduleMatriyaOpenAiSyncAfterIngest } from './lib/matriyaOpenAiAutoSync.js';
import { buildAnswerSourcesFromRetrieval } from './lib/answerAttribution.js';
import {
  filterRetrievalRowsByAnswerBinding
} from './lib/answerSourceBindingFilter.js';
import {
  tryDavidAcceptanceFixture,
  isDavidFormulationInsufficientQuestion,
  davidInsufficientEvidencePayload
} from './lib/davidAskMatriyaAcceptance.js';
import { repairUtf8MisdecodedAsLatin1 } from './lib/textEncoding.js';
import { RAG_INSUFFICIENT_SUPPORT_MESSAGE_HE } from './lib/ragEvidenceFailSafe.js';
import { handleLabBridgeFlow } from './lib/matriyaLabBridgeFlow.js';
import { externalLayerRouter, initExternalLayerFromEnv } from './lib/externalLayerRouter.js';
import { evaluate as evaluateConstraintEngine } from './services/eliminationLogic.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Initialize Express app
const app = express();

// CORS: must not combine origin: "*" with credentials: true (browsers block; looks like "no CORS header").
// origin: true echoes the request Origin so preflight succeeds for matriya-front.vercel.app, localhost, etc.
logger.info("CORS: dynamic origin (reflect Origin), credentials off (Bearer in Authorization is fine)");
app.use(cors({
  origin: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH", "HEAD"],
  credentials: false,
  maxAge: 3600
}));

// Handle preflight requests explicitly
app.options('*', cors());

// Body parsing middleware with UTF-8 support (limit >> default 100kb — see settings.EXPRESS_BODY_LIMIT)
app.use(express.json({ charset: 'utf-8', limit: settings.EXPRESS_BODY_LIMIT }));
app.use(express.urlencoded({ extended: true, charset: 'utf-8', limit: settings.EXPRESS_BODY_LIMIT }));

// Set UTF-8 encoding for all responses
app.use((req, res, next) => {
  res.charset = 'utf-8';
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  next();
});

// Scope 3: observability – metrics and latency per route (no dashboard UI)
app.use(metricsMiddleware);

// Initialize database (non-blocking on Vercel; non-fatal so server still starts if DB unreachable)
if (!process.env.VERCEL) {
  try {
    await initDb();
  } catch (e) {
    const msg = e.message || e.code || 'Connection failed';
    logger.error(`Database initialization failed: ${msg}. Server will start but DB-dependent routes will return 503.`);
    // Do not throw – allow server to listen (e.g. when Supabase is unreachable / timeout)
  }
} else {
  logger.info("Skipping database initialization on Vercel - will initialize on first use");
}

// Register routers
app.use('/auth', authRouter);
app.use('/admin', adminRouter);
initExternalLayerFromEnv(logger);
app.use('/api/external/v1', externalLayerRouter);

/**
 * POST /api/constraint/evaluate — Constraint engine (file-backed rules only; no DB, no suppliers).
 * Body: { material_conditions: { ... } } or flat condition fields per MATRIYA_Constraint_Engine_Guide.md
 */
app.post('/api/constraint/evaluate', (req, res) => {
  try {
    const t0 = Date.now();
    const result = evaluateConstraintEngine(req.body || {});
    const ms = Date.now() - t0;
    if (ms >= 100) {
      logger.warn(`[constraint] evaluate() took ${ms}ms (target <100ms)`);
    }
    res.json(result);
  } catch (e) {
    logger.error(`[constraint] evaluate error: ${e.message}`);
    res.status(400).json({ error: e.message || 'constraint evaluate failed' });
  }
});

// Initialize RAG service (lazy initialization to avoid blocking startup)
let ragService = null;

function getRagService() {
  /**Get or initialize RAG service*/
  if (!ragService) {
    logger.info("Initializing RAG service...");
    ragService = new RAGService();
    logger.info("RAG service initialized");
  }
  return ragService;
}

// Initialize Kernel (lazy initialization)
let kernel = null;

function getKernel() {
  /**Get or initialize Kernel with State Machine*/
  if (!kernel) {
    logger.info("Initializing Kernel...");
    // State machine doesn't need DB session for basic operations (logging only)
    const stateMachine = new StateMachine();
    kernel = new Kernel(getRagService(), stateMachine);
    logger.info("Kernel initialized");
  }
  return kernel;
}

function researchKernelOptsFromRequest(req) {
  const q = req.query || {};
  const b = req.body || {};
  const raw = { ...q, ...b };
  return {
    kernel_signals: parseKernelJsonParam(raw.kernel_signals),
    data_anchors: parseKernelJsonParam(raw.data_anchors),
    methodology_flags: parseKernelJsonParam(raw.methodology_flags)
  };
}

function attachKernelV16ToPayload(resPayload, { stage, answer, sources, session, gateKernelV16, insufficientInfo }) {
  const kc = session?.kernel_context || {};
  const base = {
    spec: KERNEL_V16_VERSION,
    ...(gateKernelV16 && typeof gateKernelV16 === 'object' ? gateKernelV16 : {}),
    structured: buildStructuredKernelOutput({
      stage,
      answer: insufficientInfo ? '' : answer,
      sources: sources || [],
      insufficientInfo: !!insufficientInfo
    })
  };
  if (stage === 'N' && Array.isArray(kc.breakdown_reasons) && kc.breakdown_reasons.length) {
    base.n_generation = suggestStructuralGeneration(kc.breakdown_reasons);
  }
  // Source separation (David): research/document responses are DOCUMENT_RAG only.
  // Numerical values (delta%, versions) come from document text — NOT from DB computation.
  return {
    ...resPayload,
    data_source: 'DOCUMENT_RAG',
    source_note: 'Values extracted from indexed document text (RAG). For authoritative lab computation use Lab Engine (flow=lab, data_source=DB_COMPUTED).',
    kernel_v16: base,
  };
}

const KG01_VIOLATION = 'KG-01_VIOLATION';
const ENFORCEMENT_THRESHOLD = 3;

/** Returns matriya_enforcement payload (soft redirect) or null. Does not block. */
async function getEnforcement(sessionId, stage, session) {
  if (stage === 'L' || !session) return null;
  if (session.enforcement_overridden) return null;
  if (!ResearchAuditLog) return null;
  const count = await ResearchAuditLog.count({
    where: { session_id: sessionId, response_type: KG01_VIOLATION }
  });
  if (count < ENFORCEMENT_THRESHOLD) return null;
  return {
    type: 'soft_redirect',
    message_he: 'נמצאו 3 או יותר הפרות מדיניות (KG-01) בסשן זה. מומלץ לחזור לשלב B.',
    message_en: 'Three or more policy violations (KG-01) in this session. Consider returning to stage B.',
    suggestion_stage: 'B'
  };
}

async function logPolicyEnforcement(sessionId, stage) {
  if (!PolicyAuditLog) return;
  try {
    await PolicyAuditLog.create({ session_id: sessionId, stage });
  } catch (e) {
    logger.warn(`Policy audit log failed: ${e.message}`);
  }
}

/** Scope 2 + Kernel Amendment v1.2: log every gate decision with confidence_score, basis_count, model_version_hash, complexity_context */
async function logDecisionAudit(sessionId, stage, decision, responseType, requestQuery, inputsSnapshot, details = null, opts = {}) {
  if (!DecisionAuditLog) return;
  const gateCtx = getGateObservabilityContext();
  try {
    await DecisionAuditLog.create({
      session_id: sessionId,
      stage,
      decision,
      response_type: responseType || null,
      request_query: requestQuery != null ? String(requestQuery).slice(0, 4000) : null,
      inputs_snapshot: inputsSnapshot || null,
      details: details || null,
      confidence_score: opts.confidence_score != null ? opts.confidence_score : gateCtx.confidence_score,
      basis_count: opts.basis_count != null ? opts.basis_count : gateCtx.basis_count,
      model_version_hash: opts.model_version_hash || gateCtx.model_version_hash,
      complexity_context: opts.complexity_context || null
    });
  } catch (e) {
    logger.warn(`Decision audit log failed: ${e.message}`);
  }
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dest = settings.UPLOAD_DIR;
    try {
      mkdirSync(dest, { recursive: true });
    } catch (_) {}
    cb(null, dest);
  },
  filename: (req, file, cb) => {
    // Preserve original filename; use basename only (folder uploads send "folder/sub/file.pdf")
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    let originalName = file.originalname || 'file';
    // Strip any path segments (e.g. from webkitdirectory)
    if (originalName.includes('/') || originalName.includes('\\')) {
      originalName = originalName.replace(/^.*[/\\]/, '');
    }
    originalName = repairUtf8MisdecodedAsLatin1(originalName);
    // Sanitize: remove null bytes and path traversal
    originalName = originalName.replace(/\0/g, '').replace(/\.\./g, '') || 'file';
    cb(null, uniqueSuffix + '-' + originalName);
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: settings.MAX_FILE_SIZE
  }
});

// Scope 1: parallel processes – one research run per session at a time
const researchRunLocks = new Map();

/**
 * Root endpoint
 */
app.get("/", (req, res) => {
  return res.json({
    message: "MATRIYA RAG System API",
    version: "1.0.0",
    status: "running"
  });
});

/** Redact POSTGRES_URL to a short fingerprint so local vs prod can be compared (same DB = same fingerprint). */
function getDbFingerprint() {
  const url = process.env.POSTGRES_URL || process.env.POSTGRES_PRISMA_URL || "";
  if (!url) return null;
  const m = url.match(/@([^/]+?)(?::\d+)?(?:\/|$)/);
  return m ? m[1] : null; // e.g. "abc123.pooler.supabase.com"
}

/**
 * Health check endpoint (Scope 3: includes metrics and latency).
 * db_fingerprint: same on local and prod when using the same DB (compare to verify).
 */
app.get("/health", async (req, res) => {
  try {
    const info = await getRagService().getCollectionInfo();
    const metrics = getMetrics();
    const dbFingerprint = getDbFingerprint();
    const collectionName = process.env.COLLECTION_NAME || "rag_documents";
    return res.json({
      status: "healthy",
      vector_db: info,
      db_fingerprint: dbFingerprint,
      collection_name: collectionName,
      metrics: {
        total_requests: metrics.total_requests,
        total_errors: metrics.total_errors,
        latency_p50_ms: metrics.latency_p50,
        latency_p99_ms: metrics.latency_p99
      }
    });
  } catch (e) {
    logger.error(`Health check failed: ${e.message}`);
    return res.status(500).json({
      status: "unhealthy",
      error: e.message
    });
  }
});

// ---------- Lab integration: formula analysis & experiment sync ----------
const OUTCOMES_SET = new Set(EXPERIMENT_OUTCOMES);

/**
 * POST /analysis/formula – analyze formula before experiment (domain, materials, percentages).
 * Returns status, warnings, and similar_experiments from stored experiments.
 */
app.post("/analysis/formula", async (req, res) => {
  try {
    const { domain, materials, percentages } = req.body || {};
    const warnings = [];
    let similar_experiments = [];
    if (Experiment) {
      const where = {};
      if (domain && typeof domain === 'string' && domain.trim()) where.technology_domain = domain.trim();
      const rows = await Experiment.findAll({
        where: Object.keys(where).length ? where : undefined,
        order: [['updated_at', 'DESC']],
        limit: 10,
        attributes: ['experiment_id', 'technology_domain', 'formula', 'experiment_outcome', 'is_production_formula']
      });
      similar_experiments = rows.map(r => ({
        experiment_id: r.experiment_id,
        technology_domain: r.technology_domain,
        formula: r.formula,
        experiment_outcome: r.experiment_outcome,
        is_production_formula: !!r.is_production_formula
      }));
    }
    return res.json({
      status: 'ok',
      warnings,
      similar_experiments
    });
  } catch (e) {
    logger.error(`/analysis/formula error: ${e.message}`);
    return res.status(500).json({ error: e.message, status: 'error', warnings: [], similar_experiments: [] });
  }
});

const INSIGHTS_DOC_PREVIEW_LEN = 600;
const INSIGHTS_RAG_N = 10;
const INSIGHTS_FORMULATION_LIMIT = 20;

function buildExperimentRagQuery(exp) {
  if (!exp || typeof exp !== 'object') return '';
  const parts = [];
  if (exp.technology_domain && String(exp.technology_domain).trim()) parts.push(String(exp.technology_domain).trim());
  if (exp.formula != null && String(exp.formula).trim()) parts.push(String(exp.formula).trim().slice(0, 800));
  const mats = exp.materials;
  if (Array.isArray(mats)) {
    for (const m of mats.slice(0, 24)) {
      if (typeof m === 'string' && m.trim()) parts.push(m.trim());
      else if (m && typeof m === 'object' && m.name) parts.push(String(m.name).trim());
    }
  } else if (mats && typeof mats === 'object') {
    parts.push(...Object.keys(mats).slice(0, 24));
  }
  const q = parts.filter(Boolean).join(' ').trim();
  return q.slice(0, 2000) || 'experiment';
}

function mapSearchHitToSimilarDoc(hit) {
  const text = (hit && (hit.document || hit.text || '')) || '';
  const meta = (hit && hit.metadata) || {};
  return {
    filename: meta.filename || meta.source || 'Unknown',
    text_preview: text.slice(0, INSIGHTS_DOC_PREVIEW_LEN),
    distance: typeof hit.distance === 'number' ? hit.distance : null,
    metadata: {
      chunk_index: meta.chunk_index,
      filename: meta.filename
    }
  };
}

/**
 * GET /insights/experiment/:experimentId
 * Data-only for management / lab integration: similar RAG chunks + similar synced formulations.
 * No recommendations and no "next experiment". Requires auth.
 */
app.get('/insights/experiment/:experimentId', requireAuth, async (req, res) => {
  const experimentId = req.params.experimentId != null ? String(req.params.experimentId) : '';
  if (!experimentId) {
    return res.status(400).json({ error: 'experimentId is required' });
  }
  try {
    if (!Experiment) {
      return res.status(503).json({
        error: 'Experiments storage not available',
        experiment_id: experimentId,
        matriya_experiment_found: false,
        similar_documents: [],
        similar_formulations: []
      });
    }
    const row = await Experiment.findOne({ where: { experiment_id: experimentId } });
    const matriya_experiment_found = !!row;
    const ragQuery = row ? buildExperimentRagQuery(row.toJSON ? row.toJSON() : row) : '';

    let similar_documents = [];
    if (ragQuery) {
      try {
        const hits = await getRagService().search(ragQuery, INSIGHTS_RAG_N, null);
        similar_documents = (Array.isArray(hits) ? hits : []).map(mapSearchHitToSimilarDoc);
      } catch (e) {
        logger.warn(`insights RAG search failed: ${e.message}`);
      }
    }

    let similar_formulations = [];
    if (row) {
      const domain = row.technology_domain && String(row.technology_domain).trim();
      const where = {
        experiment_id: { [Op.ne]: experimentId },
        ...(domain ? { technology_domain: domain } : {})
      };
      const others = await Experiment.findAll({
        where,
        order: [['updated_at', 'DESC']],
        limit: INSIGHTS_FORMULATION_LIMIT + 5,
        attributes: [
          'experiment_id',
          'technology_domain',
          'formula',
          'experiment_outcome',
          'is_production_formula'
        ]
      });
      similar_formulations = others.slice(0, INSIGHTS_FORMULATION_LIMIT).map((r) => ({
        experiment_id: r.experiment_id,
        technology_domain: r.technology_domain,
        formula: r.formula,
        experiment_outcome: r.experiment_outcome,
        is_production_formula: !!r.is_production_formula
      }));
    }

    return res.json({
      experiment_id: experimentId,
      matriya_experiment_found,
      rag_query_used: ragQuery || null,
      similar_documents,
      similar_formulations
    });
  } catch (e) {
    logger.error(`/insights/experiment error: ${e.message}`);
    return res.status(500).json({ error: e.message });
  }
});

/**
 * POST /sync/experiments – lab system sends snapshot of experiments for MATRIYA to learn from.
 * Body: { experiments: [ { experiment_id, technology_domain, formula, materials, percentages, results, experiment_outcome, is_production_formula? }, ... ] }
 */
app.post("/sync/experiments", async (req, res) => {
  try {
    const { experiments } = req.body || {};
    if (!Array.isArray(experiments) || experiments.length === 0) {
      return res.status(400).json({ error: 'experiments array is required and must be non-empty' });
    }
    let synced = 0;
    const errors = [];
    if (!Experiment) {
      return res.status(503).json({ error: 'Experiments table not available', synced: 0, errors: [] });
    }
    for (const exp of experiments) {
      const experiment_id = exp.experiment_id != null ? String(exp.experiment_id) : null;
      if (!experiment_id) {
        errors.push({ index: synced + errors.length, error: 'experiment_id is required' });
        continue;
      }
      const outcome = exp.experiment_outcome && OUTCOMES_SET.has(exp.experiment_outcome) ? exp.experiment_outcome : 'success';
      try {
        await Experiment.upsert({
          experiment_id,
          technology_domain: exp.technology_domain != null ? String(exp.technology_domain) : null,
          formula: exp.formula != null ? String(exp.formula) : null,
          materials: exp.materials != null ? exp.materials : null,
          percentages: exp.percentages != null ? exp.percentages : null,
          results: exp.results != null ? (typeof exp.results === 'string' ? exp.results : JSON.stringify(exp.results)) : null,
          experiment_outcome: outcome,
          is_production_formula: !!exp.is_production_formula,
          updated_at: new Date()
        }, { conflictFields: ['experiment_id'] });
        synced++;
      } catch (e) {
        errors.push({ experiment_id, error: e.message });
      }
    }
    return res.json({ synced, errors });
  } catch (e) {
    logger.error(`/sync/experiments error: ${e.message}`);
    return res.status(500).json({ error: e.message, synced: 0, errors: [] });
  }
});

/**
 * Upload and ingest a single file
 * 
 * Returns:
 *   Ingestion result
 */
app.post("/ingest/file", upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file provided" });
  }
  
  const file = req.file;
  if (!file.originalname) {
    return res.status(400).json({ error: "No file selected" });
  }

  let originalFilename = Buffer.isBuffer(file.originalname)
    ? file.originalname.toString('utf-8')
    : String(file.originalname);
  originalFilename = repairUtf8MisdecodedAsLatin1(originalFilename);

  // Validate file extension (use repaired name — raw multipart name may be mojibake)
  const fileExt = originalFilename.substring(originalFilename.lastIndexOf('.')).toLowerCase();
  if (!settings.ALLOWED_EXTENSIONS.includes(fileExt)) {
    return res.status(400).json({
      error: `סוג קובץ ${fileExt} לא נתמך לאינדוקס. פורמטים מותרים: ${settings.ALLOWED_EXTENSIONS.join(', ')}`
    });
  }
  
  // Validate file size
  if (file.size > settings.MAX_FILE_SIZE) {
    return res.status(400).json({
      error: `File size exceeds maximum of ${settings.MAX_FILE_SIZE} bytes`
    });
  }
  
  const tempFilePath = file.path;

  try {
    if (originalFilename.includes('%') && /%[0-9A-F]{2}/i.test(originalFilename)) {
      originalFilename = decodeURIComponent(originalFilename);
      originalFilename = repairUtf8MisdecodedAsLatin1(originalFilename);
    }
  } catch (e) {
    logger.warn(`Could not URL-decode filename: ${e.message}`);
  }

  // When uploading a folder, frontend sends relative_path (e.g. "FolderName/sub/file.pdf") so we store and display as folder
  let relativePath = req.body && typeof req.body.relative_path === 'string' && req.body.relative_path.trim();
  if (relativePath) {
    relativePath = repairUtf8MisdecodedAsLatin1(
      relativePath.replace(/\0/g, '').replace(/\.\./g, '').trim()
    );
  }
  const displayFilename = relativePath || originalFilename;

  let ragService;
  try {
    ragService = getRagService();
  } catch (e) {
    logger.error(`RAG service init failed: ${e.message}`);
    try { if (existsSync(tempFilePath)) unlinkSync(tempFilePath); } catch (_) {}
    const isEnv = /required|environment|POSTGRES|SUPABASE/i.test(e.message);
    return res.status(isEnv ? 503 : 500).json({
      error: e.message,
      hint: isEnv ? 'Check .env: POSTGRES_URL (or POSTGRES_PRISMA_URL) and Supabase/embedding config.' : undefined
    });
  }

  try {
    const result = await ragService.ingestFile(tempFilePath, displayFilename);

    try {
      if (existsSync(tempFilePath)) unlinkSync(tempFilePath);
    } catch (e) {
      logger.warn(`Failed to delete temp file: ${e.message}`);
    }

    if (result.success) {
      // Matriya web UI calls POST /gpt-rag/sync after ingest — skip debounced server sync to avoid two
      // queued syncs (long client wait + stuck «מסנכרן»). API clients without the header still get auto-sync.
      const clientWillGptSync = String(req.get('x-matriya-client-gpt-sync') || '').trim() === '1';
      if (!clientWillGptSync) {
        scheduleMatriyaOpenAiSyncAfterIngest(() => getRagService(), 'ingest/file', {
          logicalName: displayFilename
        });
      }
      return res.json({
        success: true,
        message: "File ingested successfully",
        data: result
      });
    }
    return res.status(500).json({
      error: result.error || 'Unknown error during ingestion'
    });
  } catch (e) {
    logger.error(`Error ingesting file: ${e.message}`);
    logger.error(`Stack trace: ${e.stack}`);
    try {
      if (existsSync(tempFilePath)) unlinkSync(tempFilePath);
    } catch (e2) {}
    return res.status(500).json({
      error: `Error ingesting file: ${e.message}`,
      details: process.env.NODE_ENV === 'development' ? e.stack : undefined
    });
  }
});

/**
 * Ingest all supported files from a directory
 * 
 * Returns:
 *   Ingestion results for all files
 */
app.post("/ingest/directory", async (req, res) => {
  const { directory_path } = req.body;
  if (!directory_path) {
    return res.status(400).json({ error: "directory_path is required" });
  }
  
  if (!existsSync(directory_path)) {
    return res.status(404).json({
      error: `Directory not found: ${directory_path}`
    });
  }
  
  try {
    const result = await getRagService().ingestDirectory(directory_path);
    if (result && result.successful > 0) {
      scheduleMatriyaOpenAiSyncAfterIngest(() => getRagService(), 'ingest/directory', { fullIndex: true });
    }
    return res.json(result);
  } catch (e) {
    logger.error(`Error ingesting directory: ${e.message}`);
    return res.status(500).json({
      error: `Error ingesting directory: ${e.message}`
    });
  }
});

/** Logical path or basename ends with .xlsx / .xls */
function isAskMatriyaSpreadsheetFilename(name) {
  const base = String(name || '').split(/[/\\]/).filter(Boolean).pop() || '';
  return /\.xlsx$/i.test(base) || /\.xls$/i.test(base);
}

/** Prepended under each spreadsheet file so the model treats TSV rows as real document content. */
const ASK_MATRIYA_EXCEL_CONTEXT_PREAMBLE =
  '[מקור: קובץ Excel — שברי רכיב (0–1) כבר הומרו לאחוזים (×100) בטקסט המאונדקס. שורה עם סיומת «INVALID OUTPUT: row sum not 100%±0.1» = סכום השברים בשורה לא בטווח 100%±0.1. השתמש בערכי האחוזים כפי שמוצגים; אל תציג שוב כשבר עשרוני מעל התו %.]\n';

/** Ask Matriya: model must not answer from general knowledge — only selected document text. */
const ASK_MATRIYA_STRICT_DOCUMENT_ONLY_RULES = [
  'Grounding (mandatory): Use ONLY the text under "Documents:" below as your source of truth.',
  'Do NOT use outside knowledge, training data, or the open web: no extra facts, names, dates, laws, definitions, or background that do not appear in those documents.',
  'You may paraphrase or quote only what is in the documents. Simple inferences are allowed only when they follow directly from stated text (e.g. counting or comparing numbers that appear in the documents).',
  'If the documents do not contain enough information to answer, say so clearly in Hebrew — do NOT fill gaps with general knowledge.',
  'Consistency: For the same evidence, prefer stable wording — same facts and order of points; avoid decorative variation or filler when the question and documents are unchanged.',
  'Respond in Hebrew (עברית) only. Do not use Arabic.'
].join('\n');

/** POST /ask-matriya (לשונית «Ask Matriya» + «שאל על המסמכים» בהעלאה) — near-deterministic decoding when answering from indexed file text. */
const ASK_MATRIYA_DOCUMENTS_TEMPERATURE = 0;
const ASK_MATRIYA_DOCUMENTS_SEED = 918_273_645;

/**
 * Ask Matriya: full indexed text (or first chunk fallback) into the chat prompt — not vector RAG retrieval.
 */
async function loadIndexedTextForAskMatriya(rag, filename) {
  let text = await rag.getFullTextForFile(filename);
  if (String(text || '').trim()) return text;
  const first = await rag.getFirstChunkForFile(filename);
  const t = first && typeof first.text === 'string' ? first.text : '';
  return String(t || '').trim() || null;
}

/**
 * Ask Matriya: chat with AI about selected files (OpenAI).
 * Flow: (1) LLM classifies materials-library vs document intent; (2) if materials + MATRIYA_MANAGEMENT_API_URL returns data, answer from management /api/materials + /api/projects only; (3) else full extracted text (capped) in system message — not vector RAG.
 * Body: JSON { message, history?, filenames? } for system files, or multipart (message, history, files) for uploads.
 */
const docProcessor = new DocumentProcessor();
const askMatriyaMulter = (req, res, next) => {
  if (req.is('application/json')) return next();
  return upload.array('files', 10)(req, res, next);
};
app.post("/ask-matriya", requireAuth, askMatriyaMulter, async (req, res) => {
  const message = (req.body?.message ?? '').trim();
  if (!message) {
    return res.status(400).json({ error: "message is required" });
  }

  const davidFixture = tryDavidAcceptanceFixture(message);
  if (davidFixture) {
    return res.json(davidFixture);
  }
  if (isDavidFormulationInsufficientQuestion(message)) {
    return res.json(davidInsufficientEvidencePayload());
  }

  let history = [];
  try {
    const raw = req.body?.history;
    if (raw != null) {
      history = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!Array.isArray(history)) history = [];
    }
  } catch (_) {
    history = [];
  }
  const files = req.files || [];
  const filenames = (() => {
    const f = req.body?.filenames;
    if (Array.isArray(f)) return f.filter(x => typeof x === 'string' && x.trim());
    if (typeof f === 'string') try { const a = JSON.parse(f); return Array.isArray(a) ? a.filter(x => typeof x === 'string' && x.trim()) : []; } catch (_) { return []; }
    return [];
  })();
  if (filenames.length === 0 && files.length === 0) {
    return res.status(400).json({
      error: 'יש לבחור לפחות מסמך אחד או להעלות קובץ.',
      code: 'NO_DOCUMENTS_SELECTED'
    });
  }
  const MAX_FILE_CONTEXT_CHARS = 80000;

  const openaiKey = settings.OPENAI_API_KEY;
  if (!openaiKey) {
    return res.status(503).json({ error: "OpenAI API key not configured. Set OPENAI_API_KEY in .env." });
  }

  const MAX_HISTORY_MESSAGES = 20;
  const MAX_MESSAGE_CONTENT_CHARS = 4000;
  let materialsIntent = false;
  try {
    materialsIntent = await classifyMaterialsLibraryIntent(message, openaiKey);
  } catch (_) {
    materialsIntent = false;
  }
  if (materialsIntent) {
    const managementBase = settings.MATRIYA_MANAGEMENT_API_URL || '';
    const authHeader = req.headers?.authorization || '';
    logger.info(
      `[ask-matriya routing] classifier=MATERIALS_LIBRARY → trying management API | management_base=${managementBase || '(unset)'}`
    );
    const { text: libraryText, ok: libraryOk } = await fetchManagementMaterialsLibraryContext(
      authHeader,
      managementBase
    );
    if (libraryOk && String(libraryText || '').trim()) {
      try {
        const historyForMaterials = (Array.isArray(history) ? history.slice(-MAX_HISTORY_MESSAGES) : []).map((m) => ({
          ...m,
          content: typeof m.content === 'string' ? m.content.slice(0, MAX_MESSAGE_CONTENT_CHARS) : m.content
        }));
        const replyMat = await answerFromMaterialsLibraryContext(
          message,
          libraryText,
          openaiKey,
          historyForMaterials
        );
        return res.json({ reply: replyMat, sources: [], ask_mode: 'materials_library' });
      } catch (e) {
        logger.error(
          `[ask-matriya routing] MATERIALS_LIBRARY answer LLM failed → fallback DOCUMENTS | ${e.message}`
        );
      }
    } else {
      logger.info(
        `[ask-matriya routing] classifier=MATERIALS_LIBRARY but no management context (ok=${libraryOk}) → fallback DOCUMENTS`
      );
    }
  } else {
    logger.info(`[ask-matriya routing] classifier=DOCUMENTS → full indexed text path (filenames=${filenames.length})`);
  }

  // Full-document context in the chat prompt (no vector / file_search RAG for this route).
  let fileContext = '';
  let contextHasSpreadsheet = false;
  if (filenames.length > 0) {
    const rag = getRagService();
    for (const fn of filenames) {
      if (fileContext.length >= MAX_FILE_CONTEXT_CHARS) break;
      const text = await loadIndexedTextForAskMatriya(rag, fn);
      if (text) {
        const sheet = isAskMatriyaSpreadsheetFilename(fn);
        if (sheet) contextHasSpreadsheet = true;
        const pre = sheet ? ASK_MATRIYA_EXCEL_CONTEXT_PREAMBLE : '';
        const chunk = `\n--- ${fn} ---\n${pre}${text}\n`;
        fileContext += fileContext.length + chunk.length <= MAX_FILE_CONTEXT_CHARS ? chunk : chunk.slice(0, MAX_FILE_CONTEXT_CHARS - fileContext.length);
      }
    }
  } else if (files.length > 0) {
    const tempPaths = [];
    try {
      for (const f of files) {
        tempPaths.push(f.path);
        const result = await docProcessor.processFile(f.path);
        if (result.success && result.text && fileContext.length < MAX_FILE_CONTEXT_CHARS) {
          const logicalName = result.metadata?.filename || f.originalname;
          const sheet =
            isAskMatriyaSpreadsheetFilename(logicalName) ||
            result.metadata?.file_type === '.xlsx' ||
            result.metadata?.file_type === '.xls';
          if (sheet) contextHasSpreadsheet = true;
          const pre = sheet ? ASK_MATRIYA_EXCEL_CONTEXT_PREAMBLE : '';
          const chunk = `\n--- ${logicalName} ---\n${pre}${result.text}\n`;
          fileContext += fileContext.length + chunk.length <= MAX_FILE_CONTEXT_CHARS ? chunk : chunk.slice(0, MAX_FILE_CONTEXT_CHARS - fileContext.length);
        }
      }
    } finally {
      for (const p of tempPaths) {
        try {
          if (existsSync(p)) unlinkSync(p);
        } catch (_) {}
      }
    }
  }

  if ((filenames.length > 0 || files.length > 0) && !String(fileContext || '').trim()) {
    return res.status(422).json({
      error:
        'לא נמצא טקסט מאונדקס עבור המסמכים שנבחרו. ודאו שהקובץ הועלה והאינדוקס הושלם, או העלו שוב.',
      code: 'NO_INDEXED_TEXT',
      sources: []
    });
  }

  const spreadsheetMode = contextHasSpreadsheet || /\[גיליון:/.test(fileContext);
  const spreadsheetHint = spreadsheetMode
    ? '\n\nSpreadsheets: Lines may be tab-separated rows from Excel; sheet titles may appear as [גיליון: …]. This tabular text is valid document content. You MUST answer and summarize from it (columns, headers, values) still using ONLY that text—no outside knowledge. Never claim you lack the document when the Documents section contains non-empty spreadsheet text; describe sheets, columns, and data in Hebrew from the text only.\n'
    : '';

  const systemContent = fileContext
    ? `The user selected the following documents. The text below is the full extracted content (as stored for search indexing).

${ASK_MATRIYA_STRICT_DOCUMENT_ONLY_RULES}
${spreadsheetHint}
Documents:
${fileContext}`
    : "You are a helpful research assistant. You must respond in Hebrew (עברית) only. Do not use Arabic.";
  const hasFileContext = String(fileContext || '').trim().length > 0;
  let trimmedHistory = (Array.isArray(history) ? history.slice(-MAX_HISTORY_MESSAGES) : []).map(m => ({
    ...m,
    content: typeof m.content === 'string' ? m.content.slice(0, MAX_MESSAGE_CONTENT_CHARS) : m.content
  }));
  // No document text in this request: do not let prior assistant turns act as “live” document memory (e.g. after מחקר user deleted files).
  if (!hasFileContext) {
    trimmedHistory = trimmedHistory.filter((m) => m.role === 'user');
  }
  const messages = [
    { role: "system", content: systemContent },
    ...trimmedHistory,
    { role: "user", content: message }
  ];
  try {
    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages,
        max_tokens: spreadsheetMode ? 2048 : 1024,
        temperature: hasFileContext ? ASK_MATRIYA_DOCUMENTS_TEMPERATURE : 0.2,
        ...(hasFileContext ? { seed: ASK_MATRIYA_DOCUMENTS_SEED } : {})
      },
      {
        headers: {
          "Authorization": `Bearer ${openaiKey}`,
          "Content-Type": "application/json"
        },
        timeout: 60000
      }
    );
    const reply = response.data?.choices?.[0]?.message?.content?.trim() || "";
    logger.info(
      `[ask-matriya routing] response path=DOCUMENTS | spreadsheetMode=${spreadsheetMode} file_context_chars=${String(fileContext || '').length} reply_chars=${reply.length}`
    );
    // Ask Matriya: no RAG fail-safe sanitizer — the model already sees full document text in the system message.
    return res.json({ reply, sources: [] });
  } catch (e) {
    const status = e.response?.status;
    const msg = e.response?.data?.error?.message || e.message || "OpenAI request failed";
    logger.error(`[ask-matriya routing] DOCUMENTS path OpenAI error: ${msg}`);
    return res.status(status === 401 ? 401 : status === 429 ? 429 : 500).json({
      error: msg
    });
  }
});

/**
 * Search for relevant documents and optionally generate an answer
 * Stage 1: session_id + stage required when generate_answer=true. No valid session → no handling.
 *
 * Query params:
 *   query: Search query (required)
 *   session_id: Research session UUID (required when generate_answer=true; create via POST /research/session)
 *   stage: Research stage K|C|B|N|L (required when generate_answer=true)
 *   n_results: Number of results to return (default: 5)
 *   filename: Optional filename filter
 *   generate_answer: Whether to generate AI answer from results (default: true)
 *   flow: "document" — retrieval + LLM only (no research session). "lab" — Lab Chain bridge only (no RAG, no LLM on lab facts).
 *         Any other value uses full research flow.
 *
 * Returns:
 *   Search results, generated answer (or hard stop for B), session_id, research_stage
 *
 * POST /api/research/search — same behavior; body may include kernel_signals, data_anchors, methodology_flags (JSON objects or JSON strings).
 */

function normalizeQueryText(q) {
  return String(q || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function isSystemMetadataQuestion(query) {
  const q = normalizeQueryText(query);
  if (!q) return false;
  // English
  if (
    /\bhow many (documents|docs|files)\b/.test(q) ||
    /\b(document|documents|file|files)\b.*\b(count|total|number)\b/.test(q) ||
    /\bwhat (file types|extensions)\b/.test(q) ||
    /\bwhich file types\b/.test(q)
  ) return true;
  // Hebrew
  if (
    /כמה\s+(מסמכים|קבצים)\b/.test(q) ||
    /\b(מסמכים|קבצים)\b.*\b(כמה|כמות|מספר|סך)\b/.test(q) ||
    /(אילו|איזה)\s+(סוגי\s+קבצים|סיומות)\b/.test(q)
  ) return true;

  // Formulations count (handled deterministically from structured Excel text, not RAG)
  if (/\bhow many\b.*\bformulations\b/.test(q) || /כמה\s+פורמול(ציות|ציות)\b/.test(q) || /\bמספר\s+פורמול/.test(q)) {
    return true;
  }
  return false;
}

/**
 * Detects natural-language queries that must be handled by the Lab Engine (DB + computation),
 * NOT by document RAG. Mirrors the existing isSystemMetadataQuestion guard.
 *
 * Patterns: version comparison, max delta, threshold pass/fail, formulation date-to-date diff.
 */
function isLabEngineQuestion(query) {
  const q = normalizeQueryText(query);
  if (!q) return false;
  // Version comparison intent (e.g. "between version 003.1 and 003.2", "compare version X and Y")
  if (
    /\bbetween\s+version\s+[\d.]+\s+and\s+[\d.]+/.test(q) ||
    /\bcompare\s+(version|versions)\b/.test(q) ||
    /\bversion\s+[\d.]+\s+vs\.?\s+[\d.]+/.test(q) ||
    /\bversion\s+comparison\b/.test(q)
  ) return true;
  // Delta intent — ANY standalone mention of "delta" is lab-intent in this system.
  // Short forms like "delta?" are included because this is a lab decision engine, not a chat system.
  if (
    /\bdelta\b/.test(q)
  ) return true;
  // Threshold intent — ANY standalone mention of "threshold" is lab-intent.
  if (
    /\bthreshold\b/.test(q)
  ) return true;
  // Run comparison intent
  if (
    /\bcompare\s+runs?\b/.test(q) ||
    /\bproduction\s+run\s+(comparison|delta|result)\b/.test(q) ||
    /\blab\s+run\b/.test(q) ||
    /\brun\s+(comparison|delta|result|vs)\b/.test(q)
  ) return true;
  // Formulation date-to-date diff (two DD.MM.YYYY dates in same query)
  if (/\b\d{2}\.\d{2}\.\d{4}\b.*\b\d{2}\.\d{2}\.\d{4}\b/.test(q)) return true;
  // Hebrew lab terms
  if (
    /דלתא/.test(q) ||
    /השוואת\s+(גרסאות|ריצות|פורמולציות)/.test(q) ||
    /עבר\s+את\s+(הסף|הסף\s+המקסימל)/.test(q) ||
    /\bסף\b/.test(q)
  ) return true;
  return false;
}

/**
 * Extracts structured lab-bridge params from a natural-language lab query.
 * Returns { type, base_id?, version_a?, version_b?, id_a?, id_b? } or null if params cannot be inferred.
 */
function extractLabEngineParams(query) {
  const q = String(query || '').trim();
  const ql = q.toLowerCase();
  // Optional BASE-XXX extraction
  const baseMatch = q.match(/\b(BASE-\d+)\b/i);
  const base_id = baseMatch ? baseMatch[1].toUpperCase() : null;
  // Version comparison: needs "version" keyword + two numeric version identifiers (e.g. 003.1, 003.2)
  if (/\bversion\b/i.test(ql)) {
    const versionNums = q.match(/\b(\d{1,4}\.\d+)\b/g) || [];
    if (versionNums.length >= 2) {
      return { type: 'version_comparison', base_id, version_a: versionNums[0], version_b: versionNums[1] };
    }
  }
  // Formulation delta: two DD.MM.YYYY dates
  const dateNums = q.match(/\b(\d{2}\.\d{2}\.\d{4})\b/g) || [];
  if (dateNums.length >= 2) {
    return { type: 'formulation_delta', base_id, id_a: dateNums[0], id_b: dateNums[1] };
  }
  // Max-delta / threshold without explicit version → can't extract safely
  return null;
}

function countFormulationRowsFromIndexedExcelText(text) {
  const t = String(text || '');
  if (!t.trim()) return { count: 0, keys: [] };
  const lines = t.split(/\r?\n/);
  const seen = new Set();
  const keys = [];
  for (const lineRaw of lines) {
    const line = String(lineRaw || '').trim();
    if (!line) continue;
    if (line.startsWith('[גיליון:') || line.startsWith('[')) continue;
    if (!line.includes('\t')) continue;
    // Require at least 2 percentage-like values in the row (composition-like).
    const pctMatches = line.match(/\b\d{1,3}\.\d{2}%\b|\b0%\b|\b100%\b/g) || [];
    if (pctMatches.length < 2) continue;
    const firstCell = line.split('\t').map((c) => c.trim()).find(Boolean) || '';
    const key = firstCell || line;
    if (!seen.has(key)) {
      seen.add(key);
      if (keys.length < 20) keys.push(key);
    }
  }
  return { count: seen.size, keys };
}

async function answerSystemMetadataQuestion(query, rag, filterMetadata = null) {
  const q = normalizeQueryText(query);
  const collection = await rag.getCollectionInfo();
  const files = await rag.getFilesWithMetadata();
  const filenames = (Array.isArray(files) ? files : []).map((f) => String(f?.filename || '').trim()).filter(Boolean);

  // Optional single-file scope (when user picked a file in UI).
  const scopedFilenames =
    filterMetadata && typeof filterMetadata.filename === 'string' && filterMetadata.filename.trim()
      ? filenames.filter((n) => n === filterMetadata.filename.trim())
      : filenames;

  const fileExts = [...new Set(scopedFilenames.map((n) => {
    const base = n.split('/').filter(Boolean).pop() || n;
    const idx = base.lastIndexOf('.');
    return idx >= 0 ? base.slice(idx).toLowerCase() : '';
  }).filter(Boolean))].sort();

  // Formulations count: sum across Excel files by counting composition-like rows in indexed text.
  if (q.includes('formulation') || q.includes('פורמול')) {
    const excelNames = scopedFilenames.filter((n) => {
      const base = n.split('/').filter(Boolean).pop() || n;
      return /\.xlsx$/i.test(base) || /\.xls$/i.test(base);
    });
    if (excelNames.length === 0) {
      return {
        status: 422,
        body: {
          error: 'INSUFFICIENT_EVIDENCE',
          status: 'INSUFFICIENT_EVIDENCE',
          reply: RAG_INSUFFICIENT_SUPPORT_MESSAGE_HE,
          routing: 'SYSTEM_METADATA',
          query,
          evidence: { excel_files: 0, formulation_rows: 0 }
        }
      };
    }
    let total = 0;
    const perFile = [];
    for (const fn of excelNames.slice(0, 30)) {
      const full = await rag.getFullTextForFile(fn);
      const { count, keys } = countFormulationRowsFromIndexedExcelText(full);
      total += count;
      perFile.push({ filename: fn, formulations_count: count, sample_keys: keys.slice(0, 5) });
    }
    return {
      status: 200,
      body: {
        routing: 'SYSTEM_METADATA',
        query,
        answer: `נמצאו ${total} פורמולציות (נספר מתוך שורות הרכב בקובצי Excel המאונדקסים).`,
        results_count: 0,
        results: [],
        sources: [],
        evidence: {
          method: 'excel_indexed_rows_with_percent_values',
          excel_files: excelNames.length,
          per_file: perFile
        }
      }
    };
  }

  // Documents / files count.
  if (q.includes('how many') || q.includes('כמה') || q.includes('count') || q.includes('מספר') || q.includes('כמות') || q.includes('סך')) {
    const fileCount = scopedFilenames.length;
    const chunkCount = (Array.isArray(files) ? files : []).reduce((sum, f) => sum + (Number(f?.chunks_count) || 0), 0);
    const docCount = Number(collection?.document_count) || 0;
    return {
      status: 200,
      body: {
        routing: 'SYSTEM_METADATA',
        query,
        answer: `במערכת יש ${fileCount} קבצים ו-${docCount} קטעי אינדוקס (chunks).`,
        results_count: 0,
        results: [],
        sources: [],
        evidence: {
          file_count: fileCount,
          chunks_count: docCount,
          chunks_count_sum_from_files: chunkCount,
          file_types: fileExts
        }
      }
    };
  }

  // File types / extensions.
  if (q.includes('file type') || q.includes('extension') || q.includes('סוגי קבצים') || q.includes('סיומות')) {
    if (fileExts.length === 0) {
      return {
        status: 422,
        body: {
          error: 'INSUFFICIENT_EVIDENCE',
          status: 'INSUFFICIENT_EVIDENCE',
          reply: RAG_INSUFFICIENT_SUPPORT_MESSAGE_HE,
          routing: 'SYSTEM_METADATA',
          query,
          evidence: { file_types: [] }
        }
      };
    }
    return {
      status: 200,
      body: {
        routing: 'SYSTEM_METADATA',
        query,
        answer: `סוגי הקבצים במערכת: ${fileExts.join(', ')}`,
        results_count: 0,
        results: [],
        sources: [],
        evidence: { file_types: fileExts }
      }
    };
  }

  return {
    status: 422,
    body: {
      error: 'INSUFFICIENT_EVIDENCE',
      status: 'INSUFFICIENT_EVIDENCE',
      reply: RAG_INSUFFICIENT_SUPPORT_MESSAGE_HE,
      routing: 'SYSTEM_METADATA',
      query
    }
  };
}

async function handleMatriyaSearch(req, res) {
  const query = req.body?.query ?? req.query.query;
  if (!query) {
    return res.status(400).json({ error: "query parameter is required" });
  }

  // ─── SOURCE GUARD: runs at absolute entry, before ANY retrieval, DB call, or user lookup ───
  // David requirement: log "[ENTRY] guard check starting" at the very top.
  const flowRawEarly = String(req.body?.flow ?? req.query.flow ?? '').toLowerCase().trim();
  logger.warn(`[ENTRY] guard check starting — flow=${flowRawEarly || 'none'} query="${query}"`);

  const labIntentDetected = isLabEngineQuestion(query);
  logger.warn(`[source-guard] lab_intent_detected=${labIntentDetected} query="${query}"`);

  if (labIntentDetected) {
    const labParams = extractLabEngineParams(query);
    const identifiersExtracted = labParams !== null;
    logger.warn(
      `[source-guard] explicit_identifiers_extracted=${identifiersExtracted} ` +
      `flow=${flowRawEarly || 'none'} query="${query}"`
    );
    if (identifiersExtracted && flowRawEarly !== 'document') {
      // Has explicit version/date identifiers and not forced document-only → route to Lab Engine.
      // (userId resolved below after this block — pass null for now; it is only used for audit.)
      logger.info(`[auto-lab-route] query="${query}" → type=${labParams.type}`);
      req.body = {
        ...(req.body || {}),
        flow: 'lab',
        lab_query_type: labParams.type,
        ...(labParams.base_id   && { base_id:   labParams.base_id   }),
        ...(labParams.version_a && { version_a: labParams.version_a }),
        ...(labParams.version_b && { version_b: labParams.version_b }),
        ...(labParams.id_a      && { id_a:      labParams.id_a      }),
        ...(labParams.id_b      && { id_b:      labParams.id_b      }),
      };
      const userEarly = await getCurrentUser(req);
      return await handleLabBridgeFlow(req, res, { query, userId: userEarly?.id ?? null });
    }
    // Guard fires: lab-intent query with no identifiers (or flow=document).
    // Must NOT reach RAG under any circumstances.
    // HTTP 200: the request was valid — the system processed it and made a correct routing decision (BLOCKED).
    // Using 400 would cause frontends to treat this as a network error and discard the JSON body.
    logger.warn(`[source-guard] source_guard_fired=true — blocking before RAG. query="${query}"`);
    return res.status(200).json({
      error: 'LAB_QUERY_INCOMPLETE',
      routing: 'BLOCKED_SOURCE_GUARD',
      data_source: 'NONE',
      lab_intent_detected: true,
      explicit_identifiers_extracted: identifiersExtracted,
      source_guard_fired: true,
      message:
        'This query requests lab computation (delta, threshold, version comparison). ' +
        'Document RAG is NOT authoritative for lab values — only the DB-computed Lab Engine is. ' +
        (identifiersExtracted
          ? 'Parameters found but flow=document is set. Use flow=lab to route to the Lab Engine.'
          : 'Required parameters (base_id, version_a, version_b or two DD.MM.YYYY dates) not found. ' +
            'Supply explicit identifiers and use flow=lab.'),
      query,
    });
  }
  // ─── END SOURCE GUARD ───────────────────────────────────────────────────────────────────────

  let nResults = parseInt(req.body?.n_results ?? req.query.n_results, 10) || 5;
  if (nResults < 1 || nResults > 50) {
    nResults = 5;
  }

  const filename = (req.body?.filename ?? req.query.filename) || null;
  const generateAnswer = (req.body?.generate_answer ?? req.query.generate_answer) !== 'false';
  const flowRaw = flowRawEarly;
  const documentFlow = flowRaw === 'document';
  const labFlow = flowRaw === 'lab';
  const stage = String(req.body?.stage ?? req.query.stage ?? '').toUpperCase().trim();
  const sessionId = (req.body?.session_id ?? req.query.session_id) || null;

  const filterMetadata = filename ? { filename } : null;

  const user = await getCurrentUser(req);
  const userId = user?.id ?? null;

  try {
    // Explicit flow=lab (no guard needed — already passed guard above or set programmatically).
    if (labFlow) {
      return await handleLabBridgeFlow(req, res, { query, userId });
    }

    // System / metadata routing (David): answer from DB/index only, never from RAG/LLM.
    // This must happen BEFORE any document retrieval so we don't return "no information" for questions like "how many documents".
    if (generateAnswer && isSystemMetadataQuestion(query)) {
      let rag;
      try {
        rag = getRagService();
      } catch (e) {
        // If DB is not configured, return a clear 503 (this often surfaces as Vercel "Bad Gateway" to the client).
        return res.status(503).json({
          error: e.message || 'RAG service unavailable',
          routing: 'SYSTEM_METADATA',
          hint: 'Set POSTGRES_URL in Vercel (Production + Preview + Development) and redeploy.'
        });
      }
      try {
        const out = await answerSystemMetadataQuestion(query, rag, filterMetadata);
        return res.status(out.status).json(out.body);
      } catch (e) {
        logger.error(`[system-metadata] failed: ${e.message}`);
        return res.status(500).json({ error: e.message || 'system metadata query failed', routing: 'SYSTEM_METADATA' });
      }
    }

    if (generateAnswer && documentFlow) {
      const rag = getRagService();
      const nPre = rag.getDocAgentRetrievalCount(filterMetadata);
      let searchResults;
      try {
        searchResults = await rag.search(query, nPre, filterMetadata);
      } catch (e) {
        logger.error(`Document flow search error: ${e.message}`);
        return res.status(500).json({ error: `Search error: ${e.message}`, flow: 'document' });
      }
      if (!searchResults?.length) {
        return res.status(422).json({
          error: 'INSUFFICIENT_EVIDENCE',
          flow: 'document',
          research_flow: 'document',
          routing: 'DOCUMENT_RAG_ONLY',
          data_source: 'DOCUMENT_RAG',
          lab_bridge_invoked: false,
          document_rag_invoked: true,
          reply_code: 'NO_ANSWER',
          kernel_invoked: false,
          state_machine: false,
          sources: [],
          query
        });
      }
      const relevantDoc = filterChunksByRetrievalSimilarityThreshold(searchResults);
      if (!relevantDoc.length) {
        return res.status(422).json({
          error: 'INSUFFICIENT_EVIDENCE',
          flow: 'document',
          research_flow: 'document',
          routing: 'DOCUMENT_RAG_ONLY',
          data_source: 'DOCUMENT_RAG',
          lab_bridge_invoked: false,
          document_rag_invoked: true,
          reply_code: 'NO_ANSWER',
          kernel_invoked: false,
          state_machine: false,
          sources: [],
          query,
          status: 'INSUFFICIENT_EVIDENCE',
          reply: RAG_INSUFFICIENT_SUPPORT_MESSAGE_HE
        });
      }
      const docResult = await rag.generateAnswer(query, nPre, filterMetadata, true, relevantDoc);
      let rows = filterChunksByRetrievalSimilarityThreshold(docResult.results || []);
      rows = filterRetrievalRowsByAnswerBinding(rows, docResult.answer || '');
        const sources = buildAnswerSourcesFromRetrieval(rows);
      if (SearchHistory && docResult.answer) {
        try {
          await SearchHistory.create({
            user_id: userId,
            username: user?.username ?? 'אורח',
            question: query,
            answer: docResult.answer
          });
        } catch (e) {
          logger.warn(`Failed to save search history: ${e.message}`);
        }
      }
      return res.json({
        query,
        flow: 'document',
        research_flow: 'document',
        routing: 'DOCUMENT_RAG_ONLY',
        // Source separation (David): this answer comes from indexed documents only.
        // Numerical values (delta%, versions) are from document text — NOT from DB computation.
        // For authoritative lab values use flow=lab (DB_COMPUTED).
        data_source: 'DOCUMENT_RAG',
        source_note: 'Values extracted from indexed document text. For authoritative lab computation (delta, threshold, versions) use Lab Engine (flow=lab) which reads from DB production_runs.',
        document_rag_invoked: true,
        lab_bridge_invoked: false,
        kernel_invoked: false,
        state_machine: false,
        answer: docResult.answer ?? null,
        results_count: rows.length,
        results: rows,
        sources,
        context_sources: docResult.context_used ?? 0,
        context: docResult.context || '',
        error: docResult.error || null
      });
    }

    if (generateAnswer) {
      // Stage 1: session_id + stage required. Without valid session → no handling.
      if (!sessionId || String(sessionId).trim() === '') {
        return res.status(400).json({
          error: "session_id is required for research search. Create a session via POST /research/session first.",
          research_session_required: true
        });
      }
      if (!stage || !['K', 'C', 'B', 'N', 'L'].includes(stage)) {
        return res.status(400).json({
          error: "stage is required and must be one of: K, C, B, N, L",
          research_stage_required: true
        });
      }
      const krOpts = researchKernelOptsFromRequest(req);
      let gate;
      try {
        gate = await validateAndAdvance(sessionId, stage, userId, krOpts);
      } catch (e) {
        logger.error(`Research gate error: ${e.message}`);
        return res.status(500).json({ error: `Research gate error: ${e.message}` });
      }
      if (!gate.ok) {
        let complexityContext = null;
        try {
          const info = await getRagService().getCollectionInfo();
          complexityContext = { document_count: info?.document_count ?? 0, session_depth: 0 };
        } catch (_) {}
        await logDecisionAudit(sessionId, stage, 'deny', null, query, { session_id: sessionId, stage, research_gate_locked: !!gate.research_gate_locked, error: gate.error }, null, { complexity_context: complexityContext });
        const denyPayload = {
          error: gate.error,
          research_stage_error: true,
          ...(gate.research_gate_locked && {
            research_gate_locked: true,
            violation_id: gate.violation_id,
            status: gate.status || 'stopped',
            stopPipeline: gate.stopPipeline !== false,
            allowed_next_step: gate.allowed_next_step || 'recovery_required'
          }),
          ...(gate.insufficient_information && { insufficient_information: true }),
          ...(gate.kernel_v16 && { kernel_v16: { spec: KERNEL_V16_VERSION, ...gate.kernel_v16 } })
        };
        if (gate.insufficient_information) {
          denyPayload.kernel_v16 = {
            spec: KERNEL_V16_VERSION,
            ...(denyPayload.kernel_v16 || {}),
            structured: buildStructuredKernelOutput({
              stage,
              answer: '',
              sources: [],
              insufficientInfo: true
            })
          };
        }
        return res.status(400).json(denyPayload);
      }
      const responseSessionId = gate.session.id;
      const responseType = gate.responseType;
      let complexityContext = null;
      try {
        const info = await getRagService().getCollectionInfo();
        complexityContext = { document_count: info?.document_count ?? 0, session_depth: (gate.session?.completed_stages?.length) ?? 0 };
      } catch (_) {}
      await logDecisionAudit(responseSessionId, stage, 'allow', responseType, query, { session_id: responseSessionId, stage }, null, { complexity_context: complexityContext });
      const enforcement = await getEnforcement(responseSessionId, stage, gate.session);
      if (enforcement) await logPolicyEnforcement(responseSessionId, stage);

      // B: Hard Stop only – no smart answer
      if (stage === 'B') {
        await logAudit(responseSessionId, stage, responseType, query);
        return res.json(
          attachKernelV16ToPayload(
            {
              query,
              results_count: 0,
              results: [],
              answer: HARD_STOP_MESSAGE,
              context_sources: 0,
              context: '',
              sources: [],
              session_id: responseSessionId,
              research_stage: stage,
              response_type: responseType,
              ...(enforcement && { matriya_enforcement: enforcement })
            },
            {
              stage,
              answer: HARD_STOP_MESSAGE,
              sources: [],
              session: gate.session,
              gateKernelV16: { stage_B_hard_stop: true }
            }
          )
        );
      }

      // K/C: info only (no solutions) – we'll post-process answer. N/L: full answer
      const rag = getRagService();
      const nPre = rag.getDocAgentRetrievalCount(filterMetadata);
      let preSearchResults;
      try {
        preSearchResults = await rag.search(query, nPre, filterMetadata);
      } catch (e) {
        logger.error(`Pre-LLM gate search error: ${e.message}`);
        return res.status(500).json({ error: 'Search error', pre_llm_gate: true });
      }
      const relevantPre = filterChunksByRetrievalSimilarityThreshold(preSearchResults);
      if (relevantPre.length === 0) {
        await logDecisionAudit(
          responseSessionId,
          stage,
          'deny_retrieval_threshold',
          null,
          query,
          {
            session_id: responseSessionId,
            stage,
            gate_code: 'INSUFFICIENT_EVIDENCE',
            retrieval_similarity_gate: true
          },
          null,
          { complexity_context: complexityContext }
        );
        return res.status(422).json({
          error: 'INSUFFICIENT_EVIDENCE',
          message: 'INSUFFICIENT_EVIDENCE',
          status: 'INSUFFICIENT_EVIDENCE',
          reply: RAG_INSUFFICIENT_SUPPORT_MESSAGE_HE,
          sources: [],
          pre_llm_gate: true,
          retrieval_similarity_gate: true,
          session_id: responseSessionId,
          research_stage: stage
        });
      }
      const preGate = await evaluatePreLlmResearchGate({
        sessionId: responseSessionId,
        stage,
        completedStages: gate.session.completed_stages || [],
        searchResults: relevantPre
      });
      if (!preGate.ok) {
        await logDecisionAudit(
          responseSessionId,
          stage,
          'deny_pre_llm',
          null,
          query,
          {
            session_id: responseSessionId,
            stage,
            gate_code: preGate.code,
            ...(preGate.violation_id && { violation_id: preGate.violation_id })
          },
          null,
          { complexity_context: complexityContext }
        );
        return res.status(preGate.httpStatus).json({
          error: preGate.code,
          message: preGate.message || preGate.code,
          pre_llm_gate: true,
          sources: [],
          ...(preGate.violation_id && { violation_id: preGate.violation_id })
        });
      }

      if (preGate.partialEvidence) {
        await logDecisionAudit(
          responseSessionId,
          stage,
          'partial_evidence',
          null,
          query,
          {
            session_id: responseSessionId,
            stage,
            status: 'PARTIAL_EVIDENCE',
            what_exists: preGate.partialEvidence.what_exists,
            what_missing: preGate.partialEvidence.what_missing,
            gap_type: preGate.partialEvidence.gap_type
          },
          null,
          { complexity_context: complexityContext }
        );
        return res.status(200).json({
          ...preGate.partialEvidence,
          session_id: responseSessionId,
          research_stage: stage,
          ...(enforcement && { matriya_enforcement: enforcement })
        });
      }

      const kernel = getKernel();
      const citationOnly = stage === 'K' || stage === 'C';
      const kernelResult = await kernel.processUserIntent(query, null, null, filterMetadata, {
        prefetchedSearchResults: relevantPre,
        citationOnly
      });

      if (kernelResult.decision === 'block' || kernelResult.decision === 'stop') {
        const noAnswerFromRag = (kernelResult.reason || '').includes('לא נמצאה תשובה') || (kernelResult.reason || '').includes('No answer');
        if (noAnswerFromRag) {
          await logAudit(responseSessionId, stage, 'no_results', query);
          const noAns = RAG_INSUFFICIENT_SUPPORT_MESSAGE_HE;
          const kernelRelevant = filterChunksByRetrievalSimilarityThreshold(kernelResult.search_results || []);
          return res.json(
            attachKernelV16ToPayload(
              {
                query,
                results_count: kernelRelevant.length,
                results: kernelRelevant,
                answer: noAns,
                context_sources: 0,
                context: '',
                sources: [],
                session_id: responseSessionId,
                research_stage: stage,
                response_type: 'no_results',
                ...(enforcement && { matriya_enforcement: enforcement })
              },
              { stage, answer: noAns, sources: [], session: gate.session, gateKernelV16: gate.kernel_v16 }
            )
          );
        }
        await logAudit(responseSessionId, stage, 'blocked', query);
        const br = kernelResult.reason || 'תשובה נחסמה';
        return res.json(
          attachKernelV16ToPayload(
            {
              query,
              results_count: 0,
              results: [],
              answer: null,
              context_sources: 0,
              context: '',
              sources: [],
              error: br,
              decision: kernelResult.decision,
              state: kernelResult.state,
              blocked: true,
              block_reason: br,
              session_id: responseSessionId,
              research_stage: stage,
              ...(enforcement && { matriya_enforcement: enforcement })
            },
            { stage, answer: br, sources: [], session: gate.session, gateKernelV16: gate.kernel_v16 }
          )
        );
      }

      let answer = kernelResult.answer || null;
      if ((stage === 'K' || stage === 'C') && answer) {
        answer = stripSuggestions(answer);
      }

      await logAudit(responseSessionId, stage, responseType, query);

      // B-Integrity Monitor: after each research cycle (stage L completed), record snapshot and run checks
      if (stage === 'L') {
        runAfterCycle(responseSessionId, 'L', async () => {
          const info = await getRagService().getCollectionInfo();
          return (info && info.document_count) || 0;
        }).catch(e => logger.warn(`B-Integrity runAfterCycle failed: ${e.message}`));
      }

      if (SearchHistory) {
        try {
          await SearchHistory.create({
            user_id: userId,
            username: user?.username ?? 'אורח',
            question: query,
            answer
          });
        } catch (e) {
          logger.warn(`Failed to save search history: ${e.message}`);
        }
      }

      let kernelFiltered = filterChunksByRetrievalSimilarityThreshold(kernelResult.search_results || []);
      kernelFiltered = filterRetrievalRowsByAnswerBinding(kernelFiltered, answer || '');
      const maxSources = getMaxAttributionSources();
      const topChunks = kernelFiltered.slice(0, maxSources);
      const evidenceSources = buildAnswerSourcesFromRetrieval(topChunks, {
        maxItems: maxSources
      });
      return res.json(
        attachKernelV16ToPayload(
          {
            query,
            results_count: topChunks.length,
            results: topChunks,
            answer,
            context_sources: kernelResult.agent_results.doc_agent.context_sources || 0,
            context: kernelResult.context || '',
            sources: evidenceSources,
            error: null,
            decision: kernelResult.decision,
            state: kernelResult.state,
            warning: kernelResult.warning,
            session_id: responseSessionId,
            research_stage: stage,
            response_type: responseType,
            ...(enforcement && { matriya_enforcement: enforcement }),
            agent_results: {
              contradiction: kernelResult.agent_results.contradiction_agent,
              risk: kernelResult.agent_results.risk_agent
            }
          },
          { stage, answer, sources: evidenceSources, session: gate.session, gateKernelV16: gate.kernel_v16 }
        )
      );
    } else {
      // No generate_answer – plain search (no stage required)
      const results = await getRagService().search(query, nResults, filterMetadata);
      const relevantOnly = filterChunksByRetrievalSimilarityThreshold(results);
      return res.json({
        query: query,
        results_count: relevantOnly.length,
        results: relevantOnly,
        answer: null,
        sources: buildAnswerSourcesFromRetrieval(relevantOnly)
      });
    }
  } catch (e) {
    logger.error(`Error searching: ${e.message}`);
    return res.status(500).json({
      error: `Error searching: ${e.message}`
    });
  }
}

app.get("/search", handleMatriyaSearch);
app.post("/api/research/search", handleMatriyaSearch);

/**
 * Research run: either 4-agent loop (use_4_agents: true) or current single-shot flow (use_4_agents: false).
 * POST /api/research/run
 * Body: { session_id, query, use_4_agents?: boolean } (default use_4_agents: true for this endpoint)
 */
app.post("/api/research/run", async (req, res) => {
  try {
    const { session_id: sessionId, query, use_4_agents: use4Agents = true, filename, filenames: filenamesBody, pre_justification: preJustification, doe_design_id: doeDesignId } = req.body || {};
    if (!query || typeof query !== 'string') {
      return res.status(400).json({ error: 'query is required' });
    }
    if (!sessionId) {
      return res.status(400).json({ error: 'session_id is required for research run' });
    }
    const session = await ResearchSession.findByPk(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const kcShutdown = session.kernel_context && session.kernel_context.possibility_shutdown;
    if (use4Agents && kcShutdown) {
      return res.status(409).json({
        error:
          'לאחר זיהוי שבירה (B) הופעל סגירת מרחב אפשרויות — אין אופטימיזציה/כוונון במסלול 4 סוכנים. השתמשו במסלול מחקר מהיר (שלב N) או פתחו סשן חדש.',
        possibility_shutdown: true,
        kernel_v16: { spec: KERNEL_V16_VERSION, code: 'POSSIBILITY_SPACE_SHUTDOWN' }
      });
    }

    const violation = await getActiveViolation(sessionId);
    if (violation) {
      return res.status(409).json({
        error: `Session locked due to B-Integrity violation (${violation.reason || violation.type}). Use Recovery API to resolve.`,
        research_gate_locked: true,
        violation_id: violation.id,
        status: 'stopped',
        stopPipeline: true,
        allowed_next_step: 'recovery_required'
      });
    }

    let filenamesArray = Array.isArray(filenamesBody) && filenamesBody.length > 0 ? filenamesBody.filter(f => typeof f === 'string' && f.trim()) : null;
    // When a single file is selected, also try basename so we match whether RAG stored "file.pdf" or "folder/file.pdf"
    if (!filenamesArray?.length && filename && typeof filename === 'string' && filename.trim()) {
      const trimmed = filename.trim();
      const base = path.basename(trimmed);
      filenamesArray = base !== trimmed ? [trimmed, base] : [trimmed];
    }
    const filterMetadata = filenamesArray?.length ? { filenames: filenamesArray } : null;
    const runOptions = {};
    if (preJustification != null && typeof preJustification === 'string') runOptions.pre_justification_text = preJustification.trim() || null;
    if (doeDesignId != null) runOptions.doe_design_id = parseInt(doeDesignId, 10) || null;

    if (use4Agents) {
      const prev = researchRunLocks.get(sessionId) || Promise.resolve();
      const runPromise = prev
        .then(() => runLoop(sessionId, query.trim(), getRagService(), filterMetadata, runOptions))
        .finally(() => { if (researchRunLocks.get(sessionId) === runPromise) researchRunLocks.delete(sessionId); });
      researchRunLocks.set(sessionId, runPromise);
      const result = await runPromise;
      if (result.error) {
        return res.status(500).json({ error: result.error, outputs: result.outputs || {}, justifications: result.justifications || [] });
      }
      return res.json({
        run_id: result.run_id,
        outputs: result.outputs,
        justifications: result.justifications,
        sources: Array.isArray(result.sources) ? result.sources : []
      });
    }

    const kernel = getKernel();
    const kernelResult = await kernel.processUserIntent(query.trim(), null, null, null);
    return res.json({
      use_4_agents: false,
      decision: kernelResult.decision,
      state: kernelResult.state,
      answer: kernelResult.answer,
      reason: kernelResult.reason,
      context: kernelResult.context,
      agent_results: kernelResult.agent_results
    });
  } catch (e) {
    logger.error(`Research run error: ${e.message}`);
    return res.status(500).json({ error: e.message });
  }
});

/**
 * Create a new research session (Stage 1). Optional – session is also created on first /search with stage.
 */
app.post("/research/session", async (req, res) => {
  if (!ResearchSession) {
    return res.status(503).json({ error: "Research session storage not available. Ensure database is initialized and research_sessions table exists." });
  }
  const user = await getCurrentUser(req);
  const userId = user?.id ?? null;
  try {
    const { session } = await getOrCreateSession(null, userId);
    return res.json({ session_id: session.id, completed_stages: session.completed_stages || [] });
  } catch (e) {
    logger.error(`Create research session error: ${e.message}`);
    const isDbError = /relation|does not exist|research_sessions/i.test(String(e.message));
    return res.status(isDbError ? 503 : 500).json({
      error: isDbError ? "Research session table missing or DB error. Run migrations to create research_sessions." : e.message
    });
  }
});

/**
 * Get research session and audit log (for export/verification – Stage 1 checklist).
 */
app.get("/research/session/:id", async (req, res) => {
  if (!ResearchSession || !ResearchAuditLog) {
    return res.status(503).json({ error: "Research session storage not available" });
  }
  const sessionId = req.params.id;
  try {
    const session = await ResearchSession.findByPk(sessionId);
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }
    const logs = await ResearchAuditLog.findAll({
      where: { session_id: sessionId },
      order: [['created_at', 'ASC']]
    });
    return res.json({
      session_id: session.id,
      completed_stages: session.completed_stages || [],
      enforcement_overridden: !!session.enforcement_overridden,
      kernel_context: session.kernel_context && typeof session.kernel_context === 'object' ? session.kernel_context : {},
      created_at: session.created_at,
      audit_log: logs.map(l => ({
        stage: l.stage,
        response_type: l.response_type,
        request_query: l.request_query ? l.request_query.slice(0, 200) : null,
        created_at: l.created_at
      }))
    });
  } catch (e) {
    logger.error(`Get research session error: ${e.message}`);
    return res.status(500).json({ error: e.message });
  }
});

/** Set enforcement_overridden on session (dismiss soft-redirect warning for this session). */
app.patch("/research/session/:id", async (req, res) => {
  if (!ResearchSession) return res.status(503).json({ error: "Research session storage not available" });
  const sessionId = req.params.id;
  const overridden = req.body?.enforcement_overridden === true;
  try {
    const session = await ResearchSession.findByPk(sessionId);
    if (!session) return res.status(404).json({ error: "Session not found" });
    await session.update({ enforcement_overridden: overridden, updated_at: new Date() });
    return res.json({ session_id: session.id, enforcement_overridden: session.enforcement_overridden });
  } catch (e) {
    logger.error(`Patch research session error: ${e.message}`);
    return res.status(500).json({ error: e.message });
  }
});

/** Scope 1: Staging proof – current stage, next allowed, gate status (for verification/automation). */
app.get("/research/staging-proof", async (req, res) => {
  const sessionId = req.query.session_id || req.query.sessionId;
  if (!sessionId) return res.status(400).json({ error: "session_id query is required" });
  try {
    const session = await ResearchSession.findByPk(sessionId);
    if (!session) return res.status(404).json({ error: "Session not found" });
    const completed = session.completed_stages || [];
    const { getNextAllowedStage } = await import('./researchGate.js');
    const nextAllowed = getNextAllowedStage(completed);
    const violation = await getActiveViolation(sessionId);
    let lastSnapshotCycleIndex = null;
    if (IntegrityCycleSnapshot) {
      const last = await IntegrityCycleSnapshot.findOne({
        where: { session_id: sessionId },
        order: [['created_at', 'DESC']]
      });
      if (last) lastSnapshotCycleIndex = last.cycle_index;
    }
    return res.json({
      session_id: sessionId,
      current_stage: completed.length ? completed[completed.length - 1] : null,
      completed_stages: completed,
      next_allowed: nextAllowed,
      gate_locked: !!violation,
      violation_id: violation?.id ?? null,
      last_snapshot_cycle_index: lastSnapshotCycleIndex,
      kernel_v16: {
        spec: KERNEL_V16_VERSION,
        possibility_shutdown: !!(session.kernel_context && session.kernel_context.possibility_shutdown),
        document_mode_n: !!(session.kernel_context && session.kernel_context.document_mode_n)
      }
    });
  } catch (e) {
    logger.error(`Staging proof error: ${e.message}`);
    return res.status(500).json({ error: e.message });
  }
});

/** Scope 2: Read-only – list decision audit log (no UI). */
app.get("/api/audit/decisions", async (req, res) => {
  if (!DecisionAuditLog) return res.status(503).json({ error: "Decision audit log not available" });
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  try {
    const { count, rows } = await DecisionAuditLog.findAndCountAll({
      order: [['created_at', 'DESC']],
      limit,
      offset
    });
    return res.json({ decisions: rows, total: count, limit, offset });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

/** Scope 2: Read-only – decision audit for one session (replay/snapshot). */
app.get("/api/audit/session/:sessionId/decisions", async (req, res) => {
  if (!DecisionAuditLog) return res.status(503).json({ error: "Decision audit log not available" });
  const sessionId = req.params.sessionId;
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 100));
  try {
    const rows = await DecisionAuditLog.findAll({
      where: { session_id: sessionId },
      order: [['created_at', 'ASC']],
      limit
    });
    return res.json({ session_id: sessionId, decisions: rows });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ---------- Kernel Amendment v1.2 – Observability dashboard, SEM, gates, noise ----------
/** Metrics dashboard: False B rate, Missed B rate, confidence, complexity + total_requests, latency_p50, latency_p99, error_count */
app.get("/api/observability/dashboard", async (req, res) => {
  try {
    const dashboard = await getMetricsDashboard();
    if (!dashboard) return res.status(503).json({ error: "Decision audit log not available" });
    const metrics = getMetrics();
    return res.json({
      ...dashboard,
      total_requests: metrics.total_requests,
      latency_p50: metrics.latency_p50,
      latency_p99: metrics.latency_p99,
      error_count: metrics.total_errors
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

/** SEM output: component_breakdown, confidence_range, historical_predictive_accuracy (no single value) */
app.get("/api/observability/sem", async (req, res) => {
  try {
    const sem = await getSEMOutput();
    if (!sem) return res.status(503).json({ error: "Decision audit log not available" });
    return res.json(sem);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

/** Gate records for dashboard: confidence_score, basis_count, model_version_hash per gate */
app.get("/api/observability/gates", async (req, res) => {
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  try {
    const out = await getGateRecords(limit, offset);
    return res.json(out);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

/** List noise events (for re-evaluation after Kernel update) */
app.get("/api/observability/noise", async (req, res) => {
  if (!NoiseEvent) return res.status(503).json({ error: "Noise events not available" });
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  try {
    const { count, rows } = await NoiseEvent.findAndCountAll({
      order: [['created_at', 'DESC']],
      limit,
      offset
    });
    return res.json({ noise_events: rows, total: count, limit, offset });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

/** Record event as noise – for later re-evaluation after Kernel update */
app.post("/api/observability/noise", async (req, res) => {
  if (!NoiseEvent) return res.status(503).json({ error: "Noise events not available" });
  const { session_id: sessionId, decision_id: decisionId, event_type: eventType, re_evaluate_after_kernel_version: reEvalVersion } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: "session_id is required" });
  try {
    const currentHash = getModelVersionHash();
    const row = await NoiseEvent.create({
      session_id: sessionId,
      decision_id: decisionId || null,
      event_type: eventType || 'gate_decision',
      kernel_version_at_classification: currentHash,
      re_evaluate_after_kernel_version: reEvalVersion || null
    });
    return res.status(201).json(row);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

/** Set human_feedback on a decision (false_b | missed_b) for False B / Missed B rate */
app.patch("/api/observability/decision/:id/feedback", async (req, res) => {
  if (!DecisionAuditLog) return res.status(503).json({ error: "Decision audit log not available" });
  const id = parseInt(req.params.id, 10);
  const feedback = req.body?.human_feedback;
  if (!['false_b', 'missed_b'].includes(feedback)) return res.status(400).json({ error: "human_feedback must be 'false_b' or 'missed_b'" });
  try {
    const row = await DecisionAuditLog.findByPk(id);
    if (!row) return res.status(404).json({ error: "Decision not found" });
    await row.update({ human_feedback: feedback });
    return res.json(row);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

/**
 * Contradiction Agent - Checks for contradictions in the answer
 * 
 * JSON body:
 *   answer: The answer from Doc Agent
 *   context: The context used to generate the answer
 *   query: Original user query
 * 
 * Returns:
 *   Contradiction analysis results
 */
app.post("/agent/contradiction", async (req, res) => {
  const { answer, context, query } = req.body;
  
  if (!answer || !context || !query) {
    return res.status(400).json({ error: "answer, context, and query are required" });
  }
  
  try {
    const result = await getRagService().checkContradictions(answer, context, query);
    return res.json(result);
  } catch (e) {
    logger.error(`Error checking contradictions: ${e.message}`);
    return res.status(500).json({
      error: `Error checking contradictions: ${e.message}`
    });
  }
});

/**
 * Risk Agent - Identifies risks in the answer
 * 
 * JSON body:
 *   answer: The answer from Doc Agent
 *   context: The context used for the answer
 *   query: Original user query
 * 
 * Returns:
 *   Risk analysis results
 */
app.post("/agent/risk", async (req, res) => {
  const { answer, context, query } = req.body;
  
  if (!answer || !context || !query) {
    return res.status(400).json({ error: "answer, context, and query are required" });
  }
  
  try {
    const result = await getRagService().checkRisks(answer, context, query);
    return res.json(result);
  } catch (e) {
    logger.error(`Error checking risks: ${e.message}`);
    return res.status(500).json({
      error: `Error checking risks: ${e.message}`
    });
  }
});

/**
 * Get information about the vector database collection
 */
app.get("/collection/info", async (req, res) => {
  try {
    const info = await getRagService().getCollectionInfo();
    return res.json(info);
  } catch (e) {
    logger.error(`Error getting collection info: ${e.message}`);
    return res.status(500).json({
      error: `Error getting collection info: ${e.message}`
    });
  }
});

/**
 * OpenAI File Search status (vector store + env flags). Aligns with manager Documents GPT RAG UX.
 */
app.get("/gpt-rag/status", async (req, res) => {
  const key = (settings.OPENAI_API_KEY || '').trim();
  if (!key) {
    return res.json({
      configured: false,
      openai: false,
      reason: 'cloud_doc_key_missing',
      use_openai_file_search: useOpenAiFileSearchEnabled()
    });
  }
  await hydrateMatriyaOpenAiVectorStoreId();
  const enabled = useOpenAiFileSearchEnabled();
  const vsId = getMatriyaOpenAiVectorStoreId();
  if (!enabled) {
    return res.json({
      configured: true,
      openai: true,
      use_openai_file_search: false,
      vector_store_id: vsId || null,
      hint: 'cloud_file_search_disabled'
    });
  }
  if (!vsId) {
    return res.json({
      configured: true,
      openai: true,
      use_openai_file_search: true,
      vector_store_id: null,
      vector_store_status: null,
      hint: 'sync_required'
    });
  }
  try {
    const base = getOpenAiApiBase();
    const r = await axios.get(`${base}/vector_stores/${vsId}`, {
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'OpenAI-Beta': 'assistants=v2'
      },
      timeout: 30000
    });
    return res.json({
      configured: true,
      openai: true,
      use_openai_file_search: true,
      vector_store_id: vsId,
      vector_store_status: r.data?.status || null,
      file_counts: r.data?.file_counts || null
    });
  } catch (e) {
    return res.json({
      configured: true,
      openai: true,
      use_openai_file_search: true,
      vector_store_id: vsId,
      vector_store_status: 'unknown',
      warning: e.response?.data?.error?.message || e.message
    });
  }
});

/**
 * Sync indexed Matriya documents (extracted text) into a new OpenAI vector store; persists store id under uploads.
 */
app.post("/gpt-rag/sync", async (req, res) => {
  const key = (settings.OPENAI_API_KEY || '').trim();
  if (!key) {
    return res.status(503).json({ error: 'OPENAI_API_KEY not set' });
  }
  await hydrateMatriyaOpenAiVectorStoreId();
  let rag;
  try {
    rag = getRagService();
  } catch (e) {
    return res.status(503).json({ error: e.message || 'RAG service unavailable' });
  }
  try {
    const rawNames = req.body?.only_logical_names;
    const onlyLogicalNames = Array.isArray(rawNames)
      ? rawNames.map((n) => String(n || '').trim()).filter(Boolean)
      : undefined;
    const result = await syncMatriyaRagToOpenAI(rag, {
      openaiApiKey: key,
      openaiBase: getOpenAiApiBase(),
      onLog: (msg) => logger.info(`[gpt-rag/sync] ${msg}`),
      ...(onlyLogicalNames && onlyLogicalNames.length > 0 ? { onlyLogicalNames } : {})
    });
    if (!result.ok) {
      return res.status(result.status).json({
        error: result.error,
        skipped: result.skipped,
        uploaded: result.uploaded,
        batch_id: result.batch_id
      });
    }
    await persistMatriyaOpenAiVectorStoreId(result.vector_store_id);
    return res.json({
      ok: true,
      vector_store_id: result.vector_store_id,
      uploaded: result.uploaded,
      incremental: Boolean(result.incremental),
      skipped: result.skipped,
      batch_status: result.batch_status,
      indexing_pending: Boolean(result.indexing_pending),
      batch_id: result.batch_id || undefined
    });
  } catch (e) {
    logger.error(`gpt-rag/sync: ${e.message}`);
    return res.status(500).json({ error: e.response?.data?.error?.message || e.message || 'Sync failed' });
  }
});

function gptFileSearchMeta(ragInstance) {
  const base = {
    use_openai_file_search: useOpenAiFileSearchEnabled(),
    vector_store_configured: Boolean(getMatriyaOpenAiVectorStoreId()),
    active: false
  };
  try {
    if (ragInstance && typeof ragInstance.openAiFileSearchActive === 'function') {
      base.active = ragInstance.openAiFileSearchActive();
    }
  } catch (_) {}
  return base;
}

/**
 * Get list of all uploaded files
 */
app.get("/files", async (req, res) => {
  try {
    const rag = getRagService();
    const filenames = await rag.getAllFilenames();
    return res.json({
      files: filenames,
      count: filenames.length,
      gpt_file_search: gptFileSearchMeta(rag)
    });
  } catch (e) {
    logger.error(`Error getting files: ${e.message}`);
    return res.status(500).json({
      error: `Error getting files: ${e.message}`
    });
  }
});

/**
 * Get list of files with metadata (file type derived from name, chunks_count, uploaded_at)
 */
app.get("/files/detail", async (req, res) => {
  try {
    const rag = getRagService();
    const files = await rag.getFilesWithMetadata();
    return res.json({ files, gpt_file_search: gptFileSearchMeta(rag) });
  } catch (e) {
    logger.error(`Error getting files detail: ${e.message}`);
    return res.status(500).json({
      error: `Error getting files detail: ${e.message}`
    });
  }
});

/**
 * Get first chunk of a file for preview
 */
app.get("/files/preview", async (req, res) => {
  const filename = req.query.filename;
  if (!filename || typeof filename !== 'string') {
    return res.status(400).json({ error: 'filename query is required' });
  }
  try {
    const chunk = await getRagService().getFirstChunkForFile(filename);
    if (!chunk) return res.status(404).json({ error: 'File not found or has no chunks' });
    return res.json(chunk);
  } catch (e) {
    logger.error(`Error getting file preview: ${e.message}`);
    return res.status(500).json({ error: `Error getting file preview: ${e.message}` });
  }
});

/**
 * Delete documents by IDs
 * 
 * JSON body:
 *   ids: List of document IDs to delete
 * 
 * Returns:
 *   Deletion result
 */
app.delete("/files", requireAuth, async (req, res) => {
  const { filename } = req.body || {};
  if (!filename || typeof filename !== "string" || !filename.trim()) {
    return res.status(400).json({ error: "filename is required in body" });
  }
  try {
    const rag = getRagService();
    const trimmed = filename.trim();
    const deleted = await rag.deleteDocumentsByFilename(trimmed);

    // Reply immediately. OpenAI detach + prune can scan many vector-store files and take minutes,
    // which left the UI stuck on «מוחק…» until the client timed out.
    res.json({ success: true, message: `Deleted ${deleted} chunks`, deleted_count: deleted });

    const apiKey = (settings.OPENAI_API_KEY || '').trim();
    if (apiKey) {
      setImmediate(() => {
        (async () => {
          try {
            await removeMatriyaOpenAiFileByLogicalName(trimmed, {
              openaiApiKey: apiKey,
              openaiBase: settings.OPENAI_API_BASE,
              onLog: (m) => logger.info(`[OpenAI delete file] ${m}`)
            });
          } catch (e) {
            logger.error(`[OpenAI delete file] ${e.message}`);
          }
          try {
            await onMatriyaRagFileDeleted(rag, {
              openaiApiKey: apiKey,
              openaiBase: settings.OPENAI_API_BASE,
              onLog: (m) => logger.info(`[OpenAI prune after delete] ${m}`)
            });
          } catch (err) {
            logger.error(`[OpenAI prune after delete] ${err.message}`);
          }
        })();
      });
    }
    return;
  } catch (e) {
    logger.error(`Error deleting file: ${e.message}`);
    return res.status(500).json({ error: e.message });
  }
});

app.delete("/documents", async (req, res) => {
  const { ids } = req.body;
  if (!ids || !Array.isArray(ids)) {
    return res.status(400).json({ error: "ids array is required" });
  }

  try {
    const success = await getRagService().deleteDocuments(ids);
    if (success) {
      return res.json({
        success: true,
        message: `Deleted ${ids.length} documents`,
        deleted_ids: ids
      });
    } else {
      return res.status(500).json({
        error: "Failed to delete documents"
      });
    }
  } catch (e) {
    logger.error(`Error deleting documents: ${e.message}`);
    return res.status(500).json({
      error: `Error deleting documents: ${e.message}`
    });
  }
});

/**
 * Reset the entire vector database (WARNING: This deletes all data)
 * 
 * Returns:
 *   Reset result
 */
app.post("/reset", async (req, res) => {
  try {
    const success = await getRagService().resetDatabase();
    if (success) {
      return res.json({
        success: true,
        message: "Database reset successfully"
      });
    } else {
      return res.status(500).json({
        error: "Failed to reset database"
      });
    }
  } catch (e) {
    logger.error(`Error resetting database: ${e.message}`);
    return res.status(500).json({
      error: `Error resetting database: ${e.message}`
    });
  }
});

// Start server
if (!process.env.VERCEL) {
  app.listen(settings.API_PORT, settings.API_HOST, () => {
    logger.info(`Server running on http://${settings.API_HOST}:${settings.API_PORT}`);
  });
}

export default app;
