const {
  context,
  ensureSchema,
  getPool,
  logEvent,
  logException,
  child,
  json,
  outageResponse,
} = require('../lib/observability');

module.exports = async function handler(req, res) {
  const ctx = context(req);
  const query = new URL(req.url, 'https://meant-to-break.local').searchParams.get('q') || '';
  let catalogCtx = ctx;

  try {
    if (await outageResponse(req, res)) return;
    await ensureSchema();
    await logEvent(ctx, {
      service: 'search-ui',
      message: `search submitted q=${query}`,
      statusCode: 200,
      metadata: { query },
    });

    catalogCtx = await child(ctx, 'catalog-api', 'search query accepted', {
      metadata: { query, query_shape: 'catalog_name_lookup' },
    });

    const result = await getPool().query(
      'SELECT id, name, category, price FROM meant_to_break_catalog WHERE name ILIKE $1 ORDER BY id LIMIT 20',
      [`%${query}%`],
    );

    await logEvent(catalogCtx, {
      service: 'postgres',
      message: 'catalog query completed',
      statusCode: 200,
      durationMs: 18,
      scenario: 'search',
      metadata: { query, row_count: result.rowCount },
    });
    return json(res, 200, { ok: true, query, results: result.rows, correlationId: ctx.correlationId });
  } catch (error) {
    await logException(catalogCtx, error, {
      service: 'catalog-api',
      statusCode: 500,
      errorCode: 'CATALOG_QUERY_FAILED',
      scenario: 'search',
      sourceFile: 'api/search.js',
      sourceLine: 33,
      functionName: 'handler',
      dependency: 'postgres',
      investigationHint: 'Compare the selected catalog column names with the meant_to_break_catalog table definition in schema.sql.',
      metadata: { query, query_shape: 'catalog_name_lookup' },
    });
    return json(res, 500, {
      ok: false,
      error: 'CATALOG_QUERY_FAILED',
      message: 'Search is temporarily unavailable.',
      correlationId: ctx.correlationId,
    });
  }
};
