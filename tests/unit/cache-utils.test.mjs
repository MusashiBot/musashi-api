import test from 'node:test';
import assert from 'node:assert/strict';

const rateLimitModule = await import('../../api/lib/rate-limit.ts');
const cacheHelperModule = await import('../../api/lib/cache-helper.ts');
const kvModule = await import('../../api/lib/vercel-kv.ts');
const walletCacheModule = await import('../../api/lib/wallet-cache.ts');
import { installKvMemoryMock } from '../helpers/test-helpers.mjs';

function getExport(module, name) {
  return module?.[name] ?? module?.default?.[name];
}

const getClientIp = getExport(rateLimitModule, 'getClientIp');
const isRateLimited = getExport(rateLimitModule, 'isRateLimited');
const parsePositiveIntEnv = getExport(rateLimitModule, 'parsePositiveIntEnv');

const batchGetFromKV = getExport(cacheHelperModule, 'batchGetFromKV');
const getCached = getExport(cacheHelperModule, 'getCached');
const clearMemoryCache = getExport(cacheHelperModule, 'clearMemoryCache');
const setFeedCache = getExport(cacheHelperModule, 'setFeedCache');
const getFeedCache = getExport(cacheHelperModule, 'getFeedCache');
const getFeedCacheTimestamp = getExport(cacheHelperModule, 'getFeedCacheTimestamp');

const kv = getExport(kvModule, 'kv');
const listKvKeys = getExport(kvModule, 'listKvKeys');
const setKvWithTtl = getExport(kvModule, 'setKvWithTtl');

const getCachedWalletActivity = getExport(walletCacheModule, 'getCachedWalletActivity');
const setCachedWalletActivity = getExport(walletCacheModule, 'setCachedWalletActivity');
const getWalletActivityKey = getExport(walletCacheModule, 'getWalletActivityKey');
const getStaleWalletMemoryCache = getExport(walletCacheModule, 'getStaleWalletMemoryCache');
const clearWalletMemoryCache = getExport(walletCacheModule, 'clearWalletMemoryCache');

// ─── Rate Limit Utils ───────────────────────────────────────────────────────

test('getClientIp extracts first x-forwarded-for value', () => {
  const ip = getClientIp({
    headers: {
      'x-forwarded-for': '1.2.3.4, 5.6.7.8',
    },
  });

  assert.equal(ip, '1.2.3.4');
});

test('getClientIp handles array and missing header', () => {
  const fromArray = getClientIp({ headers: { 'x-forwarded-for': ['9.8.7.6'] } });
  const missing = getClientIp({ headers: {} });

  assert.equal(fromArray, '9.8.7.6');
  assert.equal(missing, 'unknown');
});

test('isRateLimited blocks when threshold exceeded and resets after window', () => {
  const key = `rl:${Date.now()}:window`;

  const originalNow = Date.now;
  let fakeNow = originalNow();
  Date.now = () => fakeNow;

  try {
    assert.equal(isRateLimited(key, 2), false);
    assert.equal(isRateLimited(key, 2), false);
    assert.equal(isRateLimited(key, 2), true);

    fakeNow += 61_000;
    assert.equal(isRateLimited(key, 2), false);
  } finally {
    Date.now = originalNow;
  }
});

test('isRateLimited allows when limit is non-positive or non-finite', () => {
  const key = `rl:${Date.now()}:disabled`;
  assert.equal(isRateLimited(key, 0), false);
  assert.equal(isRateLimited(key, -1), false);
  assert.equal(isRateLimited(key, Number.NaN), false);
});

test('parsePositiveIntEnv parses valid numbers and falls back safely', () => {
  process.env.MUSASHI_TEST_PARSE_INT = '42';
  assert.equal(parsePositiveIntEnv('MUSASHI_TEST_PARSE_INT', 7), 42);

  process.env.MUSASHI_TEST_PARSE_INT = '-5';
  assert.equal(parsePositiveIntEnv('MUSASHI_TEST_PARSE_INT', 7), 7);

  process.env.MUSASHI_TEST_PARSE_INT = 'abc';
  assert.equal(parsePositiveIntEnv('MUSASHI_TEST_PARSE_INT', 7), 7);

  delete process.env.MUSASHI_TEST_PARSE_INT;
  assert.equal(parsePositiveIntEnv('MUSASHI_TEST_PARSE_INT', 7), 7);
});

