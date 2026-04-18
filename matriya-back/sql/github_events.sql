-- Task: GitHub webhook event log
-- Run once in Supabase SQL editor (or psql).

CREATE TABLE IF NOT EXISTS github_events (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  repo           TEXT,
  branch         TEXT,
  commit_message TEXT,
  pusher         TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_github_events_repo       ON github_events(repo);
CREATE INDEX IF NOT EXISTS idx_github_events_created_at ON github_events(created_at DESC);
