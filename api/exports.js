const {
  context,
  body,
  logEvent,
  logException,
  json,
  outageResponse,
} = require('../lib/observability');

module.exports = async function handler(req, res) {
  const ctx = context(req);
  try {
    if (await outageResponse(req, res)) return;
    const input = await body(req);
    await logEvent(ctx, { service: 'export-api', message: 'export request accepted', statusCode: 202, metadata: { format: input.format || 'csv' } });

    const filterStatus = input.filters.status.toLowerCase();
    await logEvent(ctx, { service: 'export-worker', message: 'export queued', statusCode: 202, scenario: 'export', metadata: { filter_status: filterStatus } });
    return json(res, 202, { ok: true, status: 'queued', correlationId: ctx.correlationId });
  } catch (error) {
    await logException(ctx, error, {
      service: 'export-api',
      statusCode: 500,
      errorCode: 'EXPORT_NULL_FILTER',
      scenario: 'export',
      sourceFile: 'api/exports.js',
      sourceLine: 18,
      functionName: 'handler',
      dependency: 'export-worker',
      investigationHint: 'Validate optional filters before reading filter.status or provide a default filter object.',
    });
    return json(res, 500, { ok: false, error: 'EXPORT_NULL_FILTER', message: 'We could not prepare your export. Please try again later.', correlationId: ctx.correlationId });
  }
};