// ─── Cache Helper ───────────────────────────────────────────────────────────

test('batchGetFromKV uses mget and returns values in order', async () => {
  const fakeKv = {
    async mget(...keys) {
      return keys.map((key) => `${key}:value`);
    },
  };

  const result = await batchGetFromKV(fakeKv, ['a', 'b', 'c']);
  assert.deepEqual(result, ['a:value', 'b:value', 'c:value']);
});

test('batchGetFromKV handles quota errors gracefully', async () => {
  const fakeKv = {
    async mget() {
      throw new Error('ERR max requests limit exceeded');
    },
  };

  const result = await batchGetFromKV(fakeKv, ['a', 'b']);
  assert.deepEqual(result, [null, null]);
});

test('getCached reuses in-memory value across calls', async () => {
  clearMemoryCache();
  let calls = 0;

  const fetcher = async () => {
    calls += 1;
    return { payload: 'fresh' };
  };

  const first = await getCached('cache:test:memory', fetcher, 60_000);
  const second = await getCached('cache:test:memory', fetcher, 60_000);

  assert.deepEqual(first, { payload: 'fresh' });
  assert.deepEqual(second, { payload: 'fresh' });
  assert.equal(calls, 1);
});

test('getCached rethrows quota error as service unavailable', async () => {
  clearMemoryCache();

  await assert.rejects(
    () => getCached('cache:test:quota', async () => {
      throw new Error('quota exceeded now');
    }),
    /Service temporarily unavailable due to quota limits/
  );
});

test('feed memory cache stores and serves fallback payload', () => {
  const key = `feed:test:${Date.now()}`;
  const payload = { success: true, data: { tweets: [] } };

  setFeedCache(key, payload, 30_000);

  assert.deepEqual(getFeedCache(key), payload);
  assert.equal(typeof getFeedCacheTimestamp(key), 'number');
});

// ─── Vercel KV Wrapper ──────────────────────────────────────────────────────

test('vercel-kv wrapper supports get/set/mget/del/list with in-memory mock', async () => {
  const { restore } = installKvMemoryMock(kv);

  try {
    await kv.set('alpha', { ok: true });
    await setKvWithTtl('beta', 30, { ok: 'ttl' });

    const alpha = await kv.get('alpha');
    const batch = await kv.mget('alpha', 'beta', 'missing');
    const keys = await listKvKeys('*');

    assert.deepEqual(alpha, { ok: true });
    assert.deepEqual(batch, [{ ok: true }, { ok: 'ttl' }, null]);
    assert.equal(keys.includes('alpha'), true);
    assert.equal(keys.includes('beta'), true);

    await kv.del('alpha');
    assert.equal(await kv.get('alpha'), null);
  } finally {
    restore();
  }
});

// ─── Wallet Cache ───────────────────────────────────────────────────────────

test('wallet-cache serves fresh activity and stale fallback after ttl', async () => {
  clearWalletMemoryCache();
  const { restore } = installKvMemoryMock(kv);

  const originalNow = Date.now;
  let fakeNow = originalNow();
  Date.now = () => fakeNow;

  const wallet = '0x0000000000000000000000000000000000000001';
  const activity = [{ wallet, activityType: 'trade', timestamp: new Date(fakeNow).toISOString() }];

  try {
    await setCachedWalletActivity(wallet, 5, undefined, activity);

    const fresh = await getCachedWalletActivity(wallet, 5, undefined);
    assert.equal(fresh?.cached, true);
    assert.deepEqual(fresh?.data, activity);

    // Advance beyond default 30-second wallet activity TTL.
    fakeNow += 31_000;

    const expired = await getCachedWalletActivity(wallet, 5, undefined);
    assert.equal(expired, null);

    const key = getWalletActivityKey(wallet, 5, undefined);
    const stale = getStaleWalletMemoryCache(key);

    assert.equal(stale?.cached, true);
    assert.deepEqual(stale?.data, activity);
  } finally {
    Date.now = originalNow;
    clearWalletMemoryCache();
    restore();
  }
});
