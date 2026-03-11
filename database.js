/**
 * Database setup for user management - Supabase PostgreSQL only
 */
import { Sequelize, DataTypes } from 'sequelize';
import logger from './logger.js';

// Get database URL - Supabase only (simplest possible)
function getDatabaseUrl() {
  // Prefer POSTGRES_URL (pooler, works on Vercel and local)
  // Fallback to SUPABASE_DB_URL (direct, for local development only)
  const dbUrl = process.env.POSTGRES_URL || process.env.POSTGRES_PRISMA_URL || process.env.SUPABASE_DB_URL;
  if (!dbUrl) {
    let errorMsg = "Database connection string not found. ";
    if (process.env.VERCEL) {
      errorMsg += "Set POSTGRES_URL in Vercel Dashboard → Settings → Environment Variables. Use Supabase pooler connection.";
    } else {
      errorMsg += "Set POSTGRES_URL (pooler) or SUPABASE_DB_URL (direct) in your .env file.";
    }
    logger.error(errorMsg);
    throw new Error(errorMsg);
  }
  if (dbUrl.includes('pooler.supabase.com')) {
    logger.info("Using Supabase PostgreSQL pooler connection");
  } else {
    logger.info("Using Supabase PostgreSQL direct connection");
  }
  return dbUrl;
}

// Create Sequelize instance
let sequelize;
let DATABASE_URL;

try {
  DATABASE_URL = getDatabaseUrl();
  
  // Clean connection string - remove ALL query parameters (handled in dialectOptions)
  // Parse URL to extract base connection string without query params
  let dbUrl = DATABASE_URL;
  const urlMatch = dbUrl.match(/^(postgres(?:ql)?:\/\/[^?]+)/i);
  if (urlMatch) {
    dbUrl = urlMatch[1]; // Get base URL without query parameters
  }
  
  // Pool configuration (optimized for serverless)
  const poolConfig = {
    max: process.env.VERCEL ? 1 : 5,
    min: 0,
    idle: 10000,
    acquire: process.env.VERCEL ? 5000 : 10000,
    evict: process.env.VERCEL ? 1000 : 60000
  };
  
  sequelize = new Sequelize(dbUrl, {
    dialect: 'postgres',
    logging: false,
    dialectOptions: {
      ssl: {
        require: true,
        rejectUnauthorized: false
      },
      connectTimeout: process.env.VERCEL ? 5000 : 10000
    },
    pool: poolConfig
  });
  
  logger.info("Supabase database connection configured");
} catch (e) {
  logger.error(`Database setup failed: ${e.message}`);
  DATABASE_URL = null;
  sequelize = null;
}

// Define User model - will be null if sequelize is null (connection failed)
const User = sequelize ? sequelize.define('User', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  username: {
    type: DataTypes.STRING,
    unique: true,
    allowNull: false
  },
  email: {
    type: DataTypes.STRING,
    unique: true,
    allowNull: false
  },
  hashed_password: {
    type: DataTypes.STRING,
    allowNull: false
  },
  full_name: {
    type: DataTypes.STRING,
    allowNull: true
  },
  is_active: {
    type: DataTypes.BOOLEAN,
    defaultValue: true
  },
  is_admin: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  created_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  },
  last_login: {
    type: DataTypes.DATE,
    allowNull: true
  }
}, {
  tableName: 'users',
  timestamps: false
}) : null;

// Define FilePermission model
const FilePermission = sequelize ? sequelize.define('FilePermission', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  user_id: {
    type: DataTypes.INTEGER,
    allowNull: false
  },
  filename: {
    type: DataTypes.STRING,
    allowNull: false
  },
  created_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  }
}, {
  tableName: 'file_permissions',
  timestamps: false
}) : null;

// Define SearchHistory model - stores each user's question and AI answer
const SearchHistory = sequelize ? sequelize.define('SearchHistory', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  user_id: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  username: {
    type: DataTypes.STRING,
    allowNull: true
  },
  question: {
    type: DataTypes.TEXT,
    allowNull: false
  },
  answer: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  created_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  }
}, {
  tableName: 'search_history',
  timestamps: false
}) : null;

