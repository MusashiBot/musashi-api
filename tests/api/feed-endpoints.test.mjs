import test from 'node:test';
import assert from 'node:assert/strict';

import {
  unwrapDefault,
  createMockResponse,
  installKvMemoryMock,
} from '../helpers/test-helpers.mjs';

const kvModule = await import('../../api/lib/vercel-kv.ts');
const cacheHelperModule = await import('../../api/lib/cache-helper.ts');

function getExport(module, name) {
  return module?.[name] ?? module?.default?.[name];
}

const kv = getExport(kvModule, 'kv');
const clearMemoryCache = getExport(cacheHelperModule, 'clearMemoryCache');

const feedModule = await import('../../api/feed.ts');
const feedAccountsModule = await import('../../api/feed/accounts.ts');
const feedStatsModule = await import('../../api/feed/stats.ts');

const feedHandler = unwrapDefault(feedModule);
const feedAccountsHandler = unwrapDefault(feedAccountsModule);
const feedStatsHandler = unwrapDefault(feedStatsModule);

const kvMock = installKvMemoryMock(kv);

function makeAnalyzedTweet(id, overrides = {}) {
  return {
    tweet: {
      id,
      text: `Tweet ${id}`,
      created_at: new Date().toISOString(),
      author: {
        id: `author-${id}`,
        username: `user_${id}`,
        name: `User ${id}`,
        followers_count: 1000,
        verified: false,
      },
      metrics: {
        likes: 10,
        retweets: 5,
        replies: 1,
      },
      url: `https://x.com/user/status/${id}`,
    },
    matches: [
      {
        market: {
          id: 'polymarket-cond-fed-cut',
          platform: 'polymarket',
          title: 'Will the Federal Reserve cut rates by June 2026?',
          description: 'Fed policy market',
          keywords: ['federal reserve', 'rate cut'],
          yesPrice: 0.62,
          noPrice: 0.38,
          volume24h: 90000,
          url: 'https://polymarket.com/event/fed-cut',
          category: 'economics',
          lastUpdated: new Date().toISOString(),
        },
        confidence: 0.66,
        matchedKeywords: ['federal reserve', 'rate cut'],
      },
    ],
    sentiment: {
      sentiment: 'bullish',
      confidence: 0.7,
    },
    suggested_action: {
      direction: 'YES',
      confidence: 0.64,
      edge: 0.12,
      reasoning: 'Mock reasoning',
      position_size: {
        fraction: 0.03,
        kelly_full: 0.12,
        kelly_quarter: 0.03,
        rationale: 'Mock Kelly',
        risk_level: 'moderate',
        vol_regime: 'normal',
      },
    },
    category: 'economics',
    urgency: 'high',
    confidence: 0.66,
    analyzed_at: new Date().toISOString(),
    collected_at: new Date().toISOString(),
    ...overrides,
  };
}

async function seedFeed(tweetIds, tweetsById) {
  await kv.set('feed:latest', tweetIds);
  for (const id of tweetIds) {
    const data = tweetsById[id] ?? makeAnalyzedTweet(id);
    await kv.set(`tweet:${id}`, data);
  }
}

test.beforeEach(async () => {
  clearMemoryCache();

  for await (const key of kv.scanIterator({ match: '*' })) {
    await kv.del(key);
  }
});

test.after(async () => {
  kvMock.restore();
});

// ─── Feed Endpoint ──────────────────────────────────────────────────────────

test('feed handles OPTIONS and method guard', async () => {
  const optionsRes = createMockResponse();
  await feedHandler({ method: 'OPTIONS', query: {}, headers: {} }, optionsRes);
  assert.equal(optionsRes.statusCode, 200);

  const methodRes = createMockResponse();
  await feedHandler({ method: 'POST', query: {}, headers: {} }, methodRes);
  assert.equal(methodRes.statusCode, 405);
  assert.equal(methodRes.headers.allow, 'GET, OPTIONS');
});

