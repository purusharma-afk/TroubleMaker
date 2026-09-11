const {
  context,
  getOutageState,
  setOutageState,
  body,
  json,
} = require('../lib/observability');

module.exports = async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) return json(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });

  try {
    const current = await getOutageState();
    if (req.method === 'GET') return json(res, 200, { ok: true, ...current });

    const input = await body(req);
    const enabled = typeof input.enabled === 'boolean' ? input.enabled : !current.outage_enabled;
    const reason = String(input.reason || 'Synthetic website outage').slice(0, 240);
    const next = await setOutageState(context(req), enabled, reason);
    return json(res, 200, { ok: true, ...next });
  } catch (error) {
    console.error('[outage-control-failed]', error.message);
    return json(res, 503, { ok: false, error: 'DATABASE_NOT_READY' });
  }
};
