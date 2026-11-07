import assert from 'node:assert/strict';
import { classifyGeminiError, computeBackoffMs, parseRetryDelayMs } from '../../server/geminiErrors.ts';

// The @google/genai SDK throws an ApiError whose numeric `status` is the HTTP code and whose `message` is the raw JSON body.
const apiError = (status: number, error: Record<string, unknown>) =>
  Object.assign(new Error(JSON.stringify({ error: { code: status, ...error } })), { status });

const RETRY_INFO = (delay: string) => ({ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: delay });
const QUOTA_FAILURE = (quotaId: string, quotaValue = '20') => ({
  '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
  violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaId, quotaValue }],
});

// 429 per minute: retryable, and Google's own delay is honoured.
{
  const c = classifyGeminiError(apiError(429, {
    status: 'RESOURCE_EXHAUSTED',
    message: 'You exceeded your current quota.',
    details: [QUOTA_FAILURE('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', '5'), RETRY_INFO('34s')],
  }));
  assert.equal(c.reason, 'rate_limited');
  assert.equal(c.retryable, true);
  assert.equal(c.retryAfterMs, 34000);
}

// 429 per day: NOT retryable - waiting a minute cannot help, and it used to be reported as "busy, wait a minute".
{
  const c = classifyGeminiError(apiError(429, {
    status: 'RESOURCE_EXHAUSTED',
    message: 'You exceeded your current quota.',
    details: [QUOTA_FAILURE('GenerateRequestsPerDayPerProjectPerModel-FreeTier'), RETRY_INFO('34s')],
  }));
  assert.equal(c.reason, 'quota_daily');
  assert.equal(c.retryable, false);
}

// 429 with limit 0: the model has no quota on this project's tier at all.
{
  const c = classifyGeminiError(apiError(429, {
    status: 'RESOURCE_EXHAUSTED',
    message: 'Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0',
  }));
  assert.equal(c.reason, 'no_free_tier');
  assert.equal(c.retryable, false);
}

// Bare 429 (what Google returns for googleSearch grounding): no window, no delay -> not retried.
{
  const c = classifyGeminiError(apiError(429, {
    status: 'RESOURCE_EXHAUSTED',
    message: 'You exceeded your current quota, please check your plan and billing details.',
    details: [{ '@type': 'type.googleapis.com/google.rpc.Help', links: [{ url: 'https://ai.google.dev/gemini-api/docs/rate-limits' }] }],
  }));
  assert.equal(c.reason, 'quota_unspecified');
  assert.equal(c.retryable, false);
}

// 400 with a bad key is an auth problem; any other 400 is a bad request. Neither is a "connection" problem.
{
  const bad = classifyGeminiError(apiError(400, {
    status: 'INVALID_ARGUMENT',
    message: 'API key not valid. Please pass a valid API key.',
    details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }],
  }));
  assert.equal(bad.reason, 'invalid_api_key');
  const req = classifyGeminiError(apiError(400, { status: 'INVALID_ARGUMENT', message: 'Unsupported parameter combination.' }));
  assert.equal(req.reason, 'bad_request');
  assert.equal(req.retryable, false);
}

assert.equal(classifyGeminiError(apiError(403, { status: 'PERMISSION_DENIED', message: 'Your API key was reported as leaked.' })).reason, 'permission_denied');
assert.equal(classifyGeminiError(apiError(401, { status: 'UNAUTHENTICATED', message: 'Request had invalid authentication credentials.' })).reason, 'invalid_api_key');
assert.equal(classifyGeminiError(apiError(404, { status: 'NOT_FOUND', message: 'models/x is not found' })).reason, 'model_not_found');
assert.equal(classifyGeminiError(apiError(404, { status: 'NOT_FOUND', message: 'models/x is not found' })).retryable, false);

// Transient server-side failures are retryable.
assert.equal(classifyGeminiError(apiError(503, { status: 'UNAVAILABLE', message: 'The model is overloaded.' })).reason, 'overloaded');
assert.equal(classifyGeminiError(apiError(500, { status: 'INTERNAL', message: 'An internal error has occurred.' })).reason, 'internal');
assert.equal(classifyGeminiError(apiError(500, { status: 'INTERNAL', message: 'An internal error has occurred.' })).retryable, true);

// No HTTP answer at all is the only case that deserves "could not be reached".
{
  const c = classifyGeminiError(new TypeError('fetch failed'));
  assert.equal(c.reason, 'network');
  assert.equal(c.retryable, true);
}

// The server's own "no key" message must win over the generic 401 rule.
assert.equal(
  classifyGeminiError({ status: 401, message: 'Missing Gemini API key on server. Set GEMINI_API_KEY in environment secrets.' }).reason,
  'missing_api_key'
);

assert.equal(parseRetryDelayMs('34s'), 34000);
assert.equal(parseRetryDelayMs('1.5s'), 1500);
assert.equal(parseRetryDelayMs('250ms'), 250);
assert.equal(parseRetryDelayMs('soon'), null);

assert.equal(computeBackoffMs(1, 32000, () => 0), 1000);
assert.equal(computeBackoffMs(3, 32000, () => 0), 4000);
assert.equal(computeBackoffMs(10, 32000, () => 0), 32000);

console.log('geminiErrors tests passed');
