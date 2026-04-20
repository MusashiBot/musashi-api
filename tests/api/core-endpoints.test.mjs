import test from 'node:test';
import assert from 'node:assert/strict';

import {
  unwrapDefault,
  createMockResponse,
  jsonResponse,
  installFetchMock,
  buildPolymarketGammaMarket,
  buildKalshiMarket,
} from '../helpers/test-helpers.mjs';

const analyzeTextModule = await import('../../api/analyze-text.ts');
const groundProbabilityModule = await import('../../api/ground-probability.ts');
const healthModule = await import('../../api/health.ts');

const analyzeTextHandler = unwrapDefault(analyzeTextModule);
const groundProbabilityHandler = unwrapDefault(groundProbabilityModule);
const healthHandler = unwrapDefault(healthModule);

function createCoreFetchMock({ kalshiShouldFail = false } = {}) {
  return async (input) => {
    const url = String(input);

    if (url.includes('gamma-api.polymarket.com/markets')) {
      return jsonResponse([
        buildPolymarketGammaMarket(),
        buildPolymarketGammaMarket({
          id: '1002',
          conditionId: 'cond-btc-100k',
          question: 'Will Bitcoin hit $100k by end of 2026?',
          slug: 'bitcoin-100k-2026',
          events: [{ slug: 'bitcoin-100k-2026' }],
          outcomePrices: '["0.55","0.45"]',
          volume24hr: 120000,
          category: 'crypto',
        }),
      ]);
    }

    if (url.includes('api.elections.kalshi.com/trade-api/v2/markets')) {
      if (kalshiShouldFail) {
        return jsonResponse({ error: 'kalshi unavailable' }, 500);
      }

      return jsonResponse({
        markets: [
          buildKalshiMarket(),
          buildKalshiMarket({
            ticker: 'KXBTC-202612',
            event_ticker: 'KXBTC-202612',
            title: 'Will Bitcoin hit $100k by end of 2026?',
            yes_bid: 58,
            yes_ask: 60,
            volume_24h: 110000,
          }),
        ],
      });
    }

    return jsonResponse([]);
  };
}

function buildAnalyzeReq(body, headers = {}) {
  return {
    method: 'POST',
    body,
    headers,
    query: {},
  };
}

test.beforeEach(() => {
  process.env.MUSASHI_POLYMARKET_WS = '0';
  process.env.MUSASHI_DISABLE_SEMANTIC_MATCHING = '1';
  process.env.NEXT_PUBLIC_SUPABASE_URL = '';
  process.env.SUPABASE_URL = '';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = '';
  process.env.SUPABASE_ANON_KEY = '';
  process.env.MUSASHI_ANALYZE_TEXT_RATE_LIMIT_PER_MIN = '120';
});

// ─── Analyze Text ───────────────────────────────────────────────────────────

test('analyze-text handles OPTIONS preflight', async () => {
  const res = createMockResponse();
  await analyzeTextHandler({ method: 'OPTIONS', headers: {}, query: {} }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['access-control-allow-origin'], '*');
});

test('analyze-text rejects unsupported methods', async () => {
  const res = createMockResponse();
  await analyzeTextHandler({ method: 'GET', headers: {}, query: {} }, res);

  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.allow, 'POST, OPTIONS');
  assert.equal(res.body.success, false);
});

test('analyze-text validates body shape and text', async () => {
  const badBodyRes = createMockResponse();
  await analyzeTextHandler({ method: 'POST', body: null, headers: {}, query: {} }, badBodyRes);
  assert.equal(badBodyRes.statusCode, 400);

  const missingTextRes = createMockResponse();
  await analyzeTextHandler(buildAnalyzeReq({ foo: 'bar' }), missingTextRes);
  assert.equal(missingTextRes.statusCode, 400);

  const tooLongRes = createMockResponse();
  await analyzeTextHandler(buildAnalyzeReq({ text: 'x'.repeat(10_001) }), tooLongRes);
  assert.equal(tooLongRes.statusCode, 400);
});

test('analyze-text validates numeric and boolean options', async () => {
  const res1 = createMockResponse();
  await analyzeTextHandler(buildAnalyzeReq({ text: 'Fed cut', minConfidence: 1.1 }), res1);
  assert.equal(res1.statusCode, 400);

  const res2 = createMockResponse();
  await analyzeTextHandler(buildAnalyzeReq({ text: 'Fed cut', maxResults: 101 }), res2);
  assert.equal(res2.statusCode, 400);

  const res3 = createMockResponse();
  await analyzeTextHandler(buildAnalyzeReq({ text: 'Fed cut', use_ml_scorer: 'yes' }), res3);
  assert.equal(res3.statusCode, 400);
});

