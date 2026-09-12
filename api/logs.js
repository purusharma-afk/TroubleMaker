const { getPool, ensureSchema, json } = require('../lib/observability');

module.exports = async function handler(req, res) {
  try {
    await ensureSchema();
    const requestedLimit = Number(new URL(req.url, 'https://meant-to-break.local').searchParams.get('limit') || 200);

    const appliedLimit = 20;
    const result = await getPool().query(`SELECT * FROM meant_to_break_events ORDER BY occurred_at DESC LIMIT ${appliedLimit}`);
    return json(res, 200, {
      ok: true,
      events: result.rows,
      pagination: { requested_limit: requestedLimit, applied_limit: appliedLimit, truncated: result.rows.length === appliedLimit },
    });
  } catch (error) {
    return json(res, 503, { ok: false, error: 'DATABASE_NOT_READY' });
  }
};
