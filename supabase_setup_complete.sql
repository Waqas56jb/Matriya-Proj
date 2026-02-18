-- ============================================================================
-- Supabase Setup SQL - Run this in Supabase SQL Editor
-- ============================================================================

-- Step 1: Enable pgvector extension (REQUIRED for vector storage)
CREATE EXTENSION IF NOT EXISTS vector;

-- Step 2: Create users table (for authentication)
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username VARCHAR UNIQUE NOT NULL,
    email VARCHAR UNIQUE NOT NULL,
    hashed_password VARCHAR NOT NULL,
    full_name VARCHAR,
    is_active BOOLEAN DEFAULT TRUE,
    is_admin BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_login TIMESTAMP
);

-- Step 3: Create indexes for users table (for faster lookups)
CREATE INDEX IF NOT EXISTS users_username_idx ON users(username);
CREATE INDEX IF NOT EXISTS users_email_idx ON users(email);

-- Step 4: Create documents table (for vector storage)
-- Note: The embedding dimension (384) matches all-MiniLM-L6-v2 model
-- If you use a different model, change the dimension accordingly
CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    embedding vector(384),
    document TEXT NOT NULL,
    metadata JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Step 5: Create vector index for similarity search (IMPORTANT for performance)
CREATE INDEX IF NOT EXISTS documents_embedding_idx 
ON documents 
USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);

-- Step 6: Create index on metadata for faster filtering
CREATE INDEX IF NOT EXISTS documents_metadata_idx 
ON documents 
USING GIN (metadata);

-- Step 7: Create index on metadata->filename for file filtering
CREATE INDEX IF NOT EXISTS documents_metadata_filename_idx 
ON documents 
USING BTREE ((metadata->>'filename'));

-- Step 8: Create file_permissions table (for user file access control)
CREATE TABLE IF NOT EXISTS file_permissions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    filename VARCHAR NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Step 9: Create indexes for file_permissions table
CREATE INDEX IF NOT EXISTS file_permissions_user_id_idx ON file_permissions(user_id);
CREATE INDEX IF NOT EXISTS file_permissions_filename_idx ON file_permissions(filename);

-- Step 10: Create search_history table (questions and answers from users for admin view)
CREATE TABLE IF NOT EXISTS search_history (
    id SERIAL PRIMARY KEY,
    user_id INTEGER,
    username VARCHAR,
    question TEXT NOT NULL,
    answer TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS search_history_created_at_idx ON search_history(created_at DESC);
CREATE INDEX IF NOT EXISTS search_history_user_id_idx ON search_history(user_id);

-- Step 11: Research sessions and audit log (Stage 1 – FSM K→C→B→N→L)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE TABLE IF NOT EXISTS research_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id INTEGER,
    completed_stages TEXT[] DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS research_audit_log (
    id SERIAL PRIMARY KEY,
    session_id UUID NOT NULL REFERENCES research_sessions(id) ON DELETE CASCADE,
    stage VARCHAR(10) NOT NULL,
    response_type VARCHAR(50),
    request_query TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS research_audit_log_session_id_idx ON research_audit_log(session_id);
CREATE INDEX IF NOT EXISTS research_audit_log_created_at_idx ON research_audit_log(created_at);

-- Step 12: B-Integrity Monitor – cycle snapshots and violations
CREATE TABLE IF NOT EXISTS integrity_cycle_snapshots (
    id SERIAL PRIMARY KEY,
    session_id UUID NOT NULL REFERENCES research_sessions(id) ON DELETE CASCADE,
    stage VARCHAR(10) NOT NULL,
    cycle_index INTEGER NOT NULL DEFAULT 0,
    metric_name VARCHAR(50) NOT NULL DEFAULT 'document_count',
    metric_value INTEGER NOT NULL,
    details JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS integrity_cycle_snapshots_session_id_idx ON integrity_cycle_snapshots(session_id);
CREATE INDEX IF NOT EXISTS integrity_cycle_snapshots_created_at_idx ON integrity_cycle_snapshots(created_at);

CREATE TABLE IF NOT EXISTS violations (
    id SERIAL PRIMARY KEY,
    session_id UUID NOT NULL REFERENCES research_sessions(id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL DEFAULT 'B_INTEGRITY',
    reason TEXT,
    details JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    resolved_at TIMESTAMP,
    resolved_by INTEGER,
    resolve_note TEXT
);
CREATE INDEX IF NOT EXISTS violations_session_id_idx ON violations(session_id);
CREATE INDEX IF NOT EXISTS violations_resolved_at_idx ON violations(resolved_at);

-- Step 12b: System Snapshots – save/restore integrity state
CREATE TABLE IF NOT EXISTS system_snapshots (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    snapshot_type VARCHAR(50) NOT NULL DEFAULT 'integrity',
    payload JSONB NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by INTEGER
);
CREATE INDEX IF NOT EXISTS system_snapshots_created_at_idx ON system_snapshots(created_at DESC);
CREATE INDEX IF NOT EXISTS system_snapshots_snapshot_type_idx ON system_snapshots(snapshot_type);

-- Step 13: Research Loop MVP – runs of the 4-agent loop
CREATE TABLE IF NOT EXISTS research_loop_runs (
    id SERIAL PRIMARY KEY,
    session_id UUID NOT NULL REFERENCES research_sessions(id) ON DELETE CASCADE,
    query TEXT NOT NULL,
    outputs JSONB DEFAULT '{}',
    justifications JSONB DEFAULT '[]',
    stopped_by_violation BOOLEAN NOT NULL DEFAULT FALSE,
    violation_id INTEGER REFERENCES violations(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS research_loop_runs_session_id_idx ON research_loop_runs(session_id);
CREATE INDEX IF NOT EXISTS research_loop_runs_created_at_idx ON research_loop_runs(created_at);

-- Step 14: Justification templates (labels/descriptions for research loop justifications)
CREATE TABLE IF NOT EXISTS justification_templates (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    reason_code VARCHAR(100) NOT NULL UNIQUE,
    label VARCHAR(255),
    description TEXT,
    template_text TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS justification_templates_reason_code_idx ON justification_templates(reason_code);

-- Step 15: DoE designs (Design of Experiments integration)
CREATE TABLE IF NOT EXISTS doe_designs (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    design JSONB NOT NULL DEFAULT '[]',
    query_template TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS doe_designs_created_at_idx ON doe_designs(created_at DESC);

-- ============================================================================
-- Verification Queries (optional - run to check everything is set up)
-- ============================================================================

-- Check if pgvector is enabled:
-- SELECT * FROM pg_extension WHERE extname = 'vector';

-- Check if tables exist:
-- SELECT table_name FROM information_schema.tables 
-- WHERE table_schema = 'public' AND table_name IN ('users', 'documents', 'file_permissions', 'search_history', 'research_sessions', 'research_audit_log', 'integrity_cycle_snapshots', 'violations', 'system_snapshots', 'research_loop_runs', 'justification_templates', 'doe_designs');

-- Check if indexes exist:
-- SELECT indexname FROM pg_indexes 
-- WHERE tablename IN ('users', 'documents');

-- ============================================================================
-- Done! Your tables are ready.
-- ============================================================================
