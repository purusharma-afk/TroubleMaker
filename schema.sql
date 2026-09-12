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

CREATE TABLE IF NOT EXISTS meant_to_break_catalog (
  id BIGSERIAL PRIMARY KEY,
  product_name TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL,
  price NUMERIC(10, 2) NOT NULL
);

INSERT INTO meant_to_break_catalog (product_name, category, price)
VALUES
  ('Ridgeline Trail Pack', 'Travel', 128.00),
  ('Field Jacket No. 7', 'Apparel', 184.00),
  ('Enamel Camp Mug', 'Camp', 24.00),
  ('Ridge Lantern', 'Camp', 68.00)
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS meant_to_break_profiles (
  id INTEGER PRIMARY KEY,
  display_name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);

INSERT INTO meant_to_break_profiles (id, display_name, version)
VALUES (1, 'Puru Sharma', 1)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS meant_to_break_control (
  control_key TEXT PRIMARY KEY,
  outage_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  outage_reason TEXT NOT NULL DEFAULT 'Synthetic website outage',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO meant_to_break_control (control_key)
VALUES ('global')
ON CONFLICT (control_key) DO NOTHING;
