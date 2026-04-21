import test from 'node:test';
import assert from 'node:assert/strict';

import {
  unwrapDefault,
  createMockResponse,
  installFetchMock,
  jsonResponse,
  buildWalletPosition,
  buildWalletTrade,
  installKvMemoryMock,
} from '../helpers/test-helpers.mjs';

const kvModule = await import('../../api/lib/vercel-kv.ts');
const walletCacheModule = await import('../../api/lib/wallet-cache.ts');

function getExport(module, name) {
  return module?.[name] ?? module?.default?.[name];
}

const kv = getExport(kvModule, 'kv');
const clearWalletMemoryCache = getExport(walletCacheModule, 'clearWalletMemoryCache');

const walletActivityModule = await import('../../api/wallet/activity.ts');
const walletPositionsModule = await import('../../api/wallet/positions.ts');
const riskSessionModule = await import('../../api/risk/session.ts');
const resolveMarketModule = await import('../../api/internal/resolve-market.ts');
const performanceModule = await import('../../api/metrics/performance.ts');
const cronModule = await import('../../api/cron/collect-tweets.ts');

const walletActivityHandler = unwrapDefault(walletActivityModule);
const walletPositionsHandler = unwrapDefault(walletPositionsModule);
const riskSessionHandler = unwrapDefault(riskSessionModule);
const resolveMarketHandler = unwrapDefault(resolveMarketModule);
const performanceHandler = unwrapDefault(performanceModule);
const cronHandler = unwrapDefault(cronModule);

const kvMock = installKvMemoryMock(kv);

const VALID_WALLET = '0x00000000000000000000000000000000000000aa';

function createWalletFetchMock() {
  return async (input) => {
    const url = new URL(String(input));

    if (url.hostname.includes('data-api.polymarket.com') && url.pathname === '/activity') {
      return jsonResponse([
        buildWalletTrade({
          proxyWallet: VALID_WALLET,
          conditionId: 'cond-fed-cut',
          usdcSize: 80,
          size: 120,
          price: 0.67,
          side: 'BUY',
          outcome: 'YES',
        }),
        buildWalletTrade({
          proxyWallet: VALID_WALLET,
          conditionId: 'cond-fed-cut',
          usdcSize: 50,
          size: 80,
          price: 0.63,
          side: 'SELL',
          outcome: 'YES',
        }),
      ]);
    }

    if (url.hostname.includes('data-api.polymarket.com') && url.pathname === '/positions') {
      return jsonResponse([
        buildWalletPosition({
          proxyWallet: VALID_WALLET,
          conditionId: 'cond-fed-cut',
          currentValue: 93,
          size: 150,
        }),
        buildWalletPosition({
          proxyWallet: VALID_WALLET,
          conditionId: 'cond-btc-100k',
          currentValue: 40,
          size: 50,
          outcome: 'NO',
        }),
      ]);
    }

    if (url.hostname.includes('data-api.polymarket.com') && url.pathname === '/value') {
      return jsonResponse([{ value: 133 }]);
    }

    return jsonResponse([]);
  };
}

test.beforeEach(async () => {
  clearWalletMemoryCache();

  for await (const key of kv.scanIterator({ match: '*' })) {
    await kv.del(key);
  }
});

test.after(() => {
  kvMock.restore();
});

// ─── Wallet Activity ────────────────────────────────────────────────────────

test('wallet/activity enforces method and validation', async () => {
  const methodRes = createMockResponse();
  await walletActivityHandler({ method: 'POST', query: {}, headers: {} }, methodRes);
  assert.equal(methodRes.statusCode, 405);

  const missingWallet = createMockResponse();
  await walletActivityHandler({ method: 'GET', query: {}, headers: {} }, missingWallet);
  assert.equal(missingWallet.statusCode, 400);

  const badWallet = createMockResponse();
  await walletActivityHandler({ method: 'GET', query: { wallet: 'abc' }, headers: {} }, badWallet);
  assert.equal(badWallet.statusCode, 400);

  const badLimit = createMockResponse();
  await walletActivityHandler({ method: 'GET', query: { wallet: VALID_WALLET, limit: '0' }, headers: {} }, badLimit);
  assert.equal(badLimit.statusCode, 400);

  const badSince = createMockResponse();
  await walletActivityHandler({ method: 'GET', query: { wallet: VALID_WALLET, since: 'nope' }, headers: {} }, badSince);
  assert.equal(badSince.statusCode, 400);
});