test('analyze-text enforces per-IP rate limiting', async () => {
  process.env.MUSASHI_ANALYZE_TEXT_RATE_LIMIT_PER_MIN = '1';
  const restoreFetch = installFetchMock(createCoreFetchMock());

  try {
    const req = buildAnalyzeReq(
      { text: 'Federal Reserve will cut rates soon.' },
      { 'x-forwarded-for': '203.0.113.1' }
    );

    const first = createMockResponse();
    await analyzeTextHandler(req, first);
    assert.equal(first.statusCode, 200);

    const second = createMockResponse();
    await analyzeTextHandler(req, second);
    assert.equal(second.statusCode, 429);
  } finally {
    restoreFetch();
    process.env.MUSASHI_ANALYZE_TEXT_RATE_LIMIT_PER_MIN = '120';
  }
});

test('analyze-text returns matched markets and trading signal on success', async () => {
  const restoreFetch = installFetchMock(createCoreFetchMock());

  try {
    const req = buildAnalyzeReq({
      text: 'Federal Reserve likely cuts interest rates by June, bullish for risk assets.',
      minConfidence: 0.2,
      maxResults: 3,
      vol_regime: 'high',
      use_ml_scorer: false,
    });
    const res = createMockResponse();

    await analyzeTextHandler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.ok(Array.isArray(res.body.data.markets));
    assert.ok(res.body.data.matchCount >= 1);
    assert.ok(['low', 'medium', 'high', 'critical'].includes(res.body.urgency));
    assert.equal(res.body.data.vol_regime, 'high');
    assert.equal(typeof res.body.data.valid_until_seconds, 'number');
    assert.equal(typeof res.body.data.is_near_resolution, 'boolean');
  } finally {
    restoreFetch();
  }
});

// ─── Ground Probability ─────────────────────────────────────────────────────

test('ground-probability handles method guard and input validation', async () => {
  const methodRes = createMockResponse();
  await groundProbabilityHandler({ method: 'GET', headers: {}, query: {} }, methodRes);
  assert.equal(methodRes.statusCode, 405);

  const missingClaimRes = createMockResponse();
  await groundProbabilityHandler({ method: 'POST', body: {}, headers: {}, query: {} }, missingClaimRes);
  assert.equal(missingClaimRes.statusCode, 400);

  const invalidEstimateRes = createMockResponse();
  await groundProbabilityHandler({
    method: 'POST',
    body: { claim: 'Fed cuts rates', llm_estimate: 2 },
    headers: {},
    query: {},
  }, invalidEstimateRes);
  assert.equal(invalidEstimateRes.statusCode, 400);
});

test('ground-probability returns consensus and divergence details', async () => {
  const restoreFetch = installFetchMock(createCoreFetchMock());

  try {
    const req = {
      method: 'POST',
      body: {
        claim: 'Federal Reserve will cut rates by June 2026.',
        llm_estimate: 0.8,
        min_confidence: 0.2,
        max_markets: 3,
      },
      headers: {},
      query: {},
    };
    const res = createMockResponse();

    await groundProbabilityHandler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.ok(typeof res.body.market_consensus.confidence === 'number');
    assert.ok(res.body.market_consensus.market_count >= 1);
    assert.ok(res.body.market_consensus.price !== null);
    assert.ok(['higher', 'lower', 'aligned'].includes(res.body.divergence.type));
  } finally {
    restoreFetch();
  }
});

// ─── Health ─────────────────────────────────────────────────────────────────

test('health endpoint handles OPTIONS and method guard', async () => {
  const optionsRes = createMockResponse();
  await healthHandler({ method: 'OPTIONS', headers: {}, query: {} }, optionsRes);
  assert.equal(optionsRes.statusCode, 200);

  const methodRes = createMockResponse();
  await healthHandler({ method: 'POST', headers: {}, query: {} }, methodRes);
  assert.equal(methodRes.statusCode, 405);
});

test('health returns healthy when both upstreams respond', async () => {
  const restoreFetch = installFetchMock(createCoreFetchMock());

  try {
    const res = createMockResponse();
    await healthHandler({ method: 'GET', headers: {}, query: {} }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.status, 'healthy');
    assert.equal(res.body.data.services.polymarket.status, 'healthy');
    assert.equal(res.body.data.services.kalshi.status, 'healthy');
  } finally {
    restoreFetch();
  }
});

test('health returns degraded when one upstream fails', async () => {
  const restoreFetch = installFetchMock(createCoreFetchMock({ kalshiShouldFail: true }));

  try {
    const res = createMockResponse();
    await healthHandler({ method: 'GET', headers: {}, query: {} }, res);

    assert.equal(res.statusCode, 503);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.status, 'degraded');
    assert.equal(res.body.data.services.polymarket.status, 'healthy');
    assert.equal(res.body.data.services.kalshi.status, 'degraded');
  } finally {
    restoreFetch();
  }
});
