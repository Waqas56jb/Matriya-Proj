/**
 * Express application for RAG system file ingestion
 */
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, mkdirSync, unlinkSync } from 'fs';
import settings from './config.js';
import RAGService from './ragService.js';
import { initDb, SearchHistory, ResearchSession, ResearchAuditLog, PolicyAuditLog, DecisionAuditLog, NoiseEvent, IntegrityCycleSnapshot, Experiment, EXPERIMENT_OUTCOMES } from './database.js';
import { authRouter, getCurrentUser } from './authEndpoints.js';
import { adminRouter } from './adminEndpoints.js';
import { StateMachine, Kernel } from './stateMachine.js';
import {
  validateAndAdvance,
  logAudit,
  getOrCreateSession,
  getGateObservabilityContext,
  HARD_STOP_MESSAGE,
  stripSuggestions
} from './researchGate.js';
import { runAfterCycle, getActiveViolation } from './integrityMonitor.js';
import { runLoop } from './researchLoop.js';
import logger from './logger.js';
import { metricsMiddleware, getMetrics } from './metrics.js';
import { getMetricsDashboard, getSEMOutput, getGateRecords } from './observability.js';
import { getModelVersionHash } from './researchGate.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Initialize Express app
const app = express();

// CORS configuration - Allow all origins
logger.info("CORS configured to allow all origins");
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH", "HEAD"],
  allowedHeaders: "*",
  exposedHeaders: "*",
  credentials: true,
  maxAge: 3600
}));

// Handle preflight requests explicitly
app.options('*', cors());

// Body parsing middleware with UTF-8 support
app.use(express.json({ charset: 'utf-8' }));
app.use(express.urlencoded({ extended: true, charset: 'utf-8' }));

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
    const dest = process.env.VERCEL ? '/tmp' : settings.UPLOAD_DIR;
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
    // Fix encoding if filename is garbled (UTF-8 interpreted as Latin-1)
    try {
      if (originalName.includes('×')) {
        const buffer = Buffer.from(originalName, 'latin1');
        originalName = buffer.toString('utf-8');
      }
    } catch (e) {
      // If fixing fails, use as-is
    }
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

/**
 * Health check endpoint (Scope 3: includes metrics and latency)
 */