test('wallet/activity returns normalized rows and cache hits', async () => {
  const restoreFetch = installFetchMock(createWalletFetchMock());

  try {
    const req = {
      method: 'GET',
      query: {
        wallet: VALID_WALLET,
        limit: '10',
      },
      headers: {},
    };

    const first = createMockResponse();
    await walletActivityHandler(req, first);

    assert.equal(first.statusCode, 200);
    assert.equal(first.body.success, true);
    assert.ok(Array.isArray(first.body.data.activity));
    assert.ok(first.body.data.count > 0);
    assert.equal(first.body.metadata.cached, false);

    const second = createMockResponse();
    await walletActivityHandler(req, second);

    assert.equal(second.statusCode, 200);
    assert.equal(second.body.metadata.cached, true);
  } finally {
    restoreFetch();
  }
});

// ─── Wallet Positions ───────────────────────────────────────────────────────

test('wallet/positions validates query parameters', async () => {
  const methodRes = createMockResponse();
  await walletPositionsHandler({ method: 'POST', query: {}, headers: {} }, methodRes);
  assert.equal(methodRes.statusCode, 405);

  const missingWallet = createMockResponse();
  await walletPositionsHandler({ method: 'GET', query: {}, headers: {} }, missingWallet);
  assert.equal(missingWallet.statusCode, 400);

  const badMinValue = createMockResponse();
  await walletPositionsHandler({ method: 'GET', query: { wallet: VALID_WALLET, minValue: '-2' }, headers: {} }, badMinValue);
  assert.equal(badMinValue.statusCode, 400);
});

test('wallet/positions returns filtered positions and cached responses', async () => {
  const restoreFetch = installFetchMock(createWalletFetchMock());

  try {
    const req = {
      method: 'GET',
      query: {
        wallet: VALID_WALLET,
        minValue: '50',
        limit: '20',
      },
      headers: {},
    };

    const first = createMockResponse();
    await walletPositionsHandler(req, first);

    assert.equal(first.statusCode, 200);
    assert.equal(first.body.success, true);
    assert.ok(Array.isArray(first.body.data.positions));
    assert.ok(first.body.data.positions.every((p) => p.currentValue >= 50));
    assert.equal(first.body.metadata.cached, false);

    const second = createMockResponse();
    await walletPositionsHandler(req, second);

    assert.equal(second.statusCode, 200);
    assert.equal(second.body.metadata.cached, true);
  } finally {
    restoreFetch();
  }
});

// ─── Risk Session ───────────────────────────────────────────────────────────

test('risk/session validates method and required body field', async () => {
  process.env.INTERNAL_API_KEY = 'test-risk-key';
  const authHeaders = { 'x-api-key': 'test-risk-key' };

  const methodRes = createMockResponse();
  await riskSessionHandler({ method: 'GET', query: {}, headers: authHeaders }, methodRes);
  assert.equal(methodRes.statusCode, 405);

  const badBody = createMockResponse();
  await riskSessionHandler({ method: 'POST', body: {}, query: {}, headers: authHeaders }, badBody);
  assert.equal(badBody.statusCode, 400);

  const outOfRange = createMockResponse();
  await riskSessionHandler({ method: 'POST', body: { session_pnl_pct: -2 }, query: {}, headers: authHeaders }, outOfRange);
  assert.equal(outOfRange.statusCode, 400);

  delete process.env.INTERNAL_API_KEY;
});

test('risk/session returns caution and halt throttle levels by pnl threshold', async () => {
  process.env.INTERNAL_API_KEY = 'test-risk-key';
  const authHeaders = { 'x-api-key': 'test-risk-key' };

  const cautionRes = createMockResponse();
  await riskSessionHandler({
    method: 'POST',
    body: {
      session_pnl_pct: -0.06,
      open_positions: 12,
      largest_position_pct: 0.1,
    },
    query: {},
    headers: authHeaders,
  }, cautionRes);

  assert.equal(cautionRes.statusCode, 200);
  assert.equal(cautionRes.body.success, true);
  assert.equal(cautionRes.body.data.throttle_level, 'caution');
  assert.equal(cautionRes.body.data.kelly_multiplier, 0.5);
  assert.ok(cautionRes.body.data.warnings.length > 0);

  const haltRes = createMockResponse();
  await riskSessionHandler({
    method: 'POST',
    body: { session_pnl_pct: -0.11 },
    query: {},
    headers: authHeaders,
  }, haltRes);

  assert.equal(haltRes.statusCode, 200);
  assert.equal(haltRes.body.data.throttle_level, 'halt');
  assert.equal(haltRes.body.data.max_position_pct, 0);
  assert.equal(haltRes.body.data.kelly_multiplier, 0);

  delete process.env.INTERNAL_API_KEY;
});

