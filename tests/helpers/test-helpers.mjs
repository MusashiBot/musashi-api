import assert from 'node:assert/strict';

export function unwrapDefault(module) {
  if (typeof module?.default === 'function') {
    return module.default;
  }

  if (typeof module?.default?.default === 'function') {
    return module.default.default;
  }

  throw new Error('Unable to resolve default handler export.');
}

export function createMockResponse() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
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
    end(payload = null) {
      this.body = payload;
      return this;
    },
  };
}

export function jsonResponse(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...extraHeaders,
    },
  });
}

export function installFetchMock(mockFetch) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch;

  return () => {
    globalThis.fetch = originalFetch;
  };
}

function wildcardToRegex(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*/g, '.*')}$`);
}

export function installKvMemoryMock(kv) {
  const original = {
    get: kv.get,
    set: kv.set,
    del: kv.del,
    mget: kv.mget,
    scanIterator: kv.scanIterator,
  };

  const store = new Map();

  function cleanupExpired() {
    const now = Date.now();
    for (const [key, entry] of store.entries()) {
      if (entry.expiresAt !== null && entry.expiresAt <= now) {
        store.delete(key);
      }
    }
  }

  kv.get = async (key) => {
    cleanupExpired();
    const entry = store.get(key);
    return entry ? entry.value : null;
  };

  kv.set = async (key, value, options) => {
    const ttlMs = options?.ex ? Number(options.ex) * 1000 : null;
    store.set(key, {
      value,
      expiresAt: ttlMs ? Date.now() + ttlMs : null,
    });
    return 'OK';
  };

  kv.del = async (key) => {
    return store.delete(key) ? 1 : 0;
  };

  kv.mget = async (...keys) => {
    cleanupExpired();
    return keys.map((key) => {
      const entry = store.get(key);
      return entry ? entry.value : null;
    });
  };

  kv.scanIterator = (options = {}) => {
    const matcher = options.match ? wildcardToRegex(options.match) : null;

    return {
      [Symbol.asyncIterator]: async function* iterator() {
        cleanupExpired();

        for (const key of store.keys()) {
          if (!matcher || matcher.test(key)) {
            yield key;
          }
        }
      },
    };
  };

  return {
    store,
    restore() {
      kv.get = original.get;
      kv.set = original.set;
      kv.del = original.del;
      kv.mget = original.mget;
      kv.scanIterator = original.scanIterator;
    },
  };
}

export function assertSuccessResponse(response, expectedStatus = 200) {
  assert.equal(response.statusCode, expectedStatus);
  assert.equal(response.body?.success, true);
}

export function unixSecondsAgo(seconds) {
  return Math.floor((Date.now() - (seconds * 1000)) / 1000);
}

export function isoMillisAgo(milliseconds) {
  return new Date(Date.now() - milliseconds).toISOString();
}

export function buildPolymarketGammaMarket(overrides = {}) {
  return {
    id: '1001',
    conditionId: 'cond-fed-cut',
    question: 'Will the Federal Reserve cut rates by June 2026?',
    description: 'Fed policy market.',
    slug: 'fed-cut-rates-june-2026',
    events: [{ slug: 'fed-cut-rates-june-2026' }],
    outcomes: '["Yes","No"]',
    outcomePrices: '["0.62","0.38"]',
    volume: 150000,
    volume24hr: 80000,
    active: true,
    closed: false,
    category: 'economics',
    oneDayPriceChange: 0.04,
    endDateIso: '2026-06-30T00:00:00.000Z',
    ...overrides,
  };
}

export function buildKalshiMarket(overrides = {}) {
  return {
    ticker: 'KXFEDCUT-202606',
    event_ticker: 'KXFEDCUT-202606',
    series_ticker: 'KXFEDCUT',
    title: 'Will the Federal Reserve cut rates by June 2026?',
    yes_ask: 70,
    yes_bid: 68,
    no_ask: 32,
    no_bid: 30,
    volume_24h: 90000,
    status: 'open',
    ...overrides,
  };
}

export function buildWalletTrade(overrides = {}) {
  return {
    timestamp: unixSecondsAgo(60),
    proxyWallet: '0x0000000000000000000000000000000000000001',
    conditionId: 'cond-fed-cut',
    asset: 'token-fed-yes',
    side: 'BUY',
    price: 0.62,
    size: 100,
    usdcSize: 62,
    type: 'TRADE',
    title: 'Will the Federal Reserve cut rates by June 2026?',
    outcome: 'YES',
    slug: 'fed-cut-rates-june-2026',
    eventSlug: 'fed-cut-rates-june-2026',
    ...overrides,
  };
}

export function buildWalletPosition(overrides = {}) {
  return {
    proxyWallet: '0x0000000000000000000000000000000000000001',
    conditionId: 'cond-fed-cut',
    asset: 'token-fed-yes',
    title: 'Will the Federal Reserve cut rates by June 2026?',
    outcome: 'YES',
    slug: 'fed-cut-rates-june-2026',
    eventSlug: 'fed-cut-rates-june-2026',
    size: 150,
    avgPrice: 0.55,
    curPrice: 0.62,
    currentValue: 93,
    realizedPnl: 0,
    cashPnl: 10.5,
    ...overrides,
  };
}
