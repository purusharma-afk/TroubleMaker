const { context, logEvent, logException, json, outageResponse } = require('../../lib/observability');

module.exports = async function handler(req, res) {
  const ctx = context(req);
  try {
    if (await outageResponse(req, res)) return;
    const cookie = 'mtb_session=session_demo; Path=/; SameSite=None';

    res.setHeader('Set-Cookie', cookie);
    await logException(ctx, new Error('session refresh returned a browser-rejected cookie'), {
      service: 'identity-web',
      statusCode: 200,
      errorCode: 'SESSION_COOKIE_MISCONFIGURED',
      scenario: 'auth',
      sourceFile: 'api/session/refresh.js',
      sourceLine: 10,
      functionName: 'handler',
      dependency: 'browser-cookie-policy',
      investigationHint: 'Add Secure to SameSite=None cookies and verify the cookie attributes on the deployed HTTPS origin.',
      metadata: { same_site: 'None', secure: false, cookie_name: 'mtb_session' },
    });
    return json(res, 200, { ok: true, refreshed: true, correlationId: ctx.correlationId });
  } catch (error) {
    await logException(ctx, error, { service: 'identity-web', statusCode: 503, errorCode: 'SESSION_REFRESH_FAILED', scenario: 'auth', sourceFile: 'api/session/refresh.js', sourceLine: 8, functionName: 'handler', dependency: 'session-store' });
    return json(res, 503, { ok: false, error: 'SESSION_REFRESH_FAILED', message: 'Your session needs attention. Please sign in again.', correlationId: ctx.correlationId });
  }
};
