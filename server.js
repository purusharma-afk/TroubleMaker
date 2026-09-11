const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Pool } = require('pg');

function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}
loadEnv();

const port = Number(process.env.MEANT_TO_BREAK_API_PORT || 5181);
const databaseUrl = process.env.MEANT_TO_BREAK_DATABASE_URL;
const staticRoot = fs.existsSync(path.join(__dirname, 'public', 'index.html')) ? path.join(__dirname, 'public') : __dirname;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl, max: 5, connectionTimeoutMillis: 8000, idleTimeoutMillis: 30000 }) : null;
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
let dbReady = false;

const ids = prefix => `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
const json = (res, status, body, headers = {}) => { const value = JSON.stringify(body); res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', ...headers }); res.end(value); };
const noContent = res => { res.writeHead(204, { 'access-control-allow-origin': '*' }); res.end(); };
const readBody = req => new Promise((resolve, reject) => { let body = ''; req.on('data', chunk => { body += chunk; if (body.length > 1000000) req.destroy(); }); req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (error) { reject(error); } }); req.on('error', reject); });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function writeEvent(event) {
  if (!pool || !dbReady) return;
  await pool.query(`INSERT INTO meant_to_break_events (occurred_at, correlation_id, trace_id, span_id, parent_span_id, service, environment, method, endpoint, status_code, duration_ms, level, message, error_code, scenario, metadata) VALUES (COALESCE($1, NOW()), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`, [event.occurredAt || null, event.correlationId, event.traceId, event.spanId, event.parentSpanId || null, event.service, 'local-staging', event.method, event.endpoint, event.statusCode ?? null, event.durationMs ?? null, event.level, event.message, event.errorCode || null, event.scenario || null, event.metadata || {}]);
}

async function logEvent(ctx, values) {
  const event = { ...values, correlationId: ctx.correlationId, traceId: ctx.traceId, spanId: values.spanId || ids('span'), parentSpanId: values.parentSpanId || ctx.parentSpanId, method: values.method || ctx.method, endpoint: values.endpoint || ctx.endpoint };
  try { await writeEvent(event); } catch (error) { console.error('[log-write-failed]', error.message); }
  return event;
}

async function getOutageState() {
  if (!pool || !dbReady) throw new Error('database_not_ready');
  const result = await pool.query("SELECT outage_enabled, outage_reason, updated_at FROM meant_to_break_control WHERE control_key = 'global'");
  return result.rows[0] || { outage_enabled: false, outage_reason: 'Synthetic website outage', updated_at: null };
}

async function setOutageState(ctx, enabled, reason) {
  const result = await pool.query("UPDATE meant_to_break_control SET outage_enabled = $1, outage_reason = $2, updated_at = NOW() WHERE control_key = 'global' RETURNING outage_enabled, outage_reason, updated_at", [enabled, reason || 'Synthetic website outage']);
  const state = result.rows[0];
  await logEvent(ctx, { service: 'availability-control', level: enabled ? 'ERROR' : 'INFO', message: enabled ? 'Synthetic website outage enabled' : 'Synthetic website outage restored', statusCode: enabled ? 503 : 200, errorCode: enabled ? 'SYNTHETIC_OUTAGE' : 'SERVICE_RESTORED', scenario: 'availability', metadata: { reason: state.outage_reason } });
  return state;
}

async function callService(ctx, service, message, values = {}) { const child = { ...ctx, parentSpanId: ctx.spanId, spanId: ids('span') }; await logEvent(child, { service, level: values.level || 'INFO', message, statusCode: values.statusCode, durationMs: values.durationMs || 2, errorCode: values.errorCode, scenario: values.scenario, metadata: values.metadata }); return child; }
async function startRequest(req, url) { return { correlationId: req.headers['x-correlation-id'] || ids('cor'), traceId: req.headers['x-trace-id'] || ids('trace'), spanId: ids('span'), method: req.method, endpoint: url.pathname, parentSpanId: null }; }

const scenarios = {
  payment: { code: 'PAYMENT_PROVIDER', message: 'Payment provider is unavailable', userMessage: 'We could not process your payment. Please try again in a moment.' },
  search: { code: 'CATALOG_TIMEOUT', message: 'Catalog query exceeded its deadline', userMessage: 'Search is taking longer than expected. Please try again.' },
  profile: { code: 'PROFILE_CONFLICT', message: 'Optimistic version check failed', userMessage: 'Your profile was updated elsewhere. Refresh the page and try again.' },
  export: { code: 'EXPORT_WORKER', message: 'Export worker rejected a null filter payload', userMessage: 'We could not prepare your export. Please try again later.' },
  auth: { code: 'SESSION_REFRESH', message: 'Session cookie was not returned to the web origin', userMessage: 'Your session needs attention. Please sign in again.' },
};

async function route(req, res, url, body, ctx) {
  if (req.method === 'OPTIONS') return noContent(res);
  if (url.pathname === '/api/outage') {
    if (!['GET', 'POST'].includes(req.method)) return json(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });
    try {
      const current = await getOutageState();
      if (req.method === 'GET') return json(res, 200, { ok: true, ...current });
      const enabled = typeof body.enabled === 'boolean' ? body.enabled : !current.outage_enabled;
      const reason = String(body.reason || 'Synthetic website outage').slice(0, 240);
      return json(res, 200, { ok: true, ...(await setOutageState(ctx, enabled, reason)) });
    } catch (error) {
      return json(res, 503, { ok: false, error: 'DATABASE_NOT_READY' });
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/health') {
    if (!dbReady) return json(res, 503, { ok: false, healthy: false, database: false, error: 'DATABASE_NOT_READY' });
    const outage = await getOutageState();
    if (outage.outage_enabled) return json(res, 503, { ok: false, healthy: false, database: true, error: 'SYNTHETIC_OUTAGE', outageSimulation: true });
    return json(res, 200, { ok: true, healthy: true, database: true, service: 'meant-to-break-api', environment: 'local-staging' });
  }
  if (req.method === 'GET' && url.pathname === '/api/logs') {
    if (!pool || !dbReady) return json(res, 503, { ok: false, error: 'database_not_ready' });
    const result = await pool.query('SELECT * FROM meant_to_break_events ORDER BY occurred_at DESC LIMIT 200');
    return json(res, 200, { ok: true, events: result.rows });
  }
  if (url.pathname.startsWith('/api/')) {
    try {
      const outage = await getOutageState();
      if (outage.outage_enabled) {
        await logEvent(ctx, { service: 'availability-gate', level: 'ERROR', message: 'Request rejected while synthetic website outage is enabled', statusCode: 503, errorCode: 'SYNTHETIC_OUTAGE', scenario: 'availability', metadata: { reason: outage.outage_reason } });
        return json(res, 503, { ok: false, healthy: false, error: 'SYNTHETIC_OUTAGE', message: 'The service is temporarily unavailable.', correlationId: ctx.correlationId, outageSimulation: true });
      }
    } catch (error) {
      // The normal route handlers return their existing database-not-ready response.
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/events') {
    await logEvent(ctx, { service: body.service || 'browser', level: body.level || 'INFO', message: body.message || 'browser event', statusCode: body.statusCode || 200, durationMs: body.durationMs || 0, errorCode: body.errorCode, scenario: body.scenario, metadata: body.metadata || {} });
    return json(res, 202, { ok: true, correlationId: ctx.correlationId, traceId: ctx.traceId });
  }
  if (req.method === 'POST' && url.pathname === '/api/support') {
    await logEvent(ctx, { service: 'support-web', message: 'support form accepted', statusCode: 202, metadata: { body_keys: Object.keys(body || {}) } });
    await callService(ctx, 'support-api', 'support ticket created', { statusCode: 201 });
    return json(res, 201, { ok: true, correlationId: ctx.correlationId });
  }

  if (req.method === 'GET' && url.pathname === '/api/search') {
    const query = url.searchParams.get('q') || '';
    await logEvent(ctx, { service: 'search-ui', message: `search submitted q=${query}`, statusCode: 200, metadata: { query } });
    const catalog = await callService(ctx, 'catalog-api', 'search query accepted', { metadata: { query } });
    await wait(35);
    await logEvent(catalog, { service: 'postgres', level: 'WARN', message: 'product search query exceeded 2000ms', statusCode: 504, durationMs: 2000, errorCode: scenarios.search.code, scenario: 'search', metadata: { query, query_plan: 'sequential scan' } });
    await logEvent(ctx, { service: 'catalog-api', level: 'ERROR', message: scenarios.search.message, statusCode: 504, durationMs: 2042, errorCode: scenarios.search.code, scenario: 'search' });
    return json(res, 504, { ok: false, error: scenarios.search.code, message: scenarios.search.userMessage, correlationId: ctx.correlationId });
  }

  const handlers = {
    '/api/checkout': { service: 'checkout-api', scenario: 'payment', status: 502, upstream: ['payments-worker', 'stripe-adapter'] },
    '/api/profile': { service: 'profile-api', scenario: 'profile', status: 409, upstream: ['postgres'] },
    '/api/exports': { service: 'export-api', scenario: 'export', status: 500, upstream: ['queue', 'export-worker'] },
    '/api/session/refresh': { service: 'identity-web', scenario: 'auth', status: 401, upstream: ['identity-api', 'session-store'] },
  };
  const handler = handlers[url.pathname];
  if (handler && req.method !== 'GET') {
    await logEvent(ctx, { service: handler.service, message: `${req.method} ${url.pathname} accepted`, statusCode: 202, metadata: { body_keys: Object.keys(body || {}) } });
    let parent = ctx;
    for (const service of handler.upstream) parent = await callService(parent, service, `${handler.scenario} downstream call`, { level: service === handler.upstream.at(-1) ? 'ERROR' : 'WARN', statusCode: handler.status, durationMs: 18, errorCode: scenarios[handler.scenario].code, scenario: handler.scenario });
    await logEvent(ctx, { service: handler.service, level: 'ERROR', message: scenarios[handler.scenario].message, statusCode: handler.status, durationMs: handler.status === 504 ? 2042 : 110, errorCode: scenarios[handler.scenario].code, scenario: handler.scenario });
    return json(res, handler.status, { ok: false, error: scenarios[handler.scenario].code, message: scenarios[handler.scenario].userMessage, correlationId: ctx.correlationId });
  }
  return json(res, 404, { ok: false, error: 'not_found' });
}

async function initialize() {
  if (!pool) { console.error('MEANT_TO_BREAK_DATABASE_URL is missing'); return; }
  try { await pool.query(schema); dbReady = true; console.log('PostgreSQL log store ready'); } catch (error) { console.error(`PostgreSQL unavailable: ${error.message}`); }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      const ctx = await startRequest(req, url);
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
      return await route(req, res, url, body, ctx);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { ok: false, error: 'method_not_allowed' });
    const requested = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.join(staticRoot, requested);
    if (!file.startsWith(staticRoot) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return json(res, 404, { ok: false, error: 'not_found' });
    const ext = path.extname(file); const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
    res.writeHead(200, { 'content-type': `${types[ext] || 'application/octet-stream'}; charset=utf-8` }); res.end(fs.readFileSync(file));
  } catch (error) { console.error('[request-error]', error); if (!res.headersSent) json(res, 500, { ok: false, error: 'internal_server_error' }); }
});

initialize().finally(() => server.listen(port, '127.0.0.1', () => console.log(`Meant to Break API listening on http://127.0.0.1:${port}`)));
