-- Migration: experiments new columns + import_log + experiment_batches + material_library
-- Run in Supabase SQL Editor if you already have the experiments table (e.g. created by Sequelize).

-- 1. Add columns to experiments (if table exists)
ALTER TABLE experiments ADD COLUMN IF NOT EXISTS experiment_version VARCHAR(255);
ALTER TABLE experiments ADD COLUMN IF NOT EXISTS source_file_reference VARCHAR(1024);
ALTER TABLE experiments ADD COLUMN IF NOT EXISTS experiment_batch_id INTEGER;

-- 2. experiment_batches (research sessions)
CREATE TABLE IF NOT EXISTS experiment_batches (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255),
  description TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 3. import_log
CREATE TABLE IF NOT EXISTS import_log (
  id SERIAL PRIMARY KEY,
  source_file VARCHAR(1024) NOT NULL,
  source_type VARCHAR(64) DEFAULT 'sharepoint',
  created_entity_type VARCHAR(64),
  created_entity_id VARCHAR(255),
  status VARCHAR(32) NOT NULL DEFAULT 'success',
  details JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS import_log_source_file_idx ON import_log(source_file);
CREATE INDEX IF NOT EXISTS import_log_created_at_idx ON import_log(created_at);

-- 4. material_library
CREATE TABLE IF NOT EXISTS material_library (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL UNIQUE,
  role VARCHAR(255),
  description TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS material_library_role_idx ON material_library(role);

-- Optional: FK from experiments to experiment_batches (if you want referential integrity)
-- ALTER TABLE experiments ADD CONSTRAINT fk_experiment_batch
--   FOREIGN KEY (experiment_batch_id) REFERENCES experiment_batches(id) ON DELETE SET NULL;