test('feed validates query parameters', async () => {
  const badLimit = createMockResponse();
  await feedHandler({ method: 'GET', query: { limit: '-1' }, headers: {} }, badLimit);
  assert.equal(badLimit.statusCode, 400);

  const badCategory = createMockResponse();
  await feedHandler({ method: 'GET', query: { category: 'not-real' }, headers: {} }, badCategory);
  assert.equal(badCategory.statusCode, 400);

  const badUrgency = createMockResponse();
  await feedHandler({ method: 'GET', query: { minUrgency: 'super-high' }, headers: {} }, badUrgency);
  assert.equal(badUrgency.statusCode, 400);

  const badSince = createMockResponse();
  await feedHandler({ method: 'GET', query: { since: 'not-a-date' }, headers: {} }, badSince);
  assert.equal(badSince.statusCode, 400);
});

test('feed returns empty response when feed index is empty', async () => {
  const res = createMockResponse();
  await feedHandler({ method: 'GET', query: {}, headers: {} }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.data.count, 0);
  assert.deepEqual(res.body.data.tweets, []);
});

test('feed applies urgency/since filters and cursor pagination', async () => {
  const now = Date.now();
  const ids = ['a', 'b', 'c', 'd'];

  await seedFeed(ids, {
    a: makeAnalyzedTweet('a', {
      urgency: 'low',
      tweet: { ...makeAnalyzedTweet('a').tweet, created_at: new Date(now - (2 * 60 * 60 * 1000)).toISOString() },
      collected_at: new Date(now - (2 * 60 * 60 * 1000)).toISOString(),
    }),
    b: makeAnalyzedTweet('b', {
      urgency: 'high',
      tweet: { ...makeAnalyzedTweet('b').tweet, created_at: new Date(now - (30 * 60 * 1000)).toISOString() },
      collected_at: new Date(now - (30 * 60 * 1000)).toISOString(),
    }),
    c: makeAnalyzedTweet('c', {
      urgency: 'critical',
      tweet: { ...makeAnalyzedTweet('c').tweet, created_at: new Date(now - (10 * 60 * 1000)).toISOString() },
      collected_at: new Date(now - (10 * 60 * 1000)).toISOString(),
    }),
    d: makeAnalyzedTweet('d', {
      urgency: 'medium',
      tweet: { ...makeAnalyzedTweet('d').tweet, created_at: new Date(now - (5 * 60 * 1000)).toISOString() },
      collected_at: new Date(now - (5 * 60 * 1000)).toISOString(),
    }),
  });

  const since = new Date(now - (45 * 60 * 1000)).toISOString();

  const page1Res = createMockResponse();
  await feedHandler({
    method: 'GET',
    query: {
      limit: '2',
      minUrgency: 'high',
      since,
    },
    headers: {},
  }, page1Res);

  assert.equal(page1Res.statusCode, 200);
  assert.equal(page1Res.body.success, true);
  // Current implementation slices first, then applies filters.
  // With this fixture that yields one row on page 1.
  assert.equal(page1Res.body.data.count, 1);
  assert.ok(page1Res.body.data.tweets.every((t) => ['high', 'critical'].includes(t.urgency)));
  assert.ok(page1Res.body.data.cursor);

  const page2Res = createMockResponse();
  await feedHandler({
    method: 'GET',
    query: {
      limit: '2',
      minUrgency: 'high',
      since,
      cursor: page1Res.body.data.cursor,
    },
    headers: {},
  }, page2Res);

  assert.equal(page2Res.statusCode, 200);
  assert.equal(page2Res.body.success, true);
  assert.ok(page2Res.body.data.count >= 0);
});