// Research Session (Stage 1) - FSM: K→C→B→N→L
const STAGES_ORDER = ['K', 'C', 'B', 'N', 'L'];

const ResearchSession = sequelize ? sequelize.define('ResearchSession', {
  id: {
    type: DataTypes.UUID,
    primaryKey: true,
    defaultValue: DataTypes.UUIDV4
  },
  user_id: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  completed_stages: {
    type: DataTypes.ARRAY(DataTypes.STRING),
    defaultValue: [],
    allowNull: false
  },
  created_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  },
  updated_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  },
  enforcement_overridden: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
    allowNull: false
  }
}, {
  tableName: 'research_sessions',
  timestamps: false
}) : null;

const ResearchAuditLog = sequelize ? sequelize.define('ResearchAuditLog', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  session_id: {
    type: DataTypes.UUID,
    allowNull: false
  },
  stage: {
    type: DataTypes.STRING,
    allowNull: false
  },
  response_type: {
    type: DataTypes.STRING,
    allowNull: true
  },
  request_query: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  created_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  }
}, {
  tableName: 'research_audit_log',
  timestamps: false
}) : null;

const PolicyAuditLog = sequelize ? sequelize.define('PolicyAuditLog', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  session_id: {
    type: DataTypes.UUID,
    allowNull: false
  },
  stage: {
    type: DataTypes.STRING,
    allowNull: true
  },
  created_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  }
}, {
  tableName: 'policy_audit_log',
  timestamps: false
}) : null;

// Decision audit log (Scope 2 – full trail: allow/block/stop + inputs_snapshot for replay)
const DecisionAuditLog = sequelize ? sequelize.define('DecisionAuditLog', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  session_id: {
    type: DataTypes.UUID,
    allowNull: false
  },
  stage: {
    type: DataTypes.STRING,
    allowNull: false
  },
  decision: {
    type: DataTypes.STRING,
    allowNull: false
  },
  response_type: {
    type: DataTypes.STRING,
    allowNull: true
  },
  request_query: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  inputs_snapshot: {
    type: DataTypes.JSONB,
    allowNull: true
  },
  details: {
    type: DataTypes.JSONB,
    allowNull: true
  },
  confidence_score: {
    type: DataTypes.DECIMAL(5, 4),
    allowNull: true
  },
  basis_count: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  model_version_hash: {
    type: DataTypes.STRING(64),
    allowNull: true
  },
  complexity_context: {
    type: DataTypes.JSONB,
    allowNull: true
  },
  human_feedback: {
    type: DataTypes.STRING(20),
    allowNull: true
  },
  created_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  }
}, {
  tableName: 'decision_audit_log',
  timestamps: false
}) : null;

// Noise events (Kernel Amendment v1.2 – re-evaluation after Kernel update)
const NoiseEvent = sequelize ? sequelize.define('NoiseEvent', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  session_id: {
    type: DataTypes.UUID,
    allowNull: false
  },
  decision_id: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  event_type: {
    type: DataTypes.STRING(50),
    allowNull: false,
    defaultValue: 'gate_decision'
  },
  kernel_version_at_classification: {
    type: DataTypes.STRING(64),
    allowNull: true
  },
  re_evaluate_after_kernel_version: {
    type: DataTypes.STRING(64),
    allowNull: true
  },
  created_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  }
}, {
  tableName: 'noise_events',
  timestamps: false
}) : null;

// B-Integrity: snapshot of |M| (e.g. document count) per research cycle
const IntegrityCycleSnapshot = sequelize ? sequelize.define('IntegrityCycleSnapshot', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  session_id: {
    type: DataTypes.UUID,
    allowNull: false
  },
  stage: {
    type: DataTypes.STRING,
    allowNull: false
  },
  cycle_index: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0
  },
  metric_name: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'document_count'
  },
  metric_value: {
    type: DataTypes.INTEGER,
    allowNull: false
  },
  details: {
    type: DataTypes.JSONB,
    allowNull: true
  },
  created_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  }
}, {
  tableName: 'integrity_cycle_snapshots',
  timestamps: false
}) : null;

