-- Milestone 1 & 2: Twilio WhatsApp ticket log
-- Run once in Supabase SQL editor (or psql).

CREATE TABLE IF NOT EXISTS twilio_tickets (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number     VARCHAR(50)  NOT NULL,
  direction        VARCHAR(20)  NOT NULL CHECK (direction IN ('inbound', 'outbound', 'outbound_action')),
  message          TEXT,
  pipeline_result  JSONB,
  action_package   JSONB,
  parent_ticket_id UUID         REFERENCES twilio_tickets(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_twilio_tickets_phone      ON twilio_tickets(phone_number);
CREATE INDEX IF NOT EXISTS idx_twilio_tickets_direction  ON twilio_tickets(direction);
CREATE INDEX IF NOT EXISTS idx_twilio_tickets_created_at ON twilio_tickets(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_twilio_tickets_parent     ON twilio_tickets(parent_ticket_id);
