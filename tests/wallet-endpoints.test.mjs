import test from 'node:test';
import assert from 'node:assert/strict';

const walletFlowModule = await import('../api/markets/wallet-flow.ts');
const smartMoneyModule = await import('../api/markets/smart-money.ts');
const walletCacheModule = await import('../api/lib/wallet-cache.ts');

const walletFlowHandler = unwrapDefault(walletFlowModule);
const smartMoneyHandler = unwrapDefault(smartMoneyModule);

function unwrapDefault(module) {
  return typeof module.default === 'function' ? module.default : module.default.default;
}

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    end() {
      return this;
    },
  };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
    },
  });
}

function installFetchMock(mock) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

function mockActivityRows() {
  return [
    {
      timestamp: 1775851200,
      proxyWallet: '0x0000000000000000000000000000000000000001',
      conditionId: 'cond1',
      asset: 'token1',
      side: 'BUY',
      price: 0.5,
      size: 10,
      usdcSize: 5,
      type: 'TRADE',
      title: 'Mock market',
      outcome: 'YES',
      slug: 'mock-market',
      eventSlug: 'mock-event',
    },
    {
      timestamp: 1775851210,
      proxyWallet: '0x0000000000000000000000000000000000000002',
      conditionId: 'cond1',
      asset: 'token1',
      side: 'SELL',
      price: 0.4,
      size: 20,
      usdcSize: 8,
      type: 'TRADE',
      title: 'Mock market',
      outcome: 'YES',
      slug: 'mock-market',
      eventSlug: 'mock-event',
    },
    {
      timestamp: 1775851220,
      proxyWallet: '0x0000000000000000000000000000000000000003',
      conditionId: 'cond1',
      asset: 'token1',
      side: 'BUY',
      price: 0.6,
      size: 30,
      usdcSize: 18,
      type: 'TRADE',
      title: 'Mock market',
      outcome: 'NO',
      slug: 'mock-market',
      eventSlug: 'mock-event',
    },
  ];
}

test('wallet-flow accepts valid window values and preserves full activity on cache hit', async () => {
  walletCacheModule.clearWalletMemoryCache();
  let upstreamCalls = 0;
  const restoreFetch = installFetchMock(async (input) => {
    const rawUrl = String(input);
    if (rawUrl.includes('gamma-api.polymarket.com')) {
      return jsonResponse([]);
    }
    if (rawUrl.includes('api.elections.kalshi.com')) {
      return jsonResponse({ markets: [] });
    }

    upstreamCalls += 1;
    const url = new URL(rawUrl);
    assert.equal(url.pathname, '/trades');
    assert.equal(url.searchParams.get('market'), 'cond1');
    assert.equal(url.searchParams.has('user'), false);
    return jsonResponse(mockActivityRows());
  });

  try {
    const request = {
      method: 'GET',
      query: {
        conditionId: 'cond1',
        window: '24h',
        limit: '3',
      },
    };

    const first = createResponse();
    await walletFlowHandler(request, first);

    assert.equal(first.statusCode, 200);
    assert.equal(first.body.success, true);
    assert.equal(first.body.filters.window, '24h');
    assert.equal(first.body.metadata.cached, false);
    assert.equal(first.body.data.count, 3);
    assert.equal(first.body.data.activity.length, 3);

    const second = createResponse();
    await walletFlowHandler(request, second);

    assert.equal(second.statusCode, 200);
    assert.equal(second.body.success, true);
    assert.equal(second.body.metadata.cached, true);
    assert.equal(second.body.data.count, 3);
    assert.equal(second.body.data.activity.length, 3);
    assert.equal(second.body.metadata.activities_analyzed, 3);
    assert.deepEqual(second.body.data.activity, first.body.data.activity);
    assert.equal(upstreamCalls, 1);
  } finally {
    restoreFetch();
    walletCacheModule.clearWalletMemoryCache();
  }
});

