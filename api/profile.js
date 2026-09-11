const { fail } = require('../lib/observability');
module.exports = (req, res) => fail(req, res, 'profile', 409, 'profile-api', ['postgres']);
