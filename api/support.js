const { context, body, logEvent, logException, json, outageResponse } = require('../lib/observability');

module.exports = async function handler(req, res) {
  const ctx = context(req);
  try {
    if (await outageResponse(req, res)) return;
    const input = await body(req);
    const message = String(input.message || '');
    await logEvent(ctx, {
      service: 'support-web',
      message: 'support form accepted',
      statusCode: 202,
      metadata: { message_length: message.trim().length },
    });

    if (!message.trim()) {
      await logException(ctx, new Error('support request contains an empty message'), {
        service: 'support-web',
        level: 'ERROR',
        statusCode: 201,
        errorCode: 'SUPPORT_EMPTY_MESSAGE',
        scenario: 'support',
        sourceFile: 'api/support.js',
        sourceLine: 17,
        functionName: 'handler',
        dependency: 'support-api',
        investigationHint: 'Reject blank support messages at the request boundary before creating a ticket.',
        metadata: { message_length: 0 },
      });
    }

    const downstreamCtx = context(req);
    await logEvent(downstreamCtx, {
      service: 'support-api',
      message: 'support ticket created',
      statusCode: 201,
      scenario: 'support',
      metadata: { upstream_correlation_id: ctx.correlationId },
    });
    return json(res, 201, { ok: true, correlationId: ctx.correlationId });
  } catch (error) {
    await logException(ctx, error, { service: 'support-web', statusCode: 503, errorCode: 'SUPPORT_HANDLER_FAILED', scenario: 'support', sourceFile: 'api/support.js', sourceLine: 5, functionName: 'handler', dependency: 'support-api' });
    return json(res, 503, { ok: false, error: 'SUPPORT_HANDLER_FAILED', correlationId: ctx.correlationId });
  }
};
