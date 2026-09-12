const diagnosticCatalog = {
  search: {
    exceptionType: 'QueryTimeoutError',
    sourceFile: 'api/search.js',
    sourceLine: 2,
    functionName: 'searchCatalog',
    dependency: 'postgres',
    rootCause: 'The catalog search fell back to a sequential scan and exceeded the statement deadline.',
    suggestedFix: 'Add an index for the catalog search predicate and review the query plan before increasing the timeout.',
    stackTrace: 'QueryTimeoutError: catalog query exceeded statement deadline\n    at searchCatalog (api/search.js:2:1)\n    at catalogApi (api/search.js:2:1)\n    at handler (api/search.js:2:1)',
  },
  payment: {
    exceptionType: 'PaymentProviderTimeoutError',
    sourceFile: 'api/checkout.js',
    sourceLine: 2,
    functionName: 'submitPayment',
    dependency: 'stripe-adapter',
    rootCause: 'The payment adapter did not receive a response from the upstream payment provider within its deadline.',
    suggestedFix: 'Add bounded retries with idempotency keys, preserve the provider request ID, and use a circuit breaker for repeated timeouts.',
    stackTrace: 'PaymentProviderTimeoutError: payment provider did not respond within 10s\n    at submitPayment (api/checkout.js:2:1)\n    at stripeAdapter (api/checkout.js:2:1)\n    at handler (api/checkout.js:2:1)',
  },
  profile: {
    exceptionType: 'OptimisticLockError',
    sourceFile: 'api/profile.js',
    sourceLine: 2,
    functionName: 'updateProfile',
    dependency: 'postgres',
    rootCause: 'The profile update used a stale record version and affected zero rows.',
    suggestedFix: 'Return the current version to the client, refresh stale state, and retry the update with an atomic version predicate.',
    stackTrace: 'OptimisticLockError: profile version no longer matches\n    at updateProfile (api/profile.js:2:1)\n    at postgres (api/profile.js:2:1)\n    at handler (api/profile.js:2:1)',
  },
  export: {
    exceptionType: 'ExportPayloadError',
    sourceFile: 'api/exports.js',
    sourceLine: 2,
    functionName: 'enqueueExport',
    dependency: 'export-worker',
    rootCause: 'The export request reached the worker with a null filter payload.',
    suggestedFix: 'Validate and normalize the export filters at the API boundary before enqueueing the job.',
    stackTrace: 'ExportPayloadError: worker rejected null filter payload\n    at enqueueExport (api/exports.js:2:1)\n    at exportWorker (api/exports.js:2:1)\n    at handler (api/exports.js:2:1)',
  },
  auth: {
    exceptionType: 'SessionCookieError',
    sourceFile: 'api/session/refresh.js',
    sourceLine: 2,
    functionName: 'refreshSession',
    dependency: 'session-store',
    rootCause: 'The refreshed session cookie was not returned to the web origin.',
    suggestedFix: 'Verify cookie domain, path, SameSite, Secure, and proxy forwarding settings for the deployed origin.',
    stackTrace: 'SessionCookieError: refreshed session cookie missing from response\n    at refreshSession (api/session/refresh.js:2:1)\n    at sessionStore (api/session/refresh.js:2:1)\n    at handler (api/session/refresh.js:2:1)',
  },
  availability: {
    exceptionType: 'SyntheticOutageError',
    sourceFile: 'api/site.js',
    sourceLine: 28,
    functionName: 'availabilityGate',
    dependency: 'website-gateway',
    rootCause: 'The global synthetic outage control is enabled for SRE testing.',
    suggestedFix: 'Restore the website from the outage control, then verify the root URL and health endpoint return 200.',
    stackTrace: 'SyntheticOutageError: request rejected by availability gate\n    at availabilityGate (api/site.js:28:1)\n    at siteHandler (api/site.js:35:1)\n    at requestRouter (api/site.js:42:1)',
  },
};

function diagnosticMetadata(values = {}) {
  const base = values.metadata && typeof values.metadata === 'object' ? values.metadata : {};
  if (base.diagnostics) return base;
  const catalog = diagnosticCatalog[values.scenario];
  const syntheticErrorCodes = new Set(['CATALOG_TIMEOUT', 'PAYMENT_PROVIDER', 'PROFILE_CONFLICT', 'EXPORT_WORKER', 'SESSION_REFRESH', 'SYNTHETIC_OUTAGE']);
  if (values.errorCode && !syntheticErrorCodes.has(values.errorCode)) return base;
  const isFailure = values.level === 'ERROR' || values.level === 'WARN' || (values.errorCode && values.errorCode !== 'SERVICE_RESTORED');
  if (!catalog || !isFailure) return base;

  return {
    ...base,
    diagnostics: {
      synthetic: true,
      exception_type: catalog.exceptionType,
      stack_trace: catalog.stackTrace,
      source_file: catalog.sourceFile,
      source_line: catalog.sourceLine,
      function: catalog.functionName,
      dependency: catalog.dependency,
      root_cause: catalog.rootCause,
      suggested_fix: catalog.suggestedFix,
      release: process.env.VERCEL_GIT_COMMIT_SHA || 'local-working-tree',
      deployment_environment: process.env.VERCEL_ENV || 'local-staging',
      redaction: 'Stack trace is synthetic and contains no credentials or customer data.',
    },
  };
}

function redactStack(value) {
  return String(value || 'Error: unknown failure')
    .replace(/postgres(?:ql)?:\/\/[^\s'"`]+/gi, 'postgresql://[REDACTED]')
    .replace(/(password|token|secret|api[_-]?key)=([^\s&]+)/gi, '$1=[REDACTED]');
}

function runtimeDiagnosticMetadata(error, values = {}) {
  const base = values.metadata && typeof values.metadata === 'object' ? values.metadata : {};
  return {
    ...base,
    diagnostics: {
      synthetic: false,
      exception_type: error?.name || 'Error',
      stack_trace: redactStack(error?.stack || error?.message),
      database_error_code: error?.code || null,
      database_message: error?.detail || error?.message || 'Unknown database error',
      source_file: values.sourceFile || null,
      source_line: values.sourceLine || null,
      function: values.functionName || null,
      dependency: values.dependency || null,
      investigation_hint: values.investigationHint || 'Inspect the failing source line and compare its contract with the dependency schema.',
      release: process.env.VERCEL_GIT_COMMIT_SHA || 'local-working-tree',
      deployment_environment: process.env.VERCEL_ENV || 'local-staging',
      redaction: 'Runtime error details are redacted for connection strings and credential-like values.',
    },
  };
}

module.exports = { diagnosticMetadata, runtimeDiagnosticMetadata };
