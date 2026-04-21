import { MusashiAgent } from '../src/sdk/musashi-agent';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

type Level = 'pass' | 'warn' | 'fail';

interface CaseResult {
  level: Level;
  detail: string;
}

interface HttpResult {
  status: number;
  text: string;
  json: any;
  headers: Headers;
  durationMs: number;
}

const BASE_URL = (process.env.MUSASHI_API_BASE_URL || 'https://musashi-api.vercel.app').replace(/\/$/, '');
const ADMIN_KEY = process.env.API_USAGE_ADMIN_KEY;
const VERCEL_AUTOMATION_BYPASS_SECRET = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
const CLIENT_ID = process.env.MUSASHI_TEST_CLIENT_ID || `agent-api-test-${Date.now()}`;
const TIMEOUT_MS = readIntEnv('MUSASHI_TEST_TIMEOUT_MS', 15000);
const LATENCY_SAMPLE_SIZE = readIntEnv('MUSASHI_TEST_LATENCY_SAMPLES', 20);
const INCLUDE_PERF =
  process.env.MUSASHI_TEST_INCLUDE_PERF === '1' ||
  process.env.MUSASHI_TEST_INCLUDE_BENCHMARKS === '1' ||
  process.env.MUSASHI_TEST_INCLUDE_COLD_START === '1';
const COLD_IDLE_MS = readIntEnv('MUSASHI_TEST_COLD_IDLE_MS', 10000);
const COLD_SAMPLE_SIZE = readIntEnv('MUSASHI_TEST_COLD_SAMPLES', 10);
const INCLUDE_STRESS = process.env.MUSASHI_TEST_INCLUDE_STRESS === '1';
const CONCURRENCY_LEVEL = readIntEnv('MUSASHI_TEST_CONCURRENCY', 20);
const BURST_REQUESTS = readIntEnv('MUSASHI_TEST_BURST_REQUESTS', 50);
const COOKIE_JAR_PATH = join(mkdtempSync(join(tmpdir(), 'musashi-agent-api-')), 'cookies.txt');

installCurlBackedFetch();

