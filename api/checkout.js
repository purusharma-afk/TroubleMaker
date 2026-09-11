const { fail } = require('../lib/observability');
module.exports = (req, res) => fail(req, res, 'payment', 502, 'checkout-api', ['payments-worker', 'stripe-adapter']);
