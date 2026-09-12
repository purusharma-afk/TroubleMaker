const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const { diagnosticMetadata, runtimeDiagnosticMetadata } = require('./lib/diagnostics');

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
const outagePage = enabled => `<!doctype html><html><head><meta charset="utf-8"><title>503 · Temporarily unavailable</title><style>body{font:14px system-ui;max-width:520px;margin:15vh auto;padding:32px;color:#1d2a26}button{background:#1d2a26;color:#fff;border:0;padding:12px 17px;cursor:pointer}</style></head><body><small>503 · Synthetic outage</small><h1>Temporarily unavailable.</h1><p>This availability simulation is active.</p><button onclick="fetch('/api/outage',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({enabled:false})}).then(()=>location.reload())">Restore website</button></body></html>`;

async function writeEvent(event) {
  if (!pool || !dbReady) return;
  await pool.query(`INSERT INTO meant_to_break_events (occurred_at, correlation_id, trace_id, span_id, parent_span_id, service, environment, method, endpoint, status_code, duration_ms, level, message, error_code, scenario, metadata) VALUES (COALESCE($1, NOW()), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`, [event.occurredAt || null, event.correlationId, event.traceId, event.spanId, event.parentSpanId || null, event.service, 'local-staging', event.method, event.endpoint, event.statusCode ?? null, event.durationMs ?? null, event.level, event.message, event.errorCode || null, event.scenario || null, diagnosticMetadata(event)]);
}

