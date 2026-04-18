-- Run once in Supabase SQL editor if `experiments` already exists without this column.
ALTER TABLE experiments
  ADD COLUMN IF NOT EXISTS experiment_date DATE;
