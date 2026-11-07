import assert from 'node:assert/strict';
import { GeminiCallError, callGemini, handleGeminiHealth } from '../../server/geminiService.ts';

process.env.GEMINI_API_KEY = 'test-key';
process.env.GEMINI_MAX_ATTEMPTS = '3';
process.env.GEMINI_MAX_CONCURRENCY = '2';
console.warn = () => {};

const apiError = (status: number, error: Record<string, unknown>) =>
  Object.assign(new Error(JSON.stringify({ error: { code: status, ...error } })), { status });
const retryInfo = (delay: string) => ({ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: delay });

// Transient overload: retried (honouring Google's delay) until it succeeds.
{
  let calls = 0;
  const value = await callGemini(async () => {
    calls += 1;
    if (calls < 3) throw apiError(503, { status: 'UNAVAILABLE', message: 'overloaded', details: [retryInfo('0s')] });
    return 'ok';
  });
  assert.equal(value, 'ok');
  assert.equal(calls, 3);
}

// Daily quota: fails at once. Retrying cannot help and only spends more requests.
{
  let calls = 0;
  await assert.rejects(
    callGemini(async () => {
      calls += 1;
      throw apiError(429, {
        status: 'RESOURCE_EXHAUSTED',
        message: 'You exceeded your current quota.',
        details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }],
      });
    }),
    (err: unknown) => err instanceof GeminiCallError && err.classified.reason === 'quota_daily'
  );
  assert.equal(calls, 1);
}

// A bare 429 (grounding) fails at once instead of being retried with backoff.
{
  let calls = 0;
  await assert.rejects(
    callGemini(async () => {
      calls += 1;
      throw apiError(429, { status: 'RESOURCE_EXHAUSTED', message: 'You exceeded your current quota, please check your plan and billing details.' });
    }),
    (err: unknown) => err instanceof GeminiCallError && err.classified.reason === 'quota_unspecified'
  );
  assert.equal(calls, 1);
}

// Auth, permission and bad-request errors are never retried.
for (const [status, reason] of [[400, 'bad_request'], [403, 'permission_denied'], [404, 'model_not_found']] as const) {
  let calls = 0;
  await assert.rejects(
    callGemini(async () => {
      calls += 1;
      throw apiError(status, { message: 'nope', status: status === 400 ? 'INVALID_ARGUMENT' : status === 403 ? 'PERMISSION_DENIED' : 'NOT_FOUND' });
    }),
    (err: unknown) => err instanceof GeminiCallError && err.classified.reason === reason
  );
  assert.equal(calls, 1, `HTTP ${status} must not be retried`);
}

// A requested wait longer than we are willing to sit through is not slept on.
{
  let calls = 0;
  await assert.rejects(
    callGemini(async () => {
      calls += 1;
      throw apiError(429, { status: 'RESOURCE_EXHAUSTED', message: 'slow down', details: [retryInfo('600s')] });
    }),
    (err: unknown) => err instanceof GeminiCallError && err.classified.retryAfterMs === 600000
  );
  assert.equal(calls, 1);
}

// Attempts are bounded.
{
  let calls = 0;
  await assert.rejects(
    callGemini(async () => {
      calls += 1;
      throw apiError(503, { status: 'UNAVAILABLE', message: 'overloaded', details: [retryInfo('0s')] });
    }),
    (err: unknown) => err instanceof GeminiCallError && err.attempts === 3
  );
  assert.equal(calls, 3);
}

// Concurrency toward Google is capped (GEMINI_MAX_CONCURRENCY=2 above).
{
  let active = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 8 }, () =>
      callGemini(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return true;
      })
    )
  );
  assert.equal(peak, 2);
}

// A model that never answers is cut off at the request timeout, aborted, reported as "timeout" and NOT retried on the same model.
{
  process.env.GEMINI_REQUEST_TIMEOUT_MS = '30';
  let calls = 0;
  let aborted = false;
  await assert.rejects(
    callGemini(
      (signal) =>
        new Promise((_resolve, reject) => {
          calls += 1;
          signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        })
    ),
    (err: unknown) => err instanceof GeminiCallError && err.classified.reason === 'timeout' && err.classified.httpStatus === 504
  );
  assert.equal(calls, 1, 'a timeout must not be retried on the same model');
  assert.equal(aborted, true, 'the underlying request must be aborted');
  delete process.env.GEMINI_REQUEST_TIMEOUT_MS;
}

// Health endpoint: says "missing key" instead of failing mysteriously, and never echoes a key.
{
  delete process.env.GEMINI_API_KEY;
  let body = '';
  const res: any = { statusCode: 0, setHeader() {}, end(chunk: string) { body = chunk; } };
  await handleGeminiHealth({ url: '/api/gemini/health', method: 'GET' } as any, res);
  const payload = JSON.parse(body);
  assert.equal(payload.ok, false);
  assert.equal(payload.reason, 'missing_api_key');
  assert.equal(payload.keyPresent, false);
}

console.log('geminiRetry tests passed');
