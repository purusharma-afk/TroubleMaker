const crypto = require('node:crypto');
const { Pool } = require('pg');

const pool = globalThis.__MEANT_TO_BREAK_POOL || new Pool({ connectionString: process.env.MEANT_TO_BREAK_DATABASE_URL, max: 2, connectionTimeoutMillis: 8000, idleTimeoutMillis: 30000 });
globalThis.__MEANT_TO_BREAK_POOL = pool;
const schemaReady = globalThis.__MEANT_TO_BREAK_SCHEMA || pool.query(`
  CREATE TABLE IF NOT EXISTS meant_to_break_events (
    id BIGSERIAL PRIMARY KEY, occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), correlation_id TEXT NOT NULL,
    trace_id TEXT NOT NULL, span_id TEXT NOT NULL, parent_span_id TEXT, service TEXT NOT NULL,
    environment TEXT NOT NULL DEFAULT 'vercel-staging', method TEXT NOT NULL, endpoint TEXT NOT NULL,
    status_code INTEGER, duration_ms INTEGER, level TEXT NOT NULL, message TEXT NOT NULL,
    error_code TEXT, scenario TEXT, metadata JSONB NOT NULL DEFAULT '{}'::jsonb
  );
  CREATE INDEX IF NOT EXISTS idx_mtb_events_correlation ON meant_to_break_events (correlation_id, occurred_at);
  CREATE INDEX IF NOT EXISTS idx_mtb_events_occurred_at ON meant_to_break_events (occurred_at DESC);
`).catch(error => { globalThis.__MEANT_TO_BREAK_SCHEMA = null; throw error; });
globalThis.__MEANT_TO_BREAK_SCHEMA = schemaReady;

const id = prefix => `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
const json = (res, status, body) => res.status(status).json(body);
const context = req => ({ correlationId: req.headers['x-correlation-id'] || id('cor'), traceId: req.headers['x-trace-id'] || id('trace'), spanId: id('span'), parentSpanId: null, method: req.method, endpoint: req.url.split('?')[0] });
async function logEvent(ctx, values) { await schemaReady; await pool.query(`INSERT INTO meant_to_break_events (correlation_id, trace_id, span_id, parent_span_id, service, environment, method, endpoint, status_code, duration_ms, level, message, error_code, scenario, metadata) VALUES ($1,$2,$3,$4,$5,'vercel-staging',$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [ctx.correlationId, ctx.traceId, values.spanId || ctx.spanId, values.parentSpanId || ctx.parentSpanId, values.service, values.method || ctx.method, values.endpoint || ctx.endpoint, values.statusCode ?? null, values.durationMs ?? null, values.level || 'INFO', values.message, values.errorCode || null, values.scenario || null, values.metadata || {}]); }
async function child(ctx, service, message, values = {}) { const next = { ...ctx, parentSpanId: ctx.spanId, spanId: id('span') }; await logEvent(next, { service, message, ...values }); return next; }
async function body(req) { return req.body && typeof req.body === 'object' ? req.body : {}; }
async function fail(req, res, scenario, status, service, downstream) { const ctx = context(req); const input = { payment: ['PAYMENT_PROVIDER', 'Payment provider is unavailable', 'We could not process your payment. Please try again in a moment.'], profile: ['PROFILE_CONFLICT', 'Optimistic version check failed', 'Your profile was updated elsewhere. Refresh the page and try again.'], export: ['EXPORT_WORKER', 'Export worker rejected a null filter payload', 'We could not prepare your export. Please try again later.'], auth: ['SESSION_REFRESH', 'Session cookie was not returned to the web origin', 'Your session needs attention. Please sign in again.'] }[scenario]; await logEvent(ctx, { service, message: `${req.method} ${ctx.endpoint} accepted`, statusCode: 202, metadata: { body_keys: Object.keys(await body(req)) } }); let parent = ctx; for (const name of downstream) parent = await child(parent, name, `${scenario} downstream call`, { level: name === downstream.at(-1) ? 'ERROR' : 'WARN', statusCode: status, durationMs: 18, errorCode: input[0], scenario }); await logEvent(ctx, { service, level: 'ERROR', message: input[1], statusCode: status, durationMs: 110, errorCode: input[0], scenario }); return json(res, status, { ok: false, error: input[0], message: input[2], correlationId: ctx.correlationId }); }
module.exports = { pool, schemaReady, id, json, context, logEvent, child, body, fail };
