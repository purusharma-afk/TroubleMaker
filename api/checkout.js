const {
  context,
  body,
  logEvent,
  logException,
  child,
  json,
  outageResponse,
} = require('../lib/observability');

module.exports = async function handler(req, res) {
  const ctx = context(req);
  try {
    if (await outageResponse(req, res)) return;
    const input = await body(req);
    const items = Array.isArray(input.items) ? input.items : [];
    const orderId = String(input.order_id || 'demo-order');
    const expectedTotal = items.reduce((sum, item) => sum + Number(item.price || 0) * Number(item.qty || 1), 0);
    const clientTotal = Number(input.client_total);

    await logEvent(ctx, {
      service: 'checkout-api',
      message: 'checkout request accepted',
      statusCode: 202,
      metadata: { order_id: orderId, item_count: items.length, client_total: clientTotal },
    });

    if (Number.isFinite(clientTotal) && Math.abs(clientTotal - expectedTotal) > 0.01) {
      await logException(ctx, new Error('client cart total does not match line-item total'), {
        service: 'checkout-api',
        statusCode: 400,
        errorCode: 'CART_TOTAL_MISMATCH',
        scenario: 'cart',
        sourceFile: 'public/client.js',
        sourceLine: 19,
        functionName: 'total',
        dependency: 'browser-cart-state',
        investigationHint: 'Compare the cart total calculation with price multiplied by quantity for every line item.',
        metadata: { order_id: orderId, client_total: clientTotal, expected_total: expectedTotal },
      });
    }

    const payment = await child(ctx, 'payments-worker', 'payment authorization accepted', {
      statusCode: 200,
      scenario: 'payment',
      metadata: { order_id: orderId },
    });
    const firstCharge = await child(payment, 'stripe-adapter', 'payment charged', {
      statusCode: 200,
      scenario: 'payment',
      metadata: { order_id: orderId, idempotency_key: input.idempotency_key || null },
    });

    await child(payment, 'stripe-adapter', 'payment charged', {
      level: 'ERROR',
      statusCode: 200,
      errorCode: 'PAYMENT_DUPLICATE_CHARGE',
      scenario: 'payment',
      metadata: { order_id: orderId, duplicate_of_span_id: firstCharge.spanId, idempotency_key: input.idempotency_key || null },
    });
    const error = new Error('payment provider charged the same order twice');
    await logException(payment, error, {
      service: 'checkout-api',
      statusCode: 500,
      errorCode: 'PAYMENT_DUPLICATE_CHARGE',
      scenario: 'payment',
      sourceFile: 'api/checkout.js',
      sourceLine: 55,
      functionName: 'handler',
      dependency: 'stripe-adapter',
      investigationHint: 'Make the payment operation idempotent by persisting and reusing an idempotency key before charging.',
      metadata: { order_id: orderId, duplicate_of_span_id: firstCharge.spanId },
    });
    return json(res, 500, { ok: false, error: 'PAYMENT_DUPLICATE_CHARGE', message: 'We could not complete your payment.', correlationId: ctx.correlationId });
  } catch (error) {
    await logException(ctx, error, { service: 'checkout-api', statusCode: 503, errorCode: 'CHECKOUT_HANDLER_FAILED', scenario: 'payment', sourceFile: 'api/checkout.js', sourceLine: 8, functionName: 'handler', dependency: 'payments-worker' });
    return json(res, 503, { ok: false, error: 'CHECKOUT_HANDLER_FAILED', message: 'Checkout is temporarily unavailable.', correlationId: ctx.correlationId });
  }
};
