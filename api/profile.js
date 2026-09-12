const {
  context,
  ensureSchema,
  getPool,
  body,
  logEvent,
  logException,
  json,
  outageResponse,
} = require('../lib/observability');

module.exports = async function handler(req, res) {
  const ctx = context(req);
  let input = {};
  try {
    if (await outageResponse(req, res)) return;
    await ensureSchema();
    input = await body(req);
    const displayName = String(input.name || '').trim();
    const expectedVersion = Number(input.expected_version || 0);
    await logEvent(ctx, { service: 'profile-api', message: 'profile update accepted', statusCode: 202, metadata: { expected_version: expectedVersion } });

    const result = await getPool().query(
      'UPDATE meant_to_break_profiles SET display_name = $1, version = version + 1 WHERE id = 1 AND version = $2 RETURNING id, display_name, version',
      [displayName, expectedVersion],
    );
    if (!result.rowCount) {
      const error = new Error('profile version no longer matches');
      error.name = 'OptimisticLockError';
      throw error;
    }
    return json(res, 200, { ok: true, profile: result.rows[0], correlationId: ctx.correlationId });
  } catch (error) {
    const isConflict = error.name === 'OptimisticLockError';
    await logException(ctx, error, {
      service: 'profile-api',
      statusCode: isConflict ? 409 : 503,
      errorCode: isConflict ? 'PROFILE_CONFLICT' : 'PROFILE_UPDATE_FAILED',
      scenario: 'profile',
      sourceFile: 'public/client.js',
      sourceLine: 40,
      functionName: 'profileSave',
      dependency: 'postgres',
      investigationHint: 'Compare the version sent by profileSave with the current row version and refresh stale profile state before updating.',
      metadata: { expected_version: Number(input.expected_version || 0) },
    });
    return json(res, isConflict ? 409 : 503, { ok: false, error: isConflict ? 'PROFILE_CONFLICT' : 'PROFILE_UPDATE_FAILED', message: isConflict ? 'Your profile was updated elsewhere. Refresh the page and try again.' : 'Profile is temporarily unavailable.', correlationId: ctx.correlationId });
  }
};
