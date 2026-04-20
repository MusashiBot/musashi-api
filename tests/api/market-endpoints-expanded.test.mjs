import test from 'node:test';
import assert from 'node:assert/strict';

import {
  unwrapDefault,
  createMockResponse,
  installFetchMock,
  jsonResponse,
  buildPolymarketGammaMarket,
  buildKalshiMarket,
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

process.env.MUSASHI_DISABLE_SEMANTIC_MATCHING = '1';
process.env.MUSASHI_POLYMARKET_WS = '0';

const arbitrageModule = await import('../../api/markets/arbitrage.ts');
const moversModule = await import('../../api/markets/movers.ts');
const smartMoneyModule = await import('../../api/markets/smart-money.ts');
const walletFlowModule = await import('../../api/markets/wallet-flow.ts');

const arbitrageHandler = unwrapDefault(arbitrageModule);
const moversHandler = unwrapDefault(moversModule);
const smartMoneyHandler = unwrapDefault(smartMoneyModule);
const walletFlowHandler = unwrapDefault(walletFlowModule);

const kvMock = installKvMemoryMock(kv);

function createMarketAndTradeFetchMock() {
  return async (input) => {
    const rawUrl = String(input);
    const url = new URL(rawUrl);

    if (url.hostname.includes('gamma-api.polymarket.com') && url.pathname.includes('/markets')) {
      return jsonResponse([
        buildPolymarketGammaMarket({
          id: 'poly-1',
          conditionId: 'cond-fed-cut',
          question: 'Will the Federal Reserve cut rates by June 2026?',
          outcomePrices: '["0.62","0.38"]',
          volume24hr: 120000,
        }),
        buildPolymarketGammaMarket({
          id: 'poly-2',
          conditionId: 'cond-infl-above',
          question: 'Will inflation be above 3% in 2026?',
          slug: 'inflation-above-3-2026',
          events: [{ slug: 'inflation-above-3-2026' }],
          outcomePrices: '["0.70","0.30"]',
          category: 'economics',
          volume24hr: 60000,
        }),
      ]);
    }

    if (url.hostname.includes('api.elections.kalshi.com') && url.pathname.includes('/markets')) {
      return jsonResponse({
        markets: [
          buildKalshiMarket({
            ticker: 'KXFEDCUT-202606',
            event_ticker: 'KXFEDCUT-202606',
            title: 'Will the Federal Reserve cut rates by June 2026?',
            yes_bid: 44,
            yes_ask: 46,
            volume_24h: 100000,
          }),
          buildKalshiMarket({
            ticker: 'KXINFL-2026',
            event_ticker: 'KXINFL-2026',
            title: 'Will inflation be below 3% in 2026?',
            yes_bid: 32,
            yes_ask: 34,
            volume_24h: 50000,
          }),
        ],
      });
    }

    if (url.hostname.includes('data-api.polymarket.com') && url.pathname === '/trades') {
      const market = url.searchParams.get('market');

      if (market === 'cond-fed-cut') {
        return jsonResponse([
          buildWalletTrade({
            timestamp: Math.floor((Date.now() - (10 * 60 * 1000)) / 1000),
            proxyWallet: '0x00000000000000000000000000000000000000a1',
            conditionId: 'cond-fed-cut',
            side: 'BUY',
            outcome: 'YES',
            usdcSize: 650,
            size: 1000,
            price: 0.65,
          }),
          buildWalletTrade({
            timestamp: Math.floor((Date.now() - (20 * 60 * 1000)) / 1000),
            proxyWallet: '0x00000000000000000000000000000000000000a2',
            conditionId: 'cond-fed-cut',
            side: 'SELL',
            outcome: 'YES',
            usdcSize: 200,
            size: 300,
            price: 0.66,
          }),
        ]);
      }

      if (market === 'cond-infl-above') {
        return jsonResponse([
          buildWalletTrade({
            timestamp: Math.floor((Date.now() - (30 * 60 * 1000)) / 1000),
            proxyWallet: '0x00000000000000000000000000000000000000b1',
            conditionId: 'cond-infl-above',
            side: 'BUY',
            outcome: 'YES',
            usdcSize: 720,
            size: 1000,
            price: 0.72,
          }),
        ]);
      }

      return jsonResponse([]);
    }

    return jsonResponse([]);
  };
}

test.beforeEach(async () => {
  process.env.MUSASHI_DISABLE_SEMANTIC_MATCHING = '1';
  process.env.MUSASHI_POLYMARKET_WS = '0';
  clearWalletMemoryCache();

  for await (const key of kv.scanIterator({ match: '*' })) {
    await kv.del(key);
  }
});

test.after(() => {
  kvMock.restore();
});

// ─── Arbitrage ──────────────────────────────────────────────────────────────

test('arbitrage endpoint validates method and query inputs', async () => {
  const methodRes = createMockResponse();
  await arbitrageHandler({ method: 'POST', query: {}, headers: {} }, methodRes);
  assert.equal(methodRes.statusCode, 405);

  const badSpread = createMockResponse();
  await arbitrageHandler({ method: 'GET', query: { minSpread: '2' }, headers: {} }, badSpread);
  assert.equal(badSpread.statusCode, 400);

  const badConfidence = createMockResponse();
  await arbitrageHandler({ method: 'GET', query: { minConfidence: '-1' }, headers: {} }, badConfidence);
  assert.equal(badConfidence.statusCode, 400);

  const badLimit = createMockResponse();
  await arbitrageHandler({ method: 'GET', query: { limit: '0' }, headers: {} }, badLimit);
  assert.equal(badLimit.statusCode, 400);
});

test('arbitrage endpoint returns opportunities with filter metadata', async () => {
  const restoreFetch = installFetchMock(createMarketAndTradeFetchMock());

  try {
    const res = createMockResponse();
    await arbitrageHandler({
      method: 'GET',
      query: {
        minSpread: '0.03',
        minConfidence: '0.2',
        limit: '10',
        excludeOpposed: 'false',
      },
      headers: {
        'x-forwarded-for': '198.51.100.23',
      },
    }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.ok(Array.isArray(res.body.data.opportunities));
    assert.ok(res.body.data.metadata.markets_analyzed >= 2);
    assert.equal(typeof res.body.data.filters.excludeOpposed, 'boolean');
  } finally {
    restoreFetch();
  }
});

// ─── Movers ─────────────────────────────────────────────────────────────────

test('movers endpoint validates method and query parameters', async () => {
  const methodRes = createMockResponse();
  await moversHandler({ method: 'POST', query: {}, headers: {} }, methodRes);
  assert.equal(methodRes.statusCode, 405);

  const badMinChange = createMockResponse();
  await moversHandler({ method: 'GET', query: { minChange: '-1' }, headers: {} }, badMinChange);
  assert.equal(badMinChange.statusCode, 400);

  const badLimit = createMockResponse();
  await moversHandler({ method: 'GET', query: { limit: '101' }, headers: {} }, badLimit);
  assert.equal(badLimit.statusCode, 400);
});

test('movers endpoint records snapshots and returns movers payload', async () => {
  const restoreFetch = installFetchMock(createMarketAndTradeFetchMock());

  try {
    const res = createMockResponse();
    await moversHandler({
      method: 'GET',
      query: { minChange: '0.01', limit: '20' },
      headers: {},
    }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.ok(Array.isArray(res.body.data.movers));
    assert.equal(typeof res.body.data.metadata.markets_tracked, 'number');
    assert.equal(res.body.data.metadata.storage, 'Vercel KV (Redis)');
  } finally {
    restoreFetch();
  }
});

// ─── Smart Money ────────────────────────────────────────────────────────────

test('smart-money endpoint validates method and filters', async () => {
  const methodRes = createMockResponse();
  await smartMoneyHandler({ method: 'POST', query: {}, headers: {} }, methodRes);
  assert.equal(methodRes.statusCode, 405);

  const badWindow = createMockResponse();
  await smartMoneyHandler({ method: 'GET', query: { window: '12h' }, headers: {} }, badWindow);
  assert.equal(badWindow.statusCode, 400);

  const badMinVolume = createMockResponse();
  await smartMoneyHandler({ method: 'GET', query: { minVolume: '-2' }, headers: {} }, badMinVolume);
  assert.equal(badMinVolume.statusCode, 400);

  const badLimit = createMockResponse();
  await smartMoneyHandler({ method: 'GET', query: { limit: '1000' }, headers: {} }, badLimit);
  assert.equal(badLimit.statusCode, 400);
});

test('smart-money endpoint returns ranked market flows', async () => {
  const restoreFetch = installFetchMock(createMarketAndTradeFetchMock());

  try {
    const res = createMockResponse();
    await smartMoneyHandler({
      method: 'GET',
      query: {
        window: '24h',
        minVolume: '100',
        limit: '5',
      },
      headers: {},
    }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.ok(Array.isArray(res.body.data.markets));
    assert.equal(typeof res.body.metadata.candidates_analyzed, 'number');
    assert.equal(typeof res.body.metadata.flow_results, 'number');

    const second = createMockResponse();
    await smartMoneyHandler({
      method: 'GET',
      query: {
        window: '24h',
        minVolume: '100',
        limit: '5',
      },
      headers: {},
    }, second);

    assert.equal(second.statusCode, 200);
    assert.equal(second.body.metadata.cached, true);
  } finally {
    restoreFetch();
  }
});

// ─── Market Wallet Flow ─────────────────────────────────────────────────────

test('market wallet-flow validates method and required identity filters', async () => {
  const methodRes = createMockResponse();
  await walletFlowHandler({ method: 'POST', query: {}, headers: {} }, methodRes);
  assert.equal(methodRes.statusCode, 405);

  const missingIdentity = createMockResponse();
  await walletFlowHandler({ method: 'GET', query: {}, headers: {} }, missingIdentity);
  assert.equal(missingIdentity.statusCode, 400);

  const badWindow = createMockResponse();
  await walletFlowHandler({ method: 'GET', query: { conditionId: 'cond-fed-cut', window: '12h' }, headers: {} }, badWindow);
  assert.equal(badWindow.statusCode, 400);

  const badLimit = createMockResponse();
  await walletFlowHandler({ method: 'GET', query: { conditionId: 'cond-fed-cut', limit: '0' }, headers: {} }, badLimit);
  assert.equal(badLimit.statusCode, 400);
});

test('market wallet-flow returns flow aggregation and cache hits', async () => {
  const restoreFetch = installFetchMock(createMarketAndTradeFetchMock());

  try {
    const req = {
      method: 'GET',
      query: {
        conditionId: 'cond-fed-cut',
        window: '24h',
        limit: '5',
      },
      headers: {},
    };

    const first = createMockResponse();
    await walletFlowHandler(req, first);

    assert.equal(first.statusCode, 200);
    assert.equal(first.body.success, true);
    assert.equal(first.body.data.flow.conditionId, 'cond-fed-cut');
    assert.ok(Array.isArray(first.body.data.activity));
    assert.equal(typeof first.body.metadata.activities_analyzed, 'number');

    const second = createMockResponse();
    await walletFlowHandler(req, second);

    assert.equal(second.statusCode, 200);
    assert.equal(second.body.metadata.cached, true);
    assert.equal(second.body.data.flow.conditionId, 'cond-fed-cut');
  } finally {
    restoreFetch();
  }
});