app.get("/health", async (req, res) => {
  try {
    const info = await getRagService().getCollectionInfo();
    const metrics = getMetrics();
    return res.json({
      status: "healthy",
      vector_db: info,
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
  
  // Validate file extension
  const fileExt = file.originalname.substring(file.originalname.lastIndexOf('.')).toLowerCase();
  if (!settings.ALLOWED_EXTENSIONS.includes(fileExt)) {
    return res.status(400).json({
      error: `File type ${fileExt} not supported. Allowed: ${settings.ALLOWED_EXTENSIONS.join(', ')}`
    });
  }
  
  // Validate file size
  if (file.size > settings.MAX_FILE_SIZE) {
    return res.status(400).json({
      error: `File size exceeds maximum of ${settings.MAX_FILE_SIZE} bytes`
    });
  }
  
  const tempFilePath = file.path;
  // Get original filename and fix encoding issues
  // Browsers often send filenames in RFC 2231 format or URL-encoded
  let originalFilename = file.originalname;
  
  // Handle different encoding scenarios
  if (Buffer.isBuffer(originalFilename)) {
    originalFilename = originalFilename.toString('utf-8');
  }
  
  // Try to fix garbled UTF-8 (when UTF-8 bytes are interpreted as Latin-1)
  // This happens when browsers send UTF-8 but it's decoded as Latin-1
  try {
    // If filename contains garbled characters (like ×), try to fix it
    if (originalFilename.includes('×')) {
      // Convert to Buffer and re-decode as UTF-8
      const buffer = Buffer.from(originalFilename, 'latin1');
      originalFilename = buffer.toString('utf-8');
      logger.info(`Fixed filename encoding: ${originalFilename}`);
    }
    
    // Also try URL decoding if it contains encoded characters
    if (originalFilename.includes('%') && /%[0-9A-F]{2}/i.test(originalFilename)) {
      originalFilename = decodeURIComponent(originalFilename);
    }
  } catch (e) {
    logger.warn(`Could not fix filename encoding: ${e.message}, using as-is: ${originalFilename}`);
  }
  
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
    const result = await ragService.ingestFile(tempFilePath, originalFilename);

    try {
      if (existsSync(tempFilePath)) unlinkSync(tempFilePath);
    } catch (e) {
      logger.warn(`Failed to delete temp file: ${e.message}`);
    }

    if (result.success) {
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
    return res.json(result);
  } catch (e) {
    logger.error(`Error ingesting directory: ${e.message}`);
    return res.status(500).json({
      error: `Error ingesting directory: ${e.message}`
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
 *
 * Returns:
 *   Search results, generated answer (or hard stop for B), session_id, research_stage
 */
app.get("/search", async (req, res) => {
  const query = req.query.query;
  if (!query) {
    return res.status(400).json({ error: "query parameter is required" });
  }

  let nResults = parseInt(req.query.n_results) || 5;
  if (nResults < 1 || nResults > 50) {
    nResults = 5;
  }

  const filename = req.query.filename || null;
  const generateAnswer = req.query.generate_answer !== 'false';
  const stage = (req.query.stage || '').toUpperCase().trim();
  const sessionId = req.query.session_id || null;

  const filterMetadata = filename ? { filename } : null;

  const user = await getCurrentUser(req);
  const userId = user?.id ?? null;

  try {
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
      let gate;
      try {
        gate = await validateAndAdvance(sessionId, stage, userId);
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
        return res.status(400).json({
          error: gate.error,
          research_stage_error: true,
          ...(gate.research_gate_locked && {
            research_gate_locked: true,
            violation_id: gate.violation_id,
            status: gate.status || 'stopped',
            stopPipeline: gate.stopPipeline !== false,
            allowed_next_step: gate.allowed_next_step || 'recovery_required'
          })
        });
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
        return res.json({
          query,
          results_count: 0,
          results: [],
          answer: HARD_STOP_MESSAGE,
          context_sources: 0,
          context: '',
          session_id: responseSessionId,
          research_stage: stage,
          response_type: responseType,
          ...(enforcement && { matriya_enforcement: enforcement })
        });
      }

      // K/C: info only (no solutions) – we'll post-process answer. N/L: full answer
      const kernel = getKernel();
      const kernelResult = await kernel.processUserIntent(
        query,
        null,
        null,
        filterMetadata
      );

      if (kernelResult.decision === 'block' || kernelResult.decision === 'stop') {
        const noAnswerFromRag = (kernelResult.reason || '').includes('לא נמצאה תשובה') || (kernelResult.reason || '').includes('No answer');
        if (noAnswerFromRag) {
          await logAudit(responseSessionId, stage, 'no_results', query);
          return res.json({
            query,
            results_count: 0,
            results: kernelResult.search_results || [],
            answer: 'לא נמצא מידע רלוונטי במסמכים.',
            context_sources: 0,
            context: '',
            session_id: responseSessionId,
            research_stage: stage,
            response_type: 'no_results',
            ...(enforcement && { matriya_enforcement: enforcement })
          });
        }
        await logAudit(responseSessionId, stage, 'blocked', query);
        return res.json({
          query,
          results_count: 0,
          results: [],
          answer: null,
          context_sources: 0,
          context: '',
          error: kernelResult.reason || 'תשובה נחסמה',
          decision: kernelResult.decision,
          state: kernelResult.state,
          blocked: true,
          block_reason: kernelResult.reason || '',
          session_id: responseSessionId,
          research_stage: stage,
          ...(enforcement && { matriya_enforcement: enforcement })
        });
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

      return res.json({
        query,
        results_count: kernelResult.agent_results.doc_agent.results_count || 0,
        results: kernelResult.search_results || [],
        answer,
        context_sources: kernelResult.agent_results.doc_agent.context_sources || 0,
        context: kernelResult.context || '',
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
      });
    } else {
      // No generate_answer – plain search (no stage required)
      const results = await getRagService().search(query, nResults, filterMetadata);
      return res.json({
        query: query,
        results_count: results.length,
        results: results,
        answer: null
      });
    }
  } catch (e) {
    logger.error(`Error searching: ${e.message}`);
    return res.status(500).json({
      error: `Error searching: ${e.message}`
    });
  }
});

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

    const filenamesArray = Array.isArray(filenamesBody) && filenamesBody.length > 0 ? filenamesBody.filter(f => typeof f === 'string' && f.trim()) : null;
    const filterMetadata = filenamesArray?.length ? { filenames: filenamesArray } : (filename && typeof filename === 'string' && filename.trim() ? { filename: filename.trim() } : null);
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
        justifications: result.justifications
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
      last_snapshot_cycle_index: lastSnapshotCycleIndex
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
 * Get list of all uploaded files
 */
app.get("/files", async (req, res) => {
  try {
    const filenames = await getRagService().getAllFilenames();
    return res.json({
      files: filenames,
      count: filenames.length
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
    const files = await getRagService().getFilesWithMetadata();
    return res.json({ files });
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
