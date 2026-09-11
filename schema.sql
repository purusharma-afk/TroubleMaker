CREATE TABLE IF NOT EXISTS meant_to_break_events (
  id BIGSERIAL PRIMARY KEY,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  correlation_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  span_id TEXT NOT NULL,
  parent_span_id TEXT,
  service TEXT NOT NULL,
  environment TEXT NOT NULL DEFAULT 'local-staging',
  method TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  status_code INTEGER,
  duration_ms INTEGER,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  error_code TEXT,
  scenario TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_mtb_events_correlation ON meant_to_break_events (correlation_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_mtb_events_occurred_at ON meant_to_break_events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_mtb_events_service ON meant_to_break_events (service, occurred_at DESC);