// B-Integrity: violation record – when present and unresolved, gate is locked for that session
const Violation = sequelize ? sequelize.define('Violation', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  session_id: {
    type: DataTypes.UUID,
    allowNull: false
  },
  type: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'B_INTEGRITY'
  },
  reason: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  details: {
    type: DataTypes.JSONB,
    allowNull: true
  },
  created_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  },
  resolved_at: {
    type: DataTypes.DATE,
    allowNull: true
  },
  resolved_by: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  resolve_note: {
    type: DataTypes.TEXT,
    allowNull: true
  }
}, {
  tableName: 'violations',
  timestamps: false
}) : null;

// System Snapshots: save/restore state (e.g. integrity data)
const SystemSnapshot = sequelize ? sequelize.define('SystemSnapshot', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  snapshot_type: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'integrity'
  },
  payload: {
    type: DataTypes.JSONB,
    allowNull: false
  },
  created_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  },
  created_by: {
    type: DataTypes.INTEGER,
    allowNull: true
  }
}, {
  tableName: 'system_snapshots',
  timestamps: false
}) : null;

// Research Loop MVP: one run of the 4-agent loop (analysis → research → critic → synthesis)
const ResearchLoopRun = sequelize ? sequelize.define('ResearchLoopRun', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  session_id: {
    type: DataTypes.UUID,
    allowNull: false
  },
  query: {
    type: DataTypes.TEXT,
    allowNull: false
  },
  outputs: {
    type: DataTypes.JSONB,
    allowNull: true,
    defaultValue: {}
  },
  justifications: {
    type: DataTypes.JSONB,
    allowNull: true,
    defaultValue: []
  },
  stopped_by_violation: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false
  },
  violation_id: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  duration_ms: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  pre_justification_text: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  doe_design_id: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  created_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  }
}, {
  tableName: 'research_loop_runs',
  timestamps: false
}) : null;

// Justification templates: reason_code → label/description for research loop justifications
const JustificationTemplate = sequelize ? sequelize.define('JustificationTemplate', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false
  },
  reason_code: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true
  },
  label: {
    type: DataTypes.STRING,
    allowNull: true
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  template_text: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  created_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  },
  updated_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  }
}, {
  tableName: 'justification_templates',
  timestamps: false
}) : null;

// DoE (Design of Experiments): store designs for integration with DoE tools
const DoEDesign = sequelize ? sequelize.define('DoEDesign', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  design: {
    type: DataTypes.JSONB,
    allowNull: false,
    defaultValue: []
  },
  query_template: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  created_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  },
  updated_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  }
}, {
  tableName: 'doe_designs',
  timestamps: false
}) : null;

// Experiment batches (research sessions): group experiments into a series
const ExperimentBatch = sequelize ? sequelize.define('ExperimentBatch', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  name: {
    type: DataTypes.STRING,
    allowNull: true
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  created_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  }
}, {
  tableName: 'experiment_batches',
  timestamps: false
}) : null;

