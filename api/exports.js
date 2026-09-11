const { fail } = require('../lib/observability');
module.exports = (req, res) => fail(req, res, 'export', 500, 'export-api', ['queue', 'export-worker']);
