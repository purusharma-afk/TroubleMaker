const { schemaReady, json } = require('../lib/observability');
module.exports = async function handler(req, res) { try { await schemaReady; return json(res, 200, { ok: true, database: true, service: 'meant-to-break-api', environment: 'vercel-staging' }); } catch (error) { return json(res, 503, { ok: false, database: false, error: error.message }); } };