test('risk/session includes Retry-After header when rate limited', async () => {
  process.env.INTERNAL_API_KEY = 'test-rate-key';
  const authHeaders = { 'x-api-key': 'test-rate-key', 'x-forwarded-for': '10.0.0.99' };

  // Pre-fill the rate limit bucket so the next request triggers 429.
  // RISK_RATE_LIMIT defaults to 30; exhaust 30 slots for this IP key.
  const { isRateLimited } = await import('../../api/lib/rate-limit.ts');
  for (let i = 0; i < 30; i++) {
    isRateLimited('risk:10.0.0.99', 30);
  }

  const res = createMockResponse();
  await riskSessionHandler({ method: 'POST', body: { session_pnl_pct: 0.01 }, query: {}, headers: authHeaders }, res);
  assert.equal(res.statusCode, 429);
  assert.equal(res.headers['retry-after'], '60', 'Retry-After header must be present on 429');

  delete process.env.INTERNAL_API_KEY;
});

// ─── Internal Resolve-Market ────────────────────────────────────────────────

test('internal resolve-market enforces auth and input validation', async () => {
  process.env.INTERNAL_API_KEY = 'secret-key';

  const unauthorized = createMockResponse();
  await resolveMarketHandler({ method: 'POST', headers: {}, body: {}, query: {} }, unauthorized);
  assert.equal(unauthorized.statusCode, 401);

  const invalidBody = createMockResponse();
  await resolveMarketHandler({
    method: 'POST',
    headers: { 'x-api-key': 'secret-key' },
    body: { market_id: 'm1', platform: 'bad', outcome: 'YES' },
    query: {},
  }, invalidBody);
  assert.equal(invalidBody.statusCode, 400);
});

test('internal resolve-market returns 500 when supabase config missing after auth', async () => {
  process.env.INTERNAL_API_KEY = 'secret-key';
  process.env.NEXT_PUBLIC_SUPABASE_URL = '';
  process.env.SUPABASE_SERVICE_KEY = '';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = '';

  const res = createMockResponse();
  await resolveMarketHandler({
    method: 'POST',
    headers: { 'x-api-key': 'secret-key' },
    body: {
      market_id: 'market-1',
      platform: 'polymarket',
      outcome: 'YES',
    },
    query: {},
  }, res);

  assert.equal(res.statusCode, 500);
  assert.equal(res.body.success, false);
});

// ─── Metrics Performance ────────────────────────────────────────────────────

test('metrics/performance enforces GET and checks supabase env', async () => {
  const methodRes = createMockResponse();
  await performanceHandler({ method: 'POST', query: {}, headers: {} }, methodRes);
  assert.equal(methodRes.statusCode, 405);

  process.env.SUPABASE_URL = '';
  process.env.NEXT_PUBLIC_SUPABASE_URL = '';
  process.env.SUPABASE_SERVICE_KEY = '';
  process.env.SUPABASE_ANON_KEY = '';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = '';

  const missingConfig = createMockResponse();
  await performanceHandler({ method: 'GET', query: {}, headers: {} }, missingConfig);
  assert.equal(missingConfig.statusCode, 500);
  assert.equal(missingConfig.body.success, false);
});

// ─── Cron Collect Tweets ────────────────────────────────────────────────────

test('cron/collect-tweets enforces methods and authorization', async () => {
  process.env.CRON_SECRET = 'cron-secret-value';

  const methodRes = createMockResponse();
  await cronHandler({ method: 'PUT', headers: {}, query: {} }, methodRes);
  assert.equal(methodRes.statusCode, 405);

  const unauthorized = createMockResponse();
  await cronHandler({
    method: 'GET',
    headers: { authorization: 'Bearer wrong-secret' },
    query: {},
  }, unauthorized);

  assert.equal(unauthorized.statusCode, 401);
  assert.equal(unauthorized.body.success, false);
});