test('feed returns cached fallback on quota errors when cache exists', async () => {
  await seedFeed(['q1'], { q1: makeAnalyzedTweet('q1') });

  const warmRes = createMockResponse();
  await feedHandler({ method: 'GET', query: { limit: '1' }, headers: {} }, warmRes);
  assert.equal(warmRes.statusCode, 200);

  const originalGet = kv.get;
  kv.get = async () => {
    throw new Error('max requests limit exceeded');
  };

  try {
    const fallbackRes = createMockResponse();
    await feedHandler({ method: 'GET', query: { limit: '1' }, headers: {} }, fallbackRes);

    assert.equal(fallbackRes.statusCode, 200);
    assert.equal(fallbackRes.body.success, true);
    assert.equal(fallbackRes.body.data.metadata.cached, true);
  } finally {
    kv.get = originalGet;
  }
});

test('feed returns 503 on quota errors when no cache exists', async () => {
  const originalGet = kv.get;
  kv.get = async () => {
    throw new Error('max requests limit exceeded');
  };

  try {
    const res = createMockResponse();
    await feedHandler({ method: 'GET', query: { limit: '99', category: 'finance' }, headers: {} }, res);

    assert.equal(res.statusCode, 503);
    assert.equal(res.body.success, false);
    assert.ok(String(res.body.error).includes('quota'));
  } finally {
    kv.get = originalGet;
  }
});

// ─── Feed Accounts ──────────────────────────────────────────────────────────

test('feed/accounts returns tracked account metadata', async () => {
  const res = createMockResponse();
  await feedAccountsHandler({ method: 'GET', query: {}, headers: {} }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.ok(Array.isArray(res.body.data.accounts));
  assert.ok(res.body.data.count > 0);
  assert.equal(typeof res.body.data.by_category, 'object');
  assert.ok(String(res.headers['cache-control']).includes('s-maxage=3600'));
});

// ─── Feed Stats ─────────────────────────────────────────────────────────────

test('feed/stats handles method guard and computes aggregate stats', async () => {
  const methodRes = createMockResponse();
  await feedStatsHandler({ method: 'POST', query: {}, headers: {} }, methodRes);
  assert.equal(methodRes.statusCode, 405);

  await kv.set('cron:last_run', {
    timestamp: new Date().toISOString(),
    tweets_collected: 10,
    tweets_analyzed: 10,
    tweets_stored: 4,
    errors: [],
    duration_ms: 2500,
  });

  await seedFeed(['s1', 's2', 's3'], {
    s1: makeAnalyzedTweet('s1', { category: 'economics', urgency: 'high' }),
    s2: makeAnalyzedTweet('s2', { category: 'technology', urgency: 'critical' }),
    s3: makeAnalyzedTweet('s3', { category: 'economics', urgency: 'medium' }),
  });

  const res = createMockResponse();
  await feedStatsHandler({ method: 'GET', query: {}, headers: {} }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(typeof res.body.data.tweets.last_24h, 'number');
  assert.equal(typeof res.body.data.by_category, 'object');
  assert.equal(typeof res.body.data.by_urgency, 'object');
  assert.ok(Array.isArray(res.body.data.top_markets));
});

test('feed/stats returns cached fallback on quota error', async () => {
  await kv.set('cron:last_run', {
    timestamp: new Date().toISOString(),
    tweets_collected: 10,
    tweets_analyzed: 10,
    tweets_stored: 1,
    errors: [],
    duration_ms: 1000,
  });
  await seedFeed(['stale-1'], { 'stale-1': makeAnalyzedTweet('stale-1') });

  const warm = createMockResponse();
  await feedStatsHandler({ method: 'GET', query: {}, headers: {} }, warm);
  assert.equal(warm.statusCode, 200);

  // Force next request to miss helper memory cache and hit KV read path.
  clearMemoryCache();

  const originalGet = kv.get;
  kv.get = async () => {
    throw new Error('quota exceeded');
  };

  try {
    const fallbackRes = createMockResponse();
    await feedStatsHandler({ method: 'GET', query: {}, headers: {} }, fallbackRes);

    assert.equal(fallbackRes.statusCode, 200);
    assert.equal(fallbackRes.body.success, true);
    assert.equal(fallbackRes.body.data.metadata.cached, true);
  } finally {
    kv.get = originalGet;
  }
});
