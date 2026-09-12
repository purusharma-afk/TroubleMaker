const crypto = require('node:crypto');
const { Pool } = require('pg');
const { diagnosticMetadata, runtimeDiagnosticMetadata } = require('./diagnostics');

const schemaSql = `
  CREATE TABLE IF NOT EXISTS meant_to_break_events (
    id BIGSERIAL PRIMARY KEY,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    correlation_id TEXT NOT NULL,
    trace_id TEXT NOT NULL,
    span_id TEXT NOT NULL,
    parent_span_id TEXT,
    service TEXT NOT NULL,
    environment TEXT NOT NULL DEFAULT 'vercel-staging',
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
`;

function getPool() {
  if (!process.env.MEANT_TO_BREAK_DATABASE_URL) throw new Error('MEANT_TO_BREAK_DATABASE_URL is not configured');
  if (!globalThis.__MEANT_TO_BREAK_POOL) {
    globalThis.__MEANT_TO_BREAK_POOL = new Pool({
      connectionString: process.env.MEANT_TO_BREAK_DATABASE_URL,
      max: 2,
      connectionTimeoutMillis: 8000,
      idleTimeoutMillis: 30000,
    });
  }
  return globalThis.__MEANT_TO_BREAK_POOL;
}

async function ensureSchema() {
  if (!globalThis.__MEANT_TO_BREAK_SCHEMA) {
    globalThis.__MEANT_TO_BREAK_SCHEMA = getPool().query(schemaSql).catch(error => {
      globalThis.__MEANT_TO_BREAK_SCHEMA = null;
      throw error;
    });
  }
  return globalThis.__MEANT_TO_BREAK_SCHEMA;
}

const id = prefix => `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
function json(res, status, body) {
  if (typeof res.status === 'function' && typeof res.json === 'function') return res.status(status).json(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.end(JSON.stringify(body));
}
const context = req => ({
  correlationId: req.headers['x-correlation-id'] || id('cor'),
  traceId: req.headers['x-trace-id'] || id('trace'),
  spanId: id('span'),
  parentSpanId: null,
  method: req.method,
  endpoint: req.url.split('?')[0],
});

async function getOutageState() {
  await ensureSchema();
  const result = await getPool().query(
    `SELECT outage_enabled, outage_reason, updated_at
     FROM meant_to_break_control
     WHERE control_key = 'global'`,
  );
  return result.rows[0] || { outage_enabled: false, outage_reason: 'Synthetic website outage', updated_at: null };
}

async function setOutageState(ctx, enabled, reason) {
  await ensureSchema();
  const result = await getPool().query(
    `UPDATE meant_to_break_control
     SET outage_enabled = $1, outage_reason = $2, updated_at = NOW()
     WHERE control_key = 'global'
     RETURNING outage_enabled, outage_reason, updated_at`,
    [enabled, reason || 'Synthetic website outage'],
  );
  const state = result.rows[0];
  await logEvent(ctx, {
    service: 'availability-control',
    level: enabled ? 'ERROR' : 'INFO',
    message: enabled ? 'Synthetic website outage enabled' : 'Synthetic website outage restored',
    statusCode: enabled ? 503 : 200,
    errorCode: enabled ? 'SYNTHETIC_OUTAGE' : 'SERVICE_RESTORED',
    scenario: 'availability',
    metadata: { reason: state.outage_reason },
  });
  return state;
}

async function outageResponse(req, res) {
  try {
    const state = await getOutageState();
    if (!state.outage_enabled) return false;
    const ctx = context(req);
    try {
      await logEvent(ctx, {
        service: 'availability-gate',
        level: 'ERROR',
        message: 'Request rejected while synthetic website outage is enabled',
        statusCode: 503,
        errorCode: 'SYNTHETIC_OUTAGE',
        scenario: 'availability',
        metadata: { reason: state.outage_reason },
      });
    } catch (error) {
      console.error('[outage-log-failed]', error.message);
    }
    json(res, 503, {
      ok: false,
      healthy: false,
      error: 'SYNTHETIC_OUTAGE',
      message: 'The service is temporarily unavailable.',
      correlationId: ctx.correlationId,
      outageSimulation: true,
    });
    return true;
  } catch (error) {
    return false;
  }
}

async function logEvent(ctx, values) {
  await ensureSchema();
  await getPool().query(
    `INSERT INTO meant_to_break_events
      (correlation_id, trace_id, span_id, parent_span_id, service, environment,
       method, endpoint, status_code, duration_ms, level, message, error_code,
       scenario, metadata)
     VALUES ($1,$2,$3,$4,$5,'vercel-staging',$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      ctx.correlationId,
      ctx.traceId,
      values.spanId || ctx.spanId,
      values.parentSpanId || ctx.parentSpanId,
      values.service,
      values.method || ctx.method,
      values.endpoint || ctx.endpoint,
      values.statusCode ?? null,
      values.durationMs ?? null,
      values.level || 'INFO',
      values.message,
      values.errorCode || null,
      values.scenario || null,
      diagnosticMetadata(values),
    ],
  );
}

async function logException(ctx, error, values = {}) {
  return logEvent(ctx, {
    service: values.service || 'application',
    level: 'ERROR',
    message: values.message || error?.message || 'Unhandled application error',
    statusCode: values.statusCode || 500,
    durationMs: values.durationMs,
    errorCode: values.errorCode || error?.code || 'APPLICATION_ERROR',
    scenario: values.scenario,
    metadata: runtimeDiagnosticMetadata(error, values),
  });
}

async function child(ctx, service, message, values = {}) {
  const next = { ...ctx, parentSpanId: ctx.spanId, spanId: id('span') };
  await logEvent(next, { service, message, ...values });
  return next;
}

async function body(req) { return req.body && typeof req.body === 'object' ? req.body : {}; }

module.exports = {
  getPool,
  ensureSchema,
  id,
  json,
  context,
  logEvent,
  logException,
  child,
  body,
  getOutageState,
  setOutageState,
  outageResponse,
};
