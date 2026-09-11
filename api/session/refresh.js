const { fail } = require('../../lib/observability');
module.exports = (req, res) => fail(req, res, 'auth', 401, 'identity-web', ['identity-api', 'session-store']);
