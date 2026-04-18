-- Task H: run once in Supabase SQL editor (or psql) if table does not exist.
CREATE TABLE IF NOT EXISTS whatsapp_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_number TEXT NOT NULL,
  message TEXT NOT NULL,
  received_at TIMESTAMPTZ DEFAULT NOW(),
  status TEXT DEFAULT 'PENDING'
);