// Experiments synced from lab system – for learning and similar_experiments
const EXPERIMENT_OUTCOMES = ['success', 'failure', 'partial', 'production_formula'];
const Experiment = sequelize ? sequelize.define('Experiment', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  experiment_id: {
    type: DataTypes.STRING,
    allowNull: false,
    comment: 'ID from lab system'
  },
  experiment_version: {
    type: DataTypes.STRING,
    allowNull: true,
    comment: 'Version to track updates over time'
  },
  technology_domain: {
    type: DataTypes.STRING,
    allowNull: true
  },
  formula: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  materials: {
    type: DataTypes.JSONB,
    allowNull: true,
    defaultValue: null
  },
  percentages: {
    type: DataTypes.JSONB,
    allowNull: true,
    defaultValue: null
  },
  results: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  experiment_outcome: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'success'
  },
  is_production_formula: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false
  },
  source_file_reference: {
    type: DataTypes.STRING,
    allowNull: true,
    comment: 'Reference to original document in SharePoint'
  },
  experiment_batch_id: {
    type: DataTypes.INTEGER,
    allowNull: true,
    references: { model: 'experiment_batches', key: 'id' }
  },
  created_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  },
  updated_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  }
}, {
  tableName: 'experiments',
  timestamps: false,
  indexes: [
    { unique: true, fields: ['experiment_id'] },
    { fields: ['technology_domain'] },
    { fields: ['experiment_outcome'] },
    { fields: ['is_production_formula'] },
    { fields: ['experiment_batch_id'] },
    { fields: ['source_file_reference'] }
  ]
}) : null;

// Import log: track which file created/updated what
const ImportLog = sequelize ? sequelize.define('ImportLog', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  source_file: {
    type: DataTypes.STRING,
    allowNull: false,
    comment: 'File path or identifier (e.g. SharePoint path)'
  },
  source_type: {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: 'sharepoint',
    comment: 'e.g. sharepoint, lab_system'
  },
  created_entity_type: {
    type: DataTypes.STRING,
    allowNull: true,
    comment: 'e.g. experiment, experiment_batch'
  },
  created_entity_id: {
    type: DataTypes.STRING,
    allowNull: true,
    comment: 'ID of created/updated entity'
  },
  status: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'success',
    comment: 'success, failure, partial'
  },
  details: {
    type: DataTypes.JSONB,
    allowNull: true,
    comment: 'Extra info (e.g. error message, counts)'
  },
  created_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  }
}, {
  tableName: 'import_log',
  timestamps: false,
  indexes: [
    { fields: ['source_file'] },
    { fields: ['created_at'] }
  ]
}) : null;

// Material library: central raw materials for analysis
const MaterialLibrary = sequelize ? sequelize.define('MaterialLibrary', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false,
    comment: 'Material name/code'
  },
  role: {
    type: DataTypes.STRING,
    allowNull: true,
    comment: 'Role in formulations (e.g. binder, solvent)'
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  created_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  },
  updated_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  }
}, {
  tableName: 'material_library',
  timestamps: false,
  indexes: [
    { unique: true, fields: ['name'] },
    { fields: ['role'] }
  ]
}) : null;

// Initialize database
async function initDb() {
  if (!sequelize) {
    let errorMsg = "Database connection not available. ";
    if (process.env.VERCEL) {
      errorMsg += "Set POSTGRES_URL in Vercel Project Settings → Environment Variables. Use Supabase pooler connection.";
    } else {
      errorMsg += "Set POSTGRES_URL or SUPABASE_DB_URL in your .env file.";
    }
    logger.error(errorMsg);
    throw new Error(errorMsg);
  }
  
  try {
    await sequelize.authenticate();
    logger.info("Database connection authenticated");
    await sequelize.sync({ alter: false }); // Use sync for simplicity, alter: false to avoid modifying existing tables
    logger.info("Database tables initialized successfully");
  } catch (e) {
    logger.error(`Error initializing database: ${e.message}`);
    logger.error(`Stack: ${e.stack}`);
    throw e;
  }
}

// Get database connection (for direct queries if needed)
function getDb() {
  return sequelize;
}

export {
  User,
  FilePermission,
  SearchHistory,
  ResearchSession,
  ResearchAuditLog,
  PolicyAuditLog,
  DecisionAuditLog,
  NoiseEvent,
  IntegrityCycleSnapshot,
  Violation,
  SystemSnapshot,
  ResearchLoopRun,
  JustificationTemplate,
  DoEDesign,
  ExperimentBatch,
  Experiment,
  EXPERIMENT_OUTCOMES,
  ImportLog,
  MaterialLibrary,
  sequelize,
  initDb,
  getDb,
  DATABASE_URL,
  getDatabaseUrl
};