async function main(): Promise<void> {
  const tests: Array<{ name: string; run: () => Promise<CaseResult> }> = [
    { name: 'health endpoint contract', run: testHealthEndpoint },
    { name: 'sdk health smoke test', run: testSdkHealth },
    { name: 'health response headers', run: testHealthHeaders },
    { name: 'method matrix for public endpoints', run: testMethodMatrix },
    { name: 'analyze-text OPTIONS preflight', run: testAnalyzeTextOptions },
    { name: 'analyze-text happy path', run: testAnalyzeTextHappyPath },
    { name: 'analyze-text accepts no-match text gracefully', run: testAnalyzeTextNoMatch },
    { name: 'analyze-text rejects GET', run: testAnalyzeTextMethodGuard },
    { name: 'analyze-text rejects missing text', run: testAnalyzeTextMissingText },
    { name: 'analyze-text rejects empty string', run: testAnalyzeTextEmptyString },
    { name: 'analyze-text handles whitespace-only text safely', run: testAnalyzeTextWhitespaceOnly },
    { name: 'analyze-text rejects null body payload', run: testAnalyzeTextNullBody },
    { name: 'analyze-text rejects array body payload', run: testAnalyzeTextArrayBody },
    { name: 'analyze-text rejects object text payload', run: testAnalyzeTextObjectText },
    { name: 'analyze-text rejects NaN minConfidence', run: testAnalyzeTextNaNMinConfidence },
    { name: 'analyze-text rejects Infinity minConfidence', run: testAnalyzeTextInfinityMinConfidence },
    { name: 'analyze-text rejects invalid minConfidence', run: testAnalyzeTextInvalidMinConfidence },
    { name: 'analyze-text rejects invalid maxResults', run: testAnalyzeTextInvalidMaxResults },
    { name: 'analyze-text rejects overlong text', run: testAnalyzeTextOverlongText },
    { name: 'analyze-text handles unicode and emoji safely', run: testAnalyzeTextUnicodePayload },
    { name: 'analyze-text handles control-character payload safely', run: testAnalyzeTextControlChars },
    { name: 'analyze-text handles html payload safely', run: testAnalyzeTextHtmlPayload },
    { name: 'analyze-text handles injection-like payload safely', run: testAnalyzeTextInjectionPayload },
    { name: 'analyze-text malformed json is rejected safely', run: testAnalyzeTextMalformedJson },
    { name: 'analyze-text wrong content-type is handled safely', run: testAnalyzeTextWrongContentType },
    { name: 'analyze-text form-urlencoded content-type is handled safely', run: testAnalyzeTextFormUrlEncoded },
    { name: 'arbitrage happy path', run: testArbitrageHappyPath },
    { name: 'arbitrage rejects invalid minSpread', run: testArbitrageInvalidMinSpread },
    { name: 'arbitrage rejects invalid minConfidence', run: testArbitrageInvalidMinConfidence },
    { name: 'arbitrage rejects invalid limit', run: testArbitrageInvalidLimit },
    { name: 'arbitrage handles duplicate query params safely', run: testArbitrageDuplicateQueryParams },
    { name: 'arbitrage category filter echoes correctly', run: testArbitrageCategoryFilter },
    { name: 'movers happy path', run: testMoversHappyPath },
    { name: 'movers rejects invalid minChange', run: testMoversInvalidMinChange },
    { name: 'movers rejects invalid limit', run: testMoversInvalidLimit },
    { name: 'movers category filter echoes correctly', run: testMoversCategoryFilter },
    { name: 'feed happy path', run: testFeedHappyPath },
    { name: 'feed rejects invalid category', run: testFeedInvalidCategory },
    { name: 'feed rejects invalid minUrgency', run: testFeedInvalidMinUrgency },
    { name: 'feed rejects invalid limit', run: testFeedInvalidLimit },
    { name: 'feed rejects invalid since timestamp', run: testFeedInvalidSince },
    { name: 'feed handles duplicate query params safely', run: testFeedDuplicateQueryParams },
    { name: 'feed cursor pagination is stable', run: testFeedCursorPagination },
    { name: 'feed repeated request stability', run: testFeedRepeatedRequestStability },
    { name: 'feed oversized client id is handled safely', run: testFeedOversizedClientId },
    { name: 'feed special client id is handled safely', run: testFeedSpecialClientId },
    { name: 'feed OPTIONS preflight', run: testFeedOptions },
    { name: 'feed stats happy path', run: testFeedStatsHappyPath },
    { name: 'feed accounts contract', run: testFeedAccounts },
    { name: 'cache-control headers are present on cacheable endpoints', run: testCacheHeaders },
    { name: 'error responses do not leak sensitive internals', run: testErrorLeakage },
  ];

  if (ADMIN_KEY) {
    tests.push({ name: 'usage audit endpoint reflects caller traffic', run: testUsageAudit });
    tests.push({ name: 'usage audit rejects invalid admin key', run: testUsageAuditInvalidAdminKey });
    tests.push({ name: 'usage audit bearer auth works or fails safely', run: testUsageAuditBearerAuth });
    tests.push({ name: 'usage audit handles mixed auth headers safely', run: testUsageAuditMixedHeaders });
    tests.push({ name: 'usage audit records caller traffic consistently', run: testUsageAuditConsistency });
  } else {
    tests.push({ name: 'usage audit rejects missing admin key', run: testUsageAuditMissingAdminKey });
  }

  if (INCLUDE_PERF) {
    tests.push({ name: 'warm latency benchmark', run: testWarmLatencyBenchmark });
    tests.push({ name: 'best-effort cold start probe', run: testColdStartProbe });
  }

  if (INCLUDE_STRESS) {
    tests.push({ name: 'concurrent request stability', run: testConcurrentRequestStability });
    tests.push({ name: 'burst traffic stability', run: testBurstTrafficStability });
  }

  let failures = 0;
  let warnings = 0;

  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Client ID: ${CLIENT_ID}`);
  console.log(`Timeout: ${TIMEOUT_MS}ms`);
  console.log(`Vercel preview bypass: ${VERCEL_AUTOMATION_BYPASS_SECRET ? 'enabled' : 'disabled'}`);
  console.log('');

  await logPreviewBootstrap();

  for (const test of tests) {
    try {
      const result = await test.run();
      const prefix = result.level === 'pass' ? 'PASS' : result.level === 'warn' ? 'WARN' : 'FAIL';
      console.log(`[${prefix}] ${test.name} - ${result.detail}`);
      if (result.level === 'warn') warnings++;
      if (result.level === 'fail') failures++;
    } catch (error) {
      failures++;
      console.log(`[FAIL] ${test.name} - ${toErrorMessage(error)}`);
    }
  }

  console.log('');
  console.log(`Summary: ${tests.length - failures - warnings} passed, ${warnings} warnings, ${failures} failed`);

  if (failures > 0) {
    process.exitCode = 1;
  }
}

async function logPreviewBootstrap(): Promise<void> {
  try {
    const response = await request('/api/health');
    console.log(
      `Preview bootstrap: status=${response.status} content-type=${response.headers.get('content-type') || 'unknown'} final-url=${response.headers.get('x-fetch-final-url') || `${BASE_URL}/api/health`}`,
    );

    if (response.text && response.text.trim().startsWith('<')) {
      console.log('Preview bootstrap body looks like HTML instead of JSON');
    }

    console.log('');
  } catch (error) {
    console.log(`Preview bootstrap failed: ${toErrorMessage(error)}`);
    console.log('');
  }
}

async function testHealthEndpoint(): Promise<CaseResult> {
  const response = await request('/api/health');
  expectJsonObject(response.json, 'health response body must be JSON');
  expect(response.json.success === true, 'health success must be true');
  expect(['healthy', 'degraded', 'down'].includes(response.json.data?.status), 'health status must be valid');
  expect(typeof response.json.data?.services?.polymarket?.status === 'string', 'polymarket status missing');
  expect(typeof response.json.data?.services?.kalshi?.status === 'string', 'kalshi status missing');
  assertNoSensitiveLeak(response, 'health response');

  if (response.status === 200) {
    return pass(`status 200 (${response.json.data.status})`);
  }

  if (response.status === 503) {
    return warn(`status 503 (${response.json.data.status})`);
  }

  return fail(`unexpected status ${response.status}`);
}

async function testSdkHealth(): Promise<CaseResult> {
  const agent = new MusashiAgent(BASE_URL);
  const health = await agent.checkHealth();

  expect(['healthy', 'degraded', 'down'].includes(health.status), 'sdk health status must be valid');
  expect(typeof health.services?.polymarket?.status === 'string', 'sdk polymarket status missing');
  expect(typeof health.services?.kalshi?.status === 'string', 'sdk kalshi status missing');

  return health.status === 'healthy'
    ? pass('sdk returned healthy')
    : warn(`sdk returned ${health.status}`);
}

async function testHealthHeaders(): Promise<CaseResult> {
  const response = await request('/api/health');
  expect(response.headers.get('content-type')?.includes('application/json') === true, 'health content-type must be json');
  expect(response.headers.get('access-control-allow-origin') === '*', 'health should allow all origins');
  return pass(`content-type=${response.headers.get('content-type')}`);
}

async function testMethodMatrix(): Promise<CaseResult> {
  const endpoints = [
    { path: '/api/health', allowed: ['GET', 'OPTIONS'] as string[] },
    { path: '/api/analyze-text', allowed: ['POST', 'OPTIONS'] as string[] },
    { path: '/api/markets/arbitrage', allowed: ['GET', 'OPTIONS'] as string[] },
    { path: '/api/markets/movers', allowed: ['GET', 'OPTIONS'] as string[] },
    { path: '/api/feed', allowed: ['GET', 'OPTIONS'] as string[] },
    { path: '/api/feed/stats', allowed: ['GET', 'OPTIONS'] as string[] },
    { path: '/api/feed/accounts', allowed: ['GET', 'OPTIONS'] as string[] },
  ];
  const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
  const notes: string[] = [];
  let sawWarning = false;

  for (const endpoint of endpoints) {
    for (const method of methods) {
      const response = await request(endpoint.path, buildMethodMatrixRequest(method, endpoint.path));
      const allowed = endpoint.allowed.includes(method as 'GET' | 'POST' | 'OPTIONS');

      if (allowed) {
        if (![200, 204, 503].includes(response.status)) {
          return fail(`${method} ${endpoint.path} expected success/degraded, got ${response.status}`);
        }
      } else if (![405, 400].includes(response.status)) {
        return fail(`${method} ${endpoint.path} expected 405/400, got ${response.status}`);
      }

      if (!allowed && !response.headers.get('allow')) {
        sawWarning = true;
      }
    }

    notes.push(endpoint.path);
  }

  return sawWarning
    ? warn(`validated ${notes.length} endpoints; some 405 responses do not include Allow header`)
    : pass(`validated ${notes.length} endpoints`);
}

async function testAnalyzeTextOptions(): Promise<CaseResult> {
  const response = await request('/api/analyze-text', {
    method: 'OPTIONS',
  });

  expect([200, 204].includes(response.status), `expected 200 or 204, got ${response.status}`);
  expect(
    response.headers.get('access-control-allow-methods')?.includes('POST') === true,
    'analyze-text preflight should advertise POST',
  );
  return pass(`preflight status ${response.status}`);
}

async function testAnalyzeTextHappyPath(): Promise<CaseResult> {
  const response = await request('/api/analyze-text', {
    method: 'POST',
    body: JSON.stringify({
      text: 'Bitcoin just hit $100k and prediction markets are reacting fast.',
      minConfidence: 0.3,
      maxResults: 5,
    }),
  });

  if (response.status === 503) {
    return warn(extractError(response));
  }

  expect(response.status === 200, `expected 200, got ${response.status}`);
  expect(response.json.success === true, 'analyze-text success must be true');
  expect(typeof response.json.event_id === 'string', 'event_id missing');
  expect(Array.isArray(response.json.data?.markets), 'markets must be an array');
  expect(typeof response.json.data?.metadata?.processing_time_ms === 'number', 'processing_time_ms missing');
  validateAnalyzeTextResponse(response);
  return pass(`returned ${response.json.data.markets.length} matches`);
}

async function testAnalyzeTextNoMatch(): Promise<CaseResult> {
  const response = await request('/api/analyze-text', {
    method: 'POST',
    body: JSON.stringify({
      text: 'zzzxqv no obvious prediction market semantics here',
      minConfidence: 0.95,
      maxResults: 1,
    }),
  });

  if (response.status === 503) {
    return warn(extractError(response));
  }

  expect(response.status === 200, `expected 200, got ${response.status}`);
  expect(response.json.success === true, 'no-match request should still succeed');
  expect(Array.isArray(response.json.data?.markets), 'markets must be an array');
  validateAnalyzeTextResponse(response);
  return pass(`returned ${response.json.data.markets.length} matches`);
}

async function testAnalyzeTextMethodGuard(): Promise<CaseResult> {
  const response = await request('/api/analyze-text');
  expect(response.status === 405, `expected 405, got ${response.status}`);
  return pass('GET rejected with 405');
}

async function testAnalyzeTextMissingText(): Promise<CaseResult> {
  const response = await request('/api/analyze-text', {
    method: 'POST',
    body: JSON.stringify({}),
  });
  expect(response.status === 400, `expected 400, got ${response.status}`);
  assertNoSensitiveLeak(response, 'missing-text error');
  return pass(extractError(response));
}

async function testAnalyzeTextEmptyString(): Promise<CaseResult> {
  const response = await request('/api/analyze-text', {
    method: 'POST',
    body: JSON.stringify({ text: '' }),
  });
  expect(response.status === 400, `expected 400, got ${response.status}`);
  assertNoSensitiveLeak(response, 'empty-string error');
  return pass(extractError(response));
}

async function testAnalyzeTextNullBody(): Promise<CaseResult> {
  const response = await request('/api/analyze-text', {
    method: 'POST',
    body: 'null',
  });
  expect([400, 500].includes(response.status), `expected 400 or 500, got ${response.status}`);
  assertNoSensitiveLeak(response, 'null-body response');
  return response.status === 400 ? pass('null body rejected with 400') : warn('null body caused 500 but stayed sanitized');
}

async function testAnalyzeTextArrayBody(): Promise<CaseResult> {
  const response = await request('/api/analyze-text', {
    method: 'POST',
    body: JSON.stringify(['not-an-object']),
  });
  expect([400, 500].includes(response.status), `expected 400 or 500, got ${response.status}`);
  assertNoSensitiveLeak(response, 'array-body response');
  return response.status === 400 ? pass('array body rejected with 400') : warn('array body caused 500 but stayed sanitized');
}

async function testAnalyzeTextObjectText(): Promise<CaseResult> {
  const response = await request('/api/analyze-text', {
    method: 'POST',
    body: JSON.stringify({ text: { nested: true } }),
  });
  expect(response.status === 400, `expected 400, got ${response.status}`);
  assertNoSensitiveLeak(response, 'object-text response');
  return pass(extractError(response));
}

async function testAnalyzeTextNaNMinConfidence(): Promise<CaseResult> {
  const response = await request('/api/analyze-text', {
    method: 'POST',
    body: JSON.stringify({ text: 'Macro shock incoming', minConfidence: 'NaN' }),
  });
  expect(response.status === 400, `expected 400, got ${response.status}`);
  return pass(extractError(response));
}

async function testAnalyzeTextInfinityMinConfidence(): Promise<CaseResult> {
  const response = await request('/api/analyze-text', {
    method: 'POST',
    body: JSON.stringify({ text: 'Macro shock incoming', minConfidence: Infinity }),
  });
  expect([400, 500].includes(response.status), `expected 400 or 500, got ${response.status}`);
  assertNoSensitiveLeak(response, 'infinity-minConfidence response');
  return response.status === 400 ? pass(extractError(response)) : warn('Infinity minConfidence caused 500 but stayed sanitized');
}

async function testAnalyzeTextWhitespaceOnly(): Promise<CaseResult> {
  const response = await request('/api/analyze-text', {
    method: 'POST',
    body: JSON.stringify({ text: '   \n\t   ' }),
  });

  assertNoSensitiveLeak(response, 'whitespace-only response');

  if (response.status === 400) {
    return pass(extractError(response));
  }

  if (response.status === 200) {
    validateAnalyzeTextResponse(response);
    if (response.json.data.markets.length === 0) {
      return pass('accepted whitespace-only text but returned 0 matches');
    }

    return warn(`accepted whitespace-only text and returned ${response.json.data.markets.length} matches`);
  }

  return fail(`unexpected status ${response.status}`);
}

async function testAnalyzeTextInvalidMinConfidence(): Promise<CaseResult> {
  const response = await request('/api/analyze-text', {
    method: 'POST',
    body: JSON.stringify({ text: 'Election odds spiking', minConfidence: -0.1 }),
  });
  expect(response.status === 400, `expected 400, got ${response.status}`);
  assertNoSensitiveLeak(response, 'invalid-minConfidence error');
  return pass(extractError(response));
}

async function testAnalyzeTextInvalidMaxResults(): Promise<CaseResult> {
  const response = await request('/api/analyze-text', {
    method: 'POST',
    body: JSON.stringify({ text: 'Fed surprise', maxResults: 101 }),
  });
  expect(response.status === 400, `expected 400, got ${response.status}`);
  assertNoSensitiveLeak(response, 'invalid-maxResults error');
  return pass(extractError(response));
}

async function testAnalyzeTextOverlongText(): Promise<CaseResult> {
  const response = await request('/api/analyze-text', {
    method: 'POST',
    body: JSON.stringify({ text: 'a'.repeat(10001) }),
  });
  expect(response.status === 400, `expected 400, got ${response.status}`);
  assertNoSensitiveLeak(response, 'overlong-text error');
  return pass(extractError(response));
}

async function testAnalyzeTextUnicodePayload(): Promise<CaseResult> {
  const payload = '比特币 🚀 CPI 预期変化 سوق prediction odds';
  const response = await request('/api/analyze-text', {
    method: 'POST',
    body: JSON.stringify({ text: payload, minConfidence: 0.3, maxResults: 3 }),
  });

  assertNoSensitiveLeak(response, 'unicode payload');
  if (response.status === 503) return warn(extractError(response));
  expect(response.status === 200, `expected 200, got ${response.status}`);
  validateAnalyzeTextResponse(response);
  return pass(`handled unicode payload with ${response.json.data.markets.length} matches`);
}

async function testAnalyzeTextControlChars(): Promise<CaseResult> {
  const payload = 'log-line-1\n[ERROR] forged line\t\u0000control';
  const response = await request('/api/analyze-text', {
    method: 'POST',
    body: JSON.stringify({ text: payload, minConfidence: 0.3, maxResults: 3 }),
  });

  assertNoSensitiveLeak(response, 'control-char payload');
  if (response.status === 503) return warn(extractError(response));
  expect(response.status === 200, `expected 200, got ${response.status}`);
  validateAnalyzeTextResponse(response);
  return pass(`handled control-character payload with ${response.json.data.markets.length} matches`);
}

async function testAnalyzeTextHtmlPayload(): Promise<CaseResult> {
  const payload = '<script>alert("xss")</script><img src=x onerror=alert(1) />';
  const response = await request('/api/analyze-text', {
    method: 'POST',
    body: JSON.stringify({ text: payload, minConfidence: 0.4, maxResults: 3 }),
  });

  assertNoSensitiveLeak(response, 'html-payload response');
  ensureNoUnsafeReflection(response, payload, 'html payload');

  if (response.status === 503) {
    return warn(extractError(response));
  }

  expect(response.status === 200, `expected 200, got ${response.status}`);
  validateAnalyzeTextResponse(response);
  return pass(`handled html payload with ${response.json.data.markets.length} matches`);
}

async function testAnalyzeTextInjectionPayload(): Promise<CaseResult> {
  const payload = "'; DROP TABLE markets; -- {{7*7}} ../../etc/passwd";
  const response = await request('/api/analyze-text', {
    method: 'POST',
    body: JSON.stringify({ text: payload, minConfidence: 0.4, maxResults: 3 }),
  });

  assertNoSensitiveLeak(response, 'injection-payload response');
  ensureNoUnsafeReflection(response, payload, 'injection payload');

  if (response.status === 503) {
    return warn(extractError(response));
  }

  expect(response.status === 200, `expected 200, got ${response.status}`);
  validateAnalyzeTextResponse(response);
  return pass(`handled injection-like payload with ${response.json.data.markets.length} matches`);
}

async function testAnalyzeTextMalformedJson(): Promise<CaseResult> {
  const response = await request('/api/analyze-text', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: '{"text":"broken",}',
  });

  if ([400, 405].includes(response.status)) {
    assertNoSensitiveLeak(response, 'malformed-json error');
    return pass(`status ${response.status}`);
  }

  if (response.status === 500) {
    assertNoSensitiveLeak(response, 'malformed-json 500');
    return warn('malformed json caused 500 but without sensitive leakage');
  }

  return fail(`unexpected status ${response.status}`);
}

async function testAnalyzeTextWrongContentType(): Promise<CaseResult> {
  const response = await request('/api/analyze-text', {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain',
    },
    body: JSON.stringify({ text: 'Bitcoin up only' }),
  });

  assertNoSensitiveLeak(response, 'wrong-content-type response');

  if ([200, 400, 415].includes(response.status)) {
    if (response.status === 200) {
      validateAnalyzeTextResponse(response);
    }
    return pass(`status ${response.status}`);
  }

  if (response.status === 500) {
    return warn('wrong content-type caused 500 but response stayed sanitized');
  }

  return fail(`unexpected status ${response.status}`);
}

async function testAnalyzeTextFormUrlEncoded(): Promise<CaseResult> {
  const response = await request('/api/analyze-text', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'text=Bitcoin%20pumps',
  });

  assertNoSensitiveLeak(response, 'form-urlencoded response');
  if ([200, 400, 415].includes(response.status)) {
    if (response.status === 200) validateAnalyzeTextResponse(response);
    return pass(`status ${response.status}`);
  }

  return fail(`unexpected status ${response.status}`);
}

async function testArbitrageHappyPath(): Promise<CaseResult> {
  const response = await request('/api/markets/arbitrage?minSpread=0.03&minConfidence=0.5&limit=5');

  if (response.status === 503) {
    return warn(extractError(response));
  }

  expect(response.status === 200, `expected 200, got ${response.status}`);
  expect(response.json.success === true, 'arbitrage success must be true');
  expect(Array.isArray(response.json.data?.opportunities), 'opportunities must be an array');
  expect(response.json.data?.filters?.limit === 5, 'limit filter should echo 5');
  validateArbitrageResponse(response);
  return pass(`returned ${response.json.data.count} opportunities`);
}

async function testArbitrageInvalidMinSpread(): Promise<CaseResult> {
  const response = await request('/api/markets/arbitrage?minSpread=-1');
  expect(response.status === 400, `expected 400, got ${response.status}`);
  return pass(extractError(response));
}

async function testArbitrageInvalidMinConfidence(): Promise<CaseResult> {
  const response = await request('/api/markets/arbitrage?minConfidence=1.5');
  expect(response.status === 400, `expected 400, got ${response.status}`);
  return pass(extractError(response));
}

async function testArbitrageInvalidLimit(): Promise<CaseResult> {
  const response = await request('/api/markets/arbitrage?limit=0');
  expect(response.status === 400, `expected 400, got ${response.status}`);
  return pass(extractError(response));
}

async function testArbitrageDuplicateQueryParams(): Promise<CaseResult> {
  const response = await request('/api/markets/arbitrage?limit=2&limit=3&minSpread=0.01');
  assertNoSensitiveLeak(response, 'arbitrage duplicate-query response');

  if (response.status === 503) return warn(extractError(response));
  expect([200, 400].includes(response.status), `expected 200 or 400, got ${response.status}`);
  if (response.status === 200) validateArbitrageResponse(response);
  return pass(`status ${response.status}`);
}

async function testArbitrageCategoryFilter(): Promise<CaseResult> {
  const response = await request('/api/markets/arbitrage?category=crypto&limit=3&minSpread=0.01');

  if (response.status === 503) return warn(extractError(response));
  expect(response.status === 200, `expected 200, got ${response.status}`);
  validateArbitrageResponse(response);
  expect(response.json.data.filters.category === 'crypto', 'arbitrage category filter should echo crypto');
  for (const item of response.json.data.opportunities as any[]) {
    expect(
      item.polymarket.category === 'crypto' || item.kalshi.category === 'crypto',
      'arbitrage category filter returned non-crypto opportunity',
    );
  }
  return pass(`returned ${response.json.data.count} crypto opportunities`);
}

async function testMoversHappyPath(): Promise<CaseResult> {
  const response = await request('/api/markets/movers?minChange=0.05&limit=5');

  if (response.status === 503) {
    return warn(extractError(response));
  }

  expect(response.status === 200, `expected 200, got ${response.status}`);
  expect(response.json.success === true, 'movers success must be true');
  expect(Array.isArray(response.json.data?.movers), 'movers must be an array');
  validateMoversResponse(response);
  return pass(`returned ${response.json.data.count} movers`);
}

async function testMoversInvalidMinChange(): Promise<CaseResult> {
  const response = await request('/api/markets/movers?minChange=2');
  expect(response.status === 400, `expected 400, got ${response.status}`);
  return pass(extractError(response));
}

async function testMoversInvalidLimit(): Promise<CaseResult> {
  const response = await request('/api/markets/movers?limit=0');
  expect(response.status === 400, `expected 400, got ${response.status}`);
  return pass(extractError(response));
}

async function testMoversCategoryFilter(): Promise<CaseResult> {
  const response = await request('/api/markets/movers?category=crypto&limit=5&minChange=0.01');

  if (response.status === 503) return warn(extractError(response));
  expect(response.status === 200, `expected 200, got ${response.status}`);
  validateMoversResponse(response);
  expect(response.json.data.filters.category === 'crypto', 'movers category filter should echo crypto');
  for (const item of response.json.data.movers as any[]) {
    expect(item.market.category === 'crypto', 'movers category filter returned non-crypto market');
  }
  return pass(`returned ${response.json.data.count} crypto movers`);
}

async function testFeedHappyPath(): Promise<CaseResult> {
  const response = await request('/api/feed?limit=3', {
    headers: {
      'x-client-id': CLIENT_ID,
    },
  });

  if (response.status === 503) {
    return warn(extractError(response));
  }

  expect(response.status === 200, `expected 200, got ${response.status}`);
  expect(response.json.success === true, 'feed success must be true');
  expect(Array.isArray(response.json.data?.tweets), 'tweets must be an array');
  expect(response.json.data?.filters?.limit === 3, 'feed limit filter should echo 3');
  expect(typeof response.json.data?.metadata?.processing_time_ms === 'number', 'feed processing_time_ms missing');
  validateFeedResponse(response);
  return pass(`returned ${response.json.data.count} tweets`);
}

async function testFeedInvalidCategory(): Promise<CaseResult> {
  const response = await request('/api/feed?category=not_real');
  expect(response.status === 400, `expected 400, got ${response.status}`);
  assertNoSensitiveLeak(response, 'feed invalid-category error');
  return pass(extractError(response));
}

async function testFeedInvalidMinUrgency(): Promise<CaseResult> {
  const response = await request('/api/feed?minUrgency=urgent');
  expect(response.status === 400, `expected 400, got ${response.status}`);
  assertNoSensitiveLeak(response, 'feed invalid-minUrgency error');
  return pass(extractError(response));
}

async function testFeedInvalidLimit(): Promise<CaseResult> {
  const response = await request('/api/feed?limit=-1');
  expect(response.status === 400, `expected 400, got ${response.status}`);
  assertNoSensitiveLeak(response, 'feed invalid-limit error');
  return pass(extractError(response));
}

async function testFeedInvalidSince(): Promise<CaseResult> {
  const response = await request('/api/feed?since=not-a-date');
  assertNoSensitiveLeak(response, 'feed invalid-since response');

  if (response.status === 400) {
    return pass(extractError(response));
  }

  if (response.status === 200) {
    return warn('invalid since timestamp was accepted; expected 400');
  }

  return fail(`unexpected status ${response.status}`);
}

async function testFeedDuplicateQueryParams(): Promise<CaseResult> {
  const response = await request('/api/feed?limit=1&limit=2');
  assertNoSensitiveLeak(response, 'feed duplicate-query response');
  expect([200, 400, 503].includes(response.status), `expected 200, 400, or 503, got ${response.status}`);
  if (response.status === 200) validateFeedResponse(response);
  return response.status === 503 ? warn(extractError(response)) : pass(`status ${response.status}`);
}

async function testFeedCursorPagination(): Promise<CaseResult> {
  const first = await request('/api/feed?limit=2', {
    headers: {
      'x-client-id': `${CLIENT_ID}-cursor`,
    },
  });

  if (first.status === 503) return warn(extractError(first));
  expect(first.status === 200, `expected 200, got ${first.status}`);
  validateFeedResponse(first);

  const cursor = first.json.data.cursor;
  if (!cursor) {
    return warn('feed returned no cursor for limit=2; cannot verify second page');
  }

  const second = await request(`/api/feed?limit=2&cursor=${encodeURIComponent(cursor)}`, {
    headers: {
      'x-client-id': `${CLIENT_ID}-cursor`,
    },
  });

  if (second.status === 503) return warn(extractError(second));
  expect(second.status === 200, `expected 200, got ${second.status}`);
  validateFeedResponse(second);

  const firstIds = new Set((first.json.data.tweets as any[]).map(tweet => tweet.tweet.id));
  const overlap = (second.json.data.tweets as any[]).filter(tweet => firstIds.has(tweet.tweet.id)).length;
  expect(overlap === 0, 'feed cursor pagination should not duplicate tweets across pages');
  return pass(`page1=${first.json.data.count} page2=${second.json.data.count}`);
}

async function testFeedRepeatedRequestStability(): Promise<CaseResult> {
  const one = await request('/api/feed?limit=3&category=crypto');
  const two = await request('/api/feed?limit=3&category=crypto');

  if (one.status === 503 || two.status === 503) return warn(`statuses ${one.status}/${two.status}`);
  expect(one.status === 200 && two.status === 200, `expected 200/200, got ${one.status}/${two.status}`);
  validateFeedResponse(one);
  validateFeedResponse(two);
  expect(one.json.data.filters.category === two.json.data.filters.category, 'feed filters should stay stable');
  return pass(`counts ${one.json.data.count}/${two.json.data.count}`);
}

async function testFeedOversizedClientId(): Promise<CaseResult> {
  const response = await request('/api/feed?limit=1', {
    headers: {
      'x-client-id': `client-${'x'.repeat(2048)}`,
    },
  });

  assertNoSensitiveLeak(response, 'oversized-client-id response');
  if (response.status === 503) return warn(extractError(response));
  expect([200, 400].includes(response.status), `expected 200 or 400, got ${response.status}`);
  if (response.status === 200) validateFeedResponse(response);
  return pass(`status ${response.status}`);
}

async function testFeedSpecialClientId(): Promise<CaseResult> {
  const response = await request('/api/feed?limit=1', {
    headers: {
      'x-client-id': 'client-id:with/special?chars=ok|plus',
    },
  });

  assertNoSensitiveLeak(response, 'special-client-id response');
  if (response.status === 503) return warn(extractError(response));
  expect([200, 400].includes(response.status), `expected 200 or 400, got ${response.status}`);
  if (response.status === 200) validateFeedResponse(response);
  return pass(`status ${response.status}`);
}

async function testFeedOptions(): Promise<CaseResult> {
  const response = await request('/api/feed', {
    method: 'OPTIONS',
  });

  expect([200, 204].includes(response.status), `expected 200 or 204, got ${response.status}`);
  expect(
    response.headers.get('access-control-allow-methods')?.includes('GET') === true,
    'feed preflight should advertise GET',
  );
  return pass(`preflight status ${response.status}`);
}

async function testFeedStatsHappyPath(): Promise<CaseResult> {
  const response = await request('/api/feed/stats');

  if (response.status === 503) {
    return warn(extractError(response));
  }

  expect(response.status === 200, `expected 200, got ${response.status}`);
  expect(response.json.success === true, 'feed stats success must be true');
  expect(typeof response.json.data?.tweets?.last_1h === 'number', 'last_1h missing');
  expect(typeof response.json.data?.metadata?.processing_time_ms === 'number', 'stats processing_time_ms missing');
  validateFeedStatsResponse(response);
  return pass('stats payload shape looks valid');
}

async function testFeedAccounts(): Promise<CaseResult> {
  const response = await request('/api/feed/accounts');
  expect(response.status === 200, `expected 200, got ${response.status}`);
  expect(response.json.success === true, 'feed accounts success must be true');
  expect(Array.isArray(response.json.data?.accounts), 'accounts must be an array');
  expect(response.json.data?.count === response.json.data?.accounts.length, 'count should match accounts length');
  validateAccountsResponse(response);
  return pass(`returned ${response.json.data.count} accounts`);
}

async function testCacheHeaders(): Promise<CaseResult> {
  const responses = await Promise.all([
    request('/api/feed?limit=1'),
    request('/api/feed/stats'),
    request('/api/feed/accounts'),
  ]);

  const missing = responses.filter(response => !response.headers.get('cache-control')).length;
  if (missing > 0) {
    return warn(`${missing} cacheable endpoint(s) missing Cache-Control`);
  }

  return pass('cache-control present on feed/feed-stats/feed-accounts');
}

async function testErrorLeakage(): Promise<CaseResult> {
  const responses = await Promise.all([
    request('/api/analyze-text', {
      method: 'POST',
      body: JSON.stringify({ text: 'a'.repeat(10001) }),
    }),
    request('/api/feed?limit=-1'),
    request('/api/markets/arbitrage?minSpread=-1'),
  ]);

  for (const response of responses) {
    assertNoSensitiveLeak(response, `error status ${response.status}`);
  }

  return pass(`checked ${responses.length} error responses`);
}

async function testUsageAudit(): Promise<CaseResult> {
  const headers = {
    'x-client-id': CLIENT_ID,
  };

  await request('/api/feed?limit=2', { headers });
  await request('/api/markets/arbitrage?minSpread=0.03&limit=2', { headers });

  const response = await request('/api/internal/usage', {
    headers: {
      'x-admin-key': ADMIN_KEY as string,
    },
  });

  if (response.status === 404) {
    return warn('usage endpoint not deployed on this branch/environment');
  }

  expect(response.status === 200, `expected 200, got ${response.status}`);
  expect(Array.isArray(response.json.top_endpoints), 'top_endpoints must be an array');
  expect(Array.isArray(response.json.top_callers), 'top_callers must be an array');
  return pass('usage endpoint returned aggregate data');
}

async function testUsageAuditMissingAdminKey(): Promise<CaseResult> {
  const response = await request('/api/internal/usage');

  if (response.status === 404) {
    return warn('usage endpoint not deployed on this branch/environment');
  }

  expect([401, 403].includes(response.status), `expected 401 or 403, got ${response.status}`);
  assertNoSensitiveLeak(response, 'usage missing-admin-key response');
  return pass(`status ${response.status}`);
}

async function testUsageAuditInvalidAdminKey(): Promise<CaseResult> {
  const response = await request('/api/internal/usage', {
    headers: {
      'x-admin-key': 'definitely-not-valid',
    },
  });

  if (response.status === 404) {
    return warn('usage endpoint not deployed on this branch/environment');
  }

  expect([401, 403].includes(response.status), `expected 401 or 403, got ${response.status}`);
  assertNoSensitiveLeak(response, 'usage invalid-admin-key response');
  return pass(`status ${response.status}`);
}

async function testUsageAuditBearerAuth(): Promise<CaseResult> {
  const response = await request('/api/internal/usage', {
    headers: {
      Authorization: `Bearer ${ADMIN_KEY as string}`,
    },
  });

  if (response.status === 404) {
    return warn('usage endpoint not deployed on this branch/environment');
  }

  if ([401, 403].includes(response.status)) {
    assertNoSensitiveLeak(response, 'usage bearer-auth rejection');
    return warn(`bearer auth rejected with ${response.status}`);
  }

  expect(response.status === 200, `expected 200, got ${response.status}`);
  return pass('bearer auth accepted');
}

async function testUsageAuditMixedHeaders(): Promise<CaseResult> {
  const response = await request('/api/internal/usage', {
    headers: {
      'x-admin-key': 'definitely-wrong',
      Authorization: `Bearer ${ADMIN_KEY as string}`,
      'x-client-id': CLIENT_ID,
    },
  });

  if (response.status === 404) {
    return warn('usage endpoint not deployed on this branch/environment');
  }

  if ([200, 401, 403].includes(response.status)) {
    assertNoSensitiveLeak(response, 'usage mixed-header response');
    return pass(`status ${response.status}`);
  }

  return fail(`unexpected status ${response.status}`);
}

async function testUsageAuditConsistency(): Promise<CaseResult> {
  const tag = `${CLIENT_ID}-usage`;
  await request('/api/feed?limit=1', { headers: { 'x-client-id': tag } });
  await request('/api/feed?limit=1', { headers: { 'x-client-id': tag } });
  await request('/api/markets/arbitrage?limit=1', { headers: { 'x-client-id': tag } });

  const response = await request('/api/internal/usage?limit=50', {
    headers: {
      'x-admin-key': ADMIN_KEY as string,
    },
  });

  if (response.status === 404) return warn('usage endpoint not deployed on this branch/environment');
  expect(response.status === 200, `expected 200, got ${response.status}`);

  const serialized = JSON.stringify(response.json).toLowerCase();
  if (!serialized.includes('/api/feed') || !serialized.includes('/api/markets/arbitrage')) {
    return warn('usage response returned aggregate data but did not clearly show recent endpoint traffic');
  }

  return pass('usage response includes recent endpoint traffic aggregates');
}

async function testWarmLatencyBenchmark(): Promise<CaseResult> {
  const cases = [
    { label: 'health', path: '/api/health', options: undefined },
    { label: 'feed', path: '/api/feed?limit=3', options: { headers: { 'x-client-id': CLIENT_ID } } },
    { label: 'accounts', path: '/api/feed/accounts', options: undefined },
    {
      label: 'analyze-text',
      path: '/api/analyze-text',
      options: {
        method: 'POST',
        body: JSON.stringify({ text: 'Bitcoin and CPI odds moving together', maxResults: 3 }),
      },
    },
  ] as const;

  const summaries: string[] = [];
  let sawWarning = false;

  for (const entry of cases) {
    const samples: number[] = [];

    for (let i = 0; i < LATENCY_SAMPLE_SIZE; i++) {
      const response = await request(entry.path, entry.options);
      if (![200, 503].includes(response.status)) {
        return fail(`${entry.label} benchmark got status ${response.status}`);
      }
      samples.push(response.durationMs);
    }

    const stats = summarizeLatencies(samples);
    summaries.push(`${entry.label} avg=${stats.avg}ms p95=${stats.p95}ms max=${stats.max}ms`);
    if (stats.p95 > getLatencyWarnThreshold(entry.label)) {
      sawWarning = true;
    }
  }

  return sawWarning ? warn(summaries.join('; ')) : pass(summaries.join('; '));
}

async function testColdStartProbe(): Promise<CaseResult> {
  const cases = [
    { label: 'health', path: '/api/health', options: undefined },
    {
      label: 'analyze-text',
      path: '/api/analyze-text',
      options: {
        method: 'POST',
        body: JSON.stringify({ text: 'Cold start probe for Bitcoin CPI odds', maxResults: 3 }),
      },
    },
  ] as const;

  const summaries: string[] = [];
  let sawWarning = false;

  for (const entry of cases) {
    const coldSamples: number[] = [];
    const warmSamples: number[] = [];

    for (let i = 0; i < COLD_SAMPLE_SIZE; i++) {
      if (i > 0) {
        await sleep(COLD_IDLE_MS);
      }

      const cold = await request(entry.path, entry.options);
      if (![200, 503].includes(cold.status)) {
        return fail(`${entry.label} cold probe got status ${cold.status}`);
      }

      const warm = await request(entry.path, entry.options);
      if (![200, 503].includes(warm.status)) {
        return fail(`${entry.label} warm follow-up got status ${warm.status}`);
      }

      coldSamples.push(cold.durationMs);
      warmSamples.push(warm.durationMs);
    }

    const coldStats = summarizeLatencies(coldSamples);
    const warmStats = summarizeLatencies(warmSamples);
    const delta = coldStats.avg - warmStats.avg;
    summaries.push(
      `${entry.label} cold_avg=${coldStats.avg}ms warm_avg=${warmStats.avg}ms delta=${delta}ms idle=${COLD_IDLE_MS}ms samples=${COLD_SAMPLE_SIZE}`,
    );

    if (delta < 0) {
      sawWarning = true;
    }
  }

  return sawWarning
    ? warn(`best-effort only: ${summaries.join('; ')}`)
    : pass(`best-effort only: ${summaries.join('; ')}`);
}

async function testConcurrentRequestStability(): Promise<CaseResult> {
  const requests = Array.from({ length: CONCURRENCY_LEVEL }, (_, index) =>
    request(`/api/feed?limit=2&category=${index % 2 === 0 ? 'crypto' : 'politics'}`, {
      headers: {
        'x-client-id': `${CLIENT_ID}-concurrent-${index}`,
      },
    }),
  );
  const responses = await Promise.all(requests);
  const failures = responses.filter(response => ![200, 503].includes(response.status));
  if (failures.length > 0) {
    return fail(`${failures.length}/${responses.length} concurrent feed requests returned unexpected status`);
  }
  const degraded = responses.filter(response => response.status === 503).length;
  return degraded > 0
    ? warn(`${degraded}/${responses.length} concurrent requests degraded`)
    : pass(`${responses.length} concurrent requests succeeded`);
}

async function testBurstTrafficStability(): Promise<CaseResult> {
  const responses = await Promise.all(
    Array.from({ length: BURST_REQUESTS }, (_, index) =>
      request('/api/analyze-text', {
        method: 'POST',
        headers: {
          'x-client-id': `${CLIENT_ID}-burst-${index}`,
        },
        body: JSON.stringify({
          text: `Burst request ${index} for Bitcoin CPI odds`,
          maxResults: 2,
        }),
      }),
    ),
  );

  const counts = summarizeStatuses(responses.map(response => response.status));
  const failures = responses.filter(response => ![200, 503, 429].includes(response.status));
  if (failures.length > 0) {
    return fail(`unexpected burst statuses: ${formatStatusSummary(counts)}`);
  }

  if (counts['429'] || counts['503']) {
    return warn(`burst returned ${formatStatusSummary(counts)}`);
  }

  return pass(`burst returned ${formatStatusSummary(counts)}`);
}

async function request(path: string, init: RequestInit = {}): Promise<HttpResult> {
  const startedAt = Date.now();

  try {
    const response = await curlRequest(`${BASE_URL}${path}`, init);
    return withParsedJson(response, Date.now() - startedAt);
  } finally {
  }
}

async function curlRequest(url: string, init: RequestInit = {}): Promise<{
  status: number;
  text: string;
  headers: Headers;
  finalUrl: string;
}> {
  const headers = new Headers(init.headers || {});
  if (!headers.has('Content-Type') && init.body) {
    headers.set('Content-Type', 'application/json');
  }
  if (VERCEL_AUTOMATION_BYPASS_SECRET) {
    headers.set('x-vercel-protection-bypass', VERCEL_AUTOMATION_BYPASS_SECRET);
    headers.set('x-vercel-set-bypass-cookie', 'true');
  }

  const args = [
    '--silent',
    '--show-error',
    '--location',
    '--max-redirs',
    '10',
    '--connect-timeout',
    String(Math.max(1, Math.ceil(TIMEOUT_MS / 1000))),
    '--max-time',
    String(Math.max(1, Math.ceil(TIMEOUT_MS / 1000))),
    '--cookie',
    COOKIE_JAR_PATH,
    '--cookie-jar',
    COOKIE_JAR_PATH,
    '--dump-header',
    '-',
    '--write-out',
    '\n__CURL_META__%{http_code}\t%{url_effective}',
  ];
  const method = (init.method || 'GET').toUpperCase();

  if (method === 'HEAD') {
    args.push('--head');
  } else {
    args.push('--request', method);
  }

  headers.forEach((value, key) => {
    args.push('--header', `${key}: ${value}`);
  });

  if (init.body !== undefined && init.body !== null) {
    args.push('--data-binary', stringifyRequestBody(init.body));
  }

  args.push(url);

  const output = await runCurl(args);
  return parseCurlOutput(output);
}

function runCurl(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('curl', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, TIMEOUT_MS + 250);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.on('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timeout);

      if (timedOut) {
        reject(new Error(`request timed out after ${TIMEOUT_MS}ms`));
        return;
      }

      if (code !== 0) {
        reject(new Error(stderr.trim() || `curl exited with code ${code}`));
        return;
      }

      resolve(stdout);
    });
  });
}

function installCurlBackedFetch(): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const requestLike = input instanceof Request ? input : null;
    const url = requestLike ? requestLike.url : String(input);
    const mergedInit: RequestInit = {
      method: requestLike?.method,
      headers: requestLike?.headers,
      body: requestLike?.body ? await requestLike.text() : undefined,
      ...init,
    };

    const response = await curlRequest(url, mergedInit);
    return new Response(response.text, {
      status: response.status,
      headers: response.headers,
    });
  }) as typeof fetch;
}

function parseCurlOutput(output: string): { status: number; text: string; headers: Headers; finalUrl: string } {
  const marker = '\n__CURL_META__';
  const markerIndex = output.lastIndexOf(marker);
  if (markerIndex === -1) {
    throw new Error('curl response metadata missing');
  }

  const payload = output.slice(0, markerIndex);
  const meta = output.slice(markerIndex + marker.length).trim();
  const tabIndex = meta.indexOf('\t');
  if (tabIndex === -1) {
    throw new Error(`invalid curl metadata: ${meta}`);
  }

  const status = Number(meta.slice(0, tabIndex));
  const finalUrl = meta.slice(tabIndex + 1);
  const parsed = splitCurlHeadersAndBody(payload);

  return {
    status,
    text: parsed.body,
    headers: withSyntheticFinalUrlHeader(parsed.headers, finalUrl),
    finalUrl,
  };
}

function splitCurlHeadersAndBody(payload: string): { headers: Headers; body: string } {
  const normalized = payload.replace(/\r\n/g, '\n');
  const separator = '\n\n';
  const lastSeparatorIndex = normalized.lastIndexOf(separator);

  if (lastSeparatorIndex === -1) {
    return {
      headers: new Headers(),
      body: normalized,
    };
  }

  const headerBlock = normalized.slice(0, lastSeparatorIndex);
  const body = normalized.slice(lastSeparatorIndex + separator.length);
  const headerSections = headerBlock
    .split(separator)
    .filter(section => /^HTTP\/\d(?:\.\d)? \d{3}/.test(section));
  const finalHeaderSection = headerSections[headerSections.length - 1] || '';
  const responseHeaders = new Headers();

  for (const line of finalHeaderSection.split('\n').slice(1)) {
    const index = line.indexOf(':');
    if (index === -1) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (key) responseHeaders.append(key, value);
  }

  return {
    headers: responseHeaders,
    body,
  };
}

function stringifyRequestBody(body: BodyInit | null): string {
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof ArrayBuffer) return Buffer.from(body).toString('utf8');
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('utf8');
  return String(body);
}

function withParsedJson(
  response: { status: number; text: string; headers: Headers; finalUrl: string },
  durationMs: number,
): HttpResult {
  let json: any = null;

  if (response.text) {
    try {
      json = JSON.parse(response.text);
    } catch {
      json = null;
    }
  }

  return {
    status: response.status,
    text: response.text,
    json,
    headers: response.headers,
    durationMs,
  };
}

function withSyntheticFinalUrlHeader(headers: Headers, finalUrl: string): Headers {
  const clone = new Headers(headers);
  clone.set('x-fetch-final-url', finalUrl);
  return clone;
}

function pass(detail: string): CaseResult {
  return { level: 'pass', detail };
}

function warn(detail: string): CaseResult {
  return { level: 'warn', detail };
}

function fail(detail: string): CaseResult {
  return { level: 'fail', detail };
}

function expect(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function expectJsonObject(value: unknown, message: string): void {
  if (!value || typeof value !== 'object') {
    throw new Error(message);
  }
}

function expectIsoTimestamp(value: unknown, message: string): void {
  expect(typeof value === 'string', message);
  const timestamp = value as string;
  expect(!Number.isNaN(new Date(timestamp).getTime()), message);
}

function extractError(response: HttpResult): string {
  if (response.json?.error) return String(response.json.error);
  if (response.text) return response.text.slice(0, 160);
  return `HTTP ${response.status}`;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'AbortError') {
      return `request timed out after ${TIMEOUT_MS}ms`;
    }

    const cause = formatErrorCause((error as Error & { cause?: unknown }).cause);
    return cause ? `${error.message} (${cause})` : error.message;
  }

  return String(error);
}

function formatErrorCause(cause: unknown): string {
  if (!cause) {
    return '';
  }

  if (cause instanceof Error) {
    const code = (cause as Error & { code?: string }).code;
    return code ? `${cause.name}: ${cause.message}; code=${code}` : `${cause.name}: ${cause.message}`;
  }

  if (typeof cause === 'object') {
    try {
      return JSON.stringify(cause);
    } catch {
      return String(cause);
    }
  }

  return String(cause);
}

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;

  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

function buildMethodMatrixRequest(method: string, path: string): RequestInit {
  if (method === 'POST' && path === '/api/analyze-text') {
    return {
      method,
      body: JSON.stringify({ text: 'Method matrix probe', maxResults: 1 }),
    };
  }

  if (method === 'HEAD') {
    return { method };
  }

  return { method };
}

function validateAnalyzeTextResponse(response: HttpResult): void {
  expect(response.headers.get('content-type')?.includes('application/json') === true, 'analyze-text content-type must be json');
  expect(response.json.data.matchCount === response.json.data.markets.length, 'matchCount should match markets length');
  expectIsoTimestamp(response.json.data.timestamp, 'analyze-text timestamp must be valid ISO');
  expect(typeof response.json.data.metadata.processing_time_ms === 'number', 'analyze-text processing_time_ms must be number');

  for (const match of response.json.data.markets as any[]) {
    validateMarketMatch(match);
  }
}

function validateArbitrageResponse(response: HttpResult): void {
  expect(response.headers.get('content-type')?.includes('application/json') === true, 'arbitrage content-type must be json');
  expect(response.json.data.count === response.json.data.opportunities.length, 'arbitrage count should match opportunities length');
  expectIsoTimestamp(response.json.data.timestamp, 'arbitrage timestamp must be valid ISO');

  for (const item of response.json.data.opportunities as any[]) {
    validateMarket(item.polymarket);
    validateMarket(item.kalshi);
    expect(typeof item.spread === 'number', 'arbitrage spread must be number');
    expect(typeof item.profitPotential === 'number', 'arbitrage profitPotential must be number');
    expect(['buy_poly_sell_kalshi', 'buy_kalshi_sell_poly'].includes(item.direction), 'arbitrage direction invalid');
    expect(typeof item.confidence === 'number', 'arbitrage confidence must be number');
  }
}

function validateMoversResponse(response: HttpResult): void {
  expect(response.headers.get('content-type')?.includes('application/json') === true, 'movers content-type must be json');
  expect(response.json.data.count === response.json.data.movers.length, 'movers count should match movers length');
  expectIsoTimestamp(response.json.data.timestamp, 'movers timestamp must be valid ISO');

  const movers = response.json.data.movers as any[];
  for (const item of movers) {
    validateMarket(item.market);
    expect(typeof item.priceChange1h === 'number', 'mover priceChange1h must be number');
    expect(typeof item.previousPrice === 'number', 'mover previousPrice must be number');
    expect(typeof item.currentPrice === 'number', 'mover currentPrice must be number');
    expect(['up', 'down'].includes(item.direction), 'mover direction invalid');
    expect(typeof item.timestamp === 'number', 'mover timestamp must be number');
  }

  for (let i = 1; i < movers.length; i++) {
    const prev = Math.abs(movers[i - 1].priceChange1h);
    const current = Math.abs(movers[i].priceChange1h);
    expect(prev >= current, 'movers should be sorted by absolute priceChange1h descending');
  }
}

function validateFeedResponse(response: HttpResult): void {
  expect(response.headers.get('content-type')?.includes('application/json') === true, 'feed content-type must be json');
  expect(response.json.data.count === response.json.data.tweets.length, 'feed count should match tweets length');
  expectIsoTimestamp(response.json.data.timestamp, 'feed timestamp must be valid ISO');

  for (const tweet of response.json.data.tweets as any[]) {
    expect(typeof tweet.tweet?.id === 'string' && tweet.tweet.id.length > 0, 'tweet id missing');
    expect(typeof tweet.tweet?.text === 'string', 'tweet text missing');
    expect(typeof tweet.tweet?.author === 'string', 'tweet author missing');
    expectIsoTimestamp(tweet.tweet?.created_at, 'tweet created_at must be valid ISO');
    expect(typeof tweet.tweet?.url === 'string', 'tweet url missing');
    expect(typeof tweet.confidence === 'number', 'tweet confidence must be number');
    expect(['low', 'medium', 'high', 'critical'].includes(tweet.urgency), 'tweet urgency invalid');
    expectIsoTimestamp(tweet.analyzed_at, 'tweet analyzed_at must be valid ISO');
    expectIsoTimestamp(tweet.collected_at, 'tweet collected_at must be valid ISO');
    expect(Array.isArray(tweet.matches), 'tweet matches must be an array');

    for (const match of tweet.matches as any[]) {
      validateMarketMatch(match);
    }
  }
}

function validateFeedStatsResponse(response: HttpResult): void {
  expect(response.headers.get('content-type')?.includes('application/json') === true, 'feed stats content-type must be json');
  expectIsoTimestamp(response.json.data.timestamp, 'feed stats timestamp must be valid ISO');
  if (response.json.data.last_collection !== 'Never') {
    expectIsoTimestamp(response.json.data.last_collection, 'feed stats last_collection must be valid ISO');
  }
  expect(typeof response.json.data.tweets.last_1h === 'number', 'last_1h must be number');
  expect(typeof response.json.data.tweets.last_6h === 'number', 'last_6h must be number');
  expect(typeof response.json.data.tweets.last_24h === 'number', 'last_24h must be number');
  expect(Array.isArray(response.json.data.top_markets), 'top_markets must be array');

  for (const item of response.json.data.top_markets as any[]) {
    validateMarket(item.market);
    expect(typeof item.mention_count === 'number', 'mention_count must be number');
  }
}

function validateAccountsResponse(response: HttpResult): void {
  expect(response.headers.get('content-type')?.includes('application/json') === true, 'feed accounts content-type must be json');
  for (const account of response.json.data.accounts as any[]) {
    expect(typeof account.username === 'string' && account.username.length > 0, 'account username missing');
    expect(typeof account.description === 'string', 'account description missing');
    expect([
      'politics',
      'economics',
      'crypto',
      'technology',
      'geopolitics',
      'sports',
      'breaking_news',
      'finance',
    ].includes(account.category), 'account category invalid');
    expect(['high', 'medium'].includes(account.priority), 'account priority invalid');
  }
}

function validateMarketMatch(match: any): void {
  validateMarket(match.market);
  expect(typeof match.confidence === 'number', 'market match confidence must be number');
  expect(Array.isArray(match.matchedKeywords), 'matchedKeywords must be array');
}

function validateMarket(market: any): void {
  expect(typeof market?.id === 'string' && market.id.length > 0, 'market id missing');
  expect(['kalshi', 'polymarket'].includes(market.platform), 'market platform invalid');
  expect(typeof market.title === 'string' && market.title.length > 0, 'market title missing');
  expect(typeof market.description === 'string', 'market description missing');
  expect(typeof market.yesPrice === 'number', 'market yesPrice must be number');
  expect(typeof market.noPrice === 'number', 'market noPrice must be number');
  expect(typeof market.volume24h === 'number', 'market volume24h must be number');
  expect(typeof market.url === 'string', 'market url missing');
  expect(typeof market.category === 'string', 'market category missing');
  expectIsoTimestamp(market.lastUpdated, 'market lastUpdated must be valid ISO');
}

function assertNoSensitiveLeak(response: HttpResult, context: string): void {
  const topLevelErrorText = [response.json?.error, response.json?.message]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join('\n');

  const haystack = (
    response.status >= 400 || topLevelErrorText
      ? [response.text, topLevelErrorText].filter(Boolean).join('\n')
      : topLevelErrorText
  ).toLowerCase();

  const suspiciousPatterns = [
    'stack',
    'trace',
    '/var/task',
    '/users/',
    'token',
    'secret',
    'bearer',
    'referenceerror',
    'typeerror',
    'syntaxerror',
    'postgres',
    'supabase_service_role_key',
    'kv_rest_api_token',
  ];

  for (const pattern of suspiciousPatterns) {
    expect(!haystack.includes(pattern), `${context} leaked sensitive/internal pattern "${pattern}"`);
  }
}

function ensureNoUnsafeReflection(response: HttpResult, payload: string, context: string): void {
  if (!response.json || typeof response.json !== 'object') return;

  const reflected = JSON.stringify(response.json.error || response.json.message || '');
  expect(!reflected.includes(payload), `${context} was reflected unsafely in error output`);
}

function summarizeLatencies(samples: number[]): { avg: number; median: number; p95: number; p99: number; max: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  const avg = Math.round(samples.reduce((sum, value) => sum + value, 0) / samples.length);
  return {
    avg,
    median: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1],
  };
}

function percentile(sorted: number[], p: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

function getLatencyWarnThreshold(label: string): number {
  if (label === 'health') return 750;
  if (label === 'accounts') return 750;
  if (label === 'feed') return 1000;
  return 1500;
}

function summarizeStatuses(statuses: number[]): Record<string, number> {
  return statuses.reduce((acc, status) => {
    acc[String(status)] = (acc[String(status)] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
}

function formatStatusSummary(summary: Record<string, number>): string {
  return Object.entries(summary)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([status, count]) => `${status}x${count}`)
    .join(', ');
}

void main();