test('smart-money accepts a valid 24h window and returns ranked mocked flow', async () => {
  walletCacheModule.clearWalletMemoryCache();
  const restoreFetch = installFetchMock(async (input) => {
    const url = String(input);

    if (url.includes('gamma-api.polymarket.com')) {
      return jsonResponse([
        {
          id: '1',
          conditionId: 'cond1',
          question: 'Will BTC hit 100k?',
          description: 'Bitcoin milestone market.',
          slug: 'btc-100k',
          events: [{ slug: 'btc-100k' }],
          outcomes: '["Yes","No"]',
          outcomePrices: '["0.64","0.36"]',
          volume: 100000,
          volume24hr: 25000,
          active: true,
          closed: false,
          category: 'crypto',
          oneDayPriceChange: 0.05,
        },
      ]);
    }

    if (url.includes('api.elections.kalshi.com')) {
      return jsonResponse({ markets: [] });
    }

    if (url.includes('data-api.polymarket.com')) {
      const parsed = new URL(url);
      assert.equal(parsed.pathname, '/trades');
      assert.equal(parsed.searchParams.get('market'), 'cond1');
      assert.equal(parsed.searchParams.has('user'), false);
      return jsonResponse([
        {
          timestamp: 1775851200,
          proxyWallet: '0x0000000000000000000000000000000000000001',
          conditionId: 'cond1',
          asset: 'token1',
          side: 'BUY',
          price: 0.64,
          size: 2000,
          usdcSize: 1280,
          type: 'TRADE',
          title: 'Will BTC hit 100k?',
          outcome: 'YES',
          slug: 'btc-100k',
          eventSlug: 'btc-100k',
        },
      ]);
    }

    throw new Error(`Unexpected fetch URL: ${url}`);
  });

  try {
    const response = createResponse();
    await smartMoneyHandler({
      method: 'GET',
      query: {
        category: 'crypto',
        window: '24h',
        minVolume: '0',
        limit: '1',
      },
    }, response);

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.success, true);
    assert.equal(response.body.filters.window, '24h');
    assert.equal(response.body.data.count, 1);
    assert.equal(response.body.data.markets[0].flow.netDirection, 'YES');
    assert.equal(response.body.metadata.timed_out, false);
  } finally {
    restoreFetch();
    walletCacheModule.clearWalletMemoryCache();
  }
});

test('smart-money returns unavailable when all wallet-flow upstream calls fail', async () => {
  walletCacheModule.clearWalletMemoryCache();
  const restoreFetch = installFetchMock(async (input) => {
    const url = String(input);

    if (url.includes('gamma-api.polymarket.com')) {
      return jsonResponse([
        {
          id: '1',
          conditionId: 'cond1',
          question: 'Will BTC hit 100k?',
          description: 'Bitcoin milestone market.',
          slug: 'btc-100k',
          events: [{ slug: 'btc-100k' }],
          outcomes: '["Yes","No"]',
          outcomePrices: '["0.64","0.36"]',
          volume: 100000,
          volume24hr: 25000,
          active: true,
          closed: false,
          category: 'crypto',
          oneDayPriceChange: 0.05,
        },
      ]);
    }

    if (url.includes('api.elections.kalshi.com')) {
      return jsonResponse({ markets: [] });
    }

    if (url.includes('data-api.polymarket.com')) {
      const parsed = new URL(url);
      assert.equal(parsed.pathname, '/trades');
      return jsonResponse({ error: 'upstream unavailable' }, 500);
    }

    throw new Error(`Unexpected fetch URL: ${url}`);
  });

  try {
    const response = createResponse();
    await smartMoneyHandler({
      method: 'GET',
      query: {
        category: 'crypto',
        window: '24h',
        minVolume: '0.01',
        limit: '1',
      },
    }, response);

    assert.equal(response.statusCode, 503);
    assert.equal(response.body.success, false);
    assert.match(response.body.error, /temporarily unavailable/i);
  } finally {
    restoreFetch();
    walletCacheModule.clearWalletMemoryCache();
  }
});