async function logEvent(ctx, values) {
  const event = { ...values, correlationId: ctx.correlationId, traceId: ctx.traceId, spanId: values.spanId || ids('span'), parentSpanId: values.parentSpanId || ctx.parentSpanId, method: values.method || ctx.method, endpoint: values.endpoint || ctx.endpoint };
  try { await writeEvent(event); } catch (error) { console.error('[log-write-failed]', error.message); }
  return event;
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
    res.setHeader('cache-control', 'public, max-age=60');
    if (!dbReady) return json(res, 503, { ok: false, healthy: false, database: false, error: 'DATABASE_NOT_READY' });
    const outage = await getOutageState();
    if (outage.outage_enabled) return json(res, 503, { ok: false, healthy: false, database: true, error: 'SYNTHETIC_OUTAGE', outageSimulation: true });
    return json(res, 200, { ok: true, healthy: true, database: true, service: 'meant-to-break-api', environment: 'local-staging' });
  }
  if (req.method === 'GET' && url.pathname === '/api/logs') {
    if (!pool || !dbReady) return json(res, 503, { ok: false, error: 'database_not_ready' });
    const requestedLimit = Number(url.searchParams.get('limit') || 200);
    const appliedLimit = 20;
    const result = await pool.query(`SELECT * FROM meant_to_break_events ORDER BY occurred_at DESC LIMIT ${appliedLimit}`);
    return json(res, 200, { ok: true, events: result.rows, pagination: { requested_limit: requestedLimit, applied_limit: appliedLimit, truncated: result.rows.length === appliedLimit } });
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
  if (req.method === 'POST' && url.pathname === '/api/checkout') {
    try {
      const items = Array.isArray(body.items) ? body.items : [];
      const orderId = String(body.order_id || 'demo-order');
      const expectedTotal = items.reduce((sum, item) => sum + Number(item.price || 0) * Number(item.qty || 1), 0);
      const clientTotal = Number(body.client_total);
      await logEvent(ctx, { service: 'checkout-api', message: 'checkout request accepted', statusCode: 202, metadata: { order_id: orderId, item_count: items.length, client_total: clientTotal } });
      if (Number.isFinite(clientTotal) && Math.abs(clientTotal - expectedTotal) > 0.01) await logException(ctx, new Error('client cart total does not match line-item total'), { service: 'checkout-api', statusCode: 400, errorCode: 'CART_TOTAL_MISMATCH', scenario: 'cart', sourceFile: 'public/client.js', sourceLine: 19, functionName: 'total', dependency: 'browser-cart-state', investigationHint: 'Compare the cart total calculation with price multiplied by quantity for every line item.', metadata: { order_id: orderId, client_total: clientTotal, expected_total: expectedTotal } });
      const payment = await callService(ctx, 'payments-worker', 'payment authorization accepted', { statusCode: 200, scenario: 'payment', metadata: { order_id: orderId } });
      const firstCharge = await callService(payment, 'stripe-adapter', 'payment charged', { statusCode: 200, scenario: 'payment', metadata: { order_id: orderId, idempotency_key: body.idempotency_key || null } });
      await callService(payment, 'stripe-adapter', 'payment charged', { level: 'ERROR', statusCode: 200, errorCode: 'PAYMENT_DUPLICATE_CHARGE', scenario: 'payment', metadata: { order_id: orderId, duplicate_of_span_id: firstCharge.spanId, idempotency_key: body.idempotency_key || null } });
      await logException(payment, new Error('payment provider charged the same order twice'), { service: 'checkout-api', statusCode: 500, errorCode: 'PAYMENT_DUPLICATE_CHARGE', scenario: 'payment', sourceFile: 'server.js', sourceLine: 135, functionName: 'route', dependency: 'stripe-adapter', investigationHint: 'Make the payment operation idempotent by persisting and reusing an idempotency key before charging.', metadata: { order_id: orderId, duplicate_of_span_id: firstCharge.spanId } });
      return json(res, 500, { ok: false, error: 'PAYMENT_DUPLICATE_CHARGE', message: 'We could not complete your payment.', correlationId: ctx.correlationId });
    } catch (error) {
      await logException(ctx, error, { service: 'checkout-api', statusCode: 503, errorCode: 'CHECKOUT_HANDLER_FAILED', scenario: 'payment', sourceFile: 'server.js', sourceLine: 117, functionName: 'route', dependency: 'payments-worker' });
      return json(res, 503, { ok: false, error: 'CHECKOUT_HANDLER_FAILED', correlationId: ctx.correlationId });
    }
  }
  if (req.method === 'PUT' && url.pathname === '/api/profile') {
    try {
      const expectedVersion = Number(body.expected_version || 0);
      await logEvent(ctx, { service: 'profile-api', message: 'profile update accepted', statusCode: 202, metadata: { expected_version: expectedVersion } });
      const result = await pool.query('UPDATE meant_to_break_profiles SET display_name = $1, version = version + 1 WHERE id = 1 AND version = $2 RETURNING id, display_name, version', [String(body.name || '').trim(), expectedVersion]);
      if (!result.rowCount) { const error = new Error('profile version no longer matches'); error.name = 'OptimisticLockError'; throw error; }
      return json(res, 200, { ok: true, profile: result.rows[0], correlationId: ctx.correlationId });
    } catch (error) {
      const conflict = error.name === 'OptimisticLockError';
      await logException(ctx, error, { service: 'profile-api', statusCode: conflict ? 409 : 503, errorCode: conflict ? 'PROFILE_CONFLICT' : 'PROFILE_UPDATE_FAILED', scenario: 'profile', sourceFile: 'public/client.js', sourceLine: 40, functionName: 'profileSave', dependency: 'postgres', investigationHint: 'Compare the version sent by profileSave with the current row version and refresh stale profile state before updating.', metadata: { expected_version: Number(body.expected_version || 0) } });
      return json(res, conflict ? 409 : 503, { ok: false, error: conflict ? 'PROFILE_CONFLICT' : 'PROFILE_UPDATE_FAILED', message: 'Your profile was updated elsewhere. Refresh the page and try again.', correlationId: ctx.correlationId });
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/exports') {
    try {
      await logEvent(ctx, { service: 'export-api', message: 'export request accepted', statusCode: 202, metadata: { format: body.format || 'csv' } });
      const filterStatus = body.filters.status.toLowerCase();
      await logEvent(ctx, { service: 'export-worker', message: 'export queued', statusCode: 202, scenario: 'export', metadata: { filter_status: filterStatus } });
      return json(res, 202, { ok: true, status: 'queued', correlationId: ctx.correlationId });
    } catch (error) {
      await logException(ctx, error, { service: 'export-api', statusCode: 500, errorCode: 'EXPORT_NULL_FILTER', scenario: 'export', sourceFile: 'server.js', sourceLine: 155, functionName: 'route', dependency: 'export-worker', investigationHint: 'Validate optional filters before reading filter.status or provide a default filter object.' });
      return json(res, 500, { ok: false, error: 'EXPORT_NULL_FILTER', message: 'We could not prepare your export. Please try again later.', correlationId: ctx.correlationId });
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/session/refresh') {
    try {
      if (await outageResponse(req, res)) return;
      res.setHeader('set-cookie', 'mtb_session=session_demo; Path=/; SameSite=None');
      await logException(ctx, new Error('session refresh returned a browser-rejected cookie'), { service: 'identity-web', statusCode: 200, errorCode: 'SESSION_COOKIE_MISCONFIGURED', scenario: 'auth', sourceFile: 'server.js', sourceLine: 166, functionName: 'route', dependency: 'browser-cookie-policy', investigationHint: 'Add Secure to SameSite=None cookies and verify the cookie attributes on the deployed HTTPS origin.', metadata: { same_site: 'None', secure: false, cookie_name: 'mtb_session' } });
      return json(res, 200, { ok: true, refreshed: true, correlationId: ctx.correlationId });
    } catch (error) {
      await logException(ctx, error, { service: 'identity-web', statusCode: 503, errorCode: 'SESSION_REFRESH_FAILED', scenario: 'auth', sourceFile: 'server.js', sourceLine: 165, functionName: 'route', dependency: 'session-store' });
      return json(res, 503, { ok: false, error: 'SESSION_REFRESH_FAILED', correlationId: ctx.correlationId });
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/support') {
    const message = String(body.message || '');
    await logEvent(ctx, { service: 'support-web', message: 'support form accepted', statusCode: 202, metadata: { message_length: message.trim().length } });
    if (!message.trim()) await logException(ctx, new Error('support request contains an empty message'), { service: 'support-web', statusCode: 201, errorCode: 'SUPPORT_EMPTY_MESSAGE', scenario: 'support', sourceFile: 'server.js', sourceLine: 129, functionName: 'route', dependency: 'support-api', investigationHint: 'Reject blank support messages at the request boundary before creating a ticket.', metadata: { message_length: 0 } });
    const downstreamCtx = await startRequest(req, url);
    await logEvent(downstreamCtx, { service: 'support-api', message: 'support ticket created', statusCode: 201, scenario: 'support', metadata: { upstream_correlation_id: ctx.correlationId } });
    return json(res, 201, { ok: true, correlationId: ctx.correlationId });
  }

  if (req.method === 'GET' && url.pathname === '/api/search') {
    const query = url.searchParams.get('q') || '';
    let catalogCtx = ctx;
    try {
      await logEvent(ctx, { service: 'search-ui', message: `search submitted q=${query}`, statusCode: 200, metadata: { query } });
      catalogCtx = await callService(ctx, 'catalog-api', 'search query accepted', { metadata: { query, query_shape: 'catalog_name_lookup' } });

      const result = await pool.query('SELECT id, name, category, price FROM meant_to_break_catalog WHERE name ILIKE $1 ORDER BY id LIMIT 20', [`%${query}%`]);
      await logEvent(catalogCtx, { service: 'postgres', message: 'catalog query completed', statusCode: 200, durationMs: 18, scenario: 'search', metadata: { query, row_count: result.rowCount } });
      return json(res, 200, { ok: true, query, results: result.rows, correlationId: ctx.correlationId });
    } catch (error) {
      await logException(catalogCtx, error, { service: 'catalog-api', statusCode: 500, errorCode: 'CATALOG_QUERY_FAILED', scenario: 'search', sourceFile: 'server.js', sourceLine: 134, functionName: 'route', dependency: 'postgres', investigationHint: 'Compare the selected catalog column names with the meant_to_break_catalog table definition in schema.sql.', metadata: { query, query_shape: 'catalog_name_lookup' } });
      return json(res, 500, { ok: false, error: 'CATALOG_QUERY_FAILED', message: 'Search is temporarily unavailable.', correlationId: ctx.correlationId });
    }
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
    if (url.pathname === '/' && dbReady) {
      const outage = await getOutageState();
      if (outage.outage_enabled) {
        res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '60' });
        return res.end(outagePage(true));
      }
    }
    const requested = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.join(staticRoot, requested);
    if (!file.startsWith(staticRoot) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return json(res, 404, { ok: false, error: 'not_found' });
    const ext = path.extname(file); const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
    res.writeHead(200, { 'content-type': `${types[ext] || 'application/octet-stream'}; charset=utf-8` }); res.end(fs.readFileSync(file));
  } catch (error) { console.error('[request-error]', error); if (!res.headersSent) json(res, 500, { ok: false, error: 'internal_server_error' }); }
});

initialize().finally(() => server.listen(port, '127.0.0.1', () => console.log(`Meant to Break API listening on http://127.0.0.1:${port}`)));
