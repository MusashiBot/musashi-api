import assert from 'node:assert/strict';
import test from 'node:test';
import { detectArbitrage } from '../src/api/arbitrage-detector';
import { generateSignal } from '../src/analysis/signal-generator';
import { KeywordMatcher } from '../src/analysis/keyword-matcher';
import type { Market, MarketMatch } from '../src/types/market';
import groundProbabilityHandler from '../api/ground-probability';
import feedHandler from '../api/feed';
import { kv } from '../api/lib/vercel-kv';

function market(overrides: Partial<Market>): Market {
  return {
    id: 'market-1',
    platform: 'polymarket',
    title: 'Will Bitcoin be above $100K in 2026?',
    description: '',
    keywords: ['bitcoin', 'btc', '100000', '2026'],
    yesPrice: 0.4,
    noPrice: 0.6,
    volume24h: 1000,
    url: 'https://example.com/market',
    category: 'crypto',
    lastUpdated: new Date('2026-01-01T00:00:00.000Z').toISOString(),
    ...overrides,
  };
}

function responseRecorder() {
  const headers = new Map<string, string>();
  return {
    statusCode: 200,
    body: undefined as unknown,
    headers,
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    end() {
      return this;
    },
  };
}

test('arbitrage rejects opposite threshold directions', () => {
  const opportunities = detectArbitrage([
    market({
      id: 'poly-above',
      platform: 'polymarket',
      title: 'Will Bitcoin be above $100K in 2026?',
      yesPrice: 0.25,
    }),
    market({
      id: 'kalshi-below',
      platform: 'kalshi',
      title: 'Will Bitcoin be below $100K in 2026?',
      yesPrice: 0.75,
    }),
  ], 0.01);

  assert.equal(opportunities.length, 0);
});

test('arbitrage rejects otherwise similar markets from different years', () => {
  const opportunities = detectArbitrage([
    market({
      id: 'poly-2025',
      platform: 'polymarket',
      title: 'Will Bitcoin be above $100K in 2025?',
      yesPrice: 0.25,
    }),
    market({
      id: 'kalshi-2026',
      platform: 'kalshi',
      title: 'Will Bitcoin be above $100K in 2026?',
      yesPrice: 0.75,
    }),
  ], 0.01);

  assert.equal(opportunities.length, 0);
});

test('neutral sentiment does not create directional edge', () => {
  const matchedMarket = market({
    title: 'Will the Federal Reserve cut rates in 2026?',
    keywords: ['federal reserve', 'rates', '2026'],
    yesPrice: 0.2,
    category: 'economics',
  });
  const match: MarketMatch = {
    market: matchedMarket,
    confidence: 1,
    matchedKeywords: ['federal reserve'],
  };

  const signal = generateSignal('Federal Reserve decision scheduled today', [match]);

  assert.equal(signal.urgency, 'low');
  assert.equal(signal.suggested_action?.direction, 'HOLD');
  assert.equal(signal.suggested_action?.edge, 0);
  assert.equal(signal.suggested_action?.confidence, 0);
});

test('entity-only keyword matches can pass when more than one entity matches', () => {
  const matcher = new KeywordMatcher([
    market({
      id: 'election-market',
      title: 'Will Donald Trump defeat Joe Biden?',
      keywords: ['donald trump', 'joe biden'],
      category: 'us_politics',
    }),
  ], 0.1, 5);

  const matches = matcher.match('Donald Trump and Joe Biden are debating tonight on television.');

  assert.equal(matches.length, 1);
  assert.ok(matches[0].matchedKeywords.includes('donald trump'));
  assert.ok(matches[0].matchedKeywords.includes('joe biden'));
});

test('ground-probability rejects non-string claim without throwing', async () => {
  const req = {
    method: 'POST',
    body: { claim: 123 },
  };
  const res = responseRecorder();

  await groundProbabilityHandler(req as any, res as any);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, {
    success: false,
    error: 'Missing or invalid "claim" field. Must be a non-empty string.',
  });
});

test('feed stale fallback cache key includes cursor and since', async () => {
  const originalGet = kv.get;
  const originalMget = kv.mget;
  const originalSet = kv.set;
  const originalDel = kv.del;
  const originalScanIterator = kv.scanIterator;

  const tweets = {
    t1: {
      tweet: {
        id: 't1',
        text: 'First tweet',
        author: 'author',
        created_at: '2026-01-01T00:00:00.000Z',
        url: 'https://example.com/t1',
      },
      confidence: 0.9,
      urgency: 'low',
      matches: [],
      analyzed_at: '2026-01-01T00:00:00.000Z',
      collected_at: '2026-01-01T00:00:00.000Z',
    },
    t2: {
      tweet: {
        id: 't2',
        text: 'Second tweet',
        author: 'author',
        created_at: '2026-01-02T00:00:00.000Z',
        url: 'https://example.com/t2',
      },
      confidence: 0.9,
      urgency: 'low',
      matches: [],
      analyzed_at: '2026-01-02T00:00:00.000Z',
      collected_at: '2026-01-02T00:00:00.000Z',
    },
  };

  try {
    kv.get = async (key: string) => {
      if (key === 'feed:latest') return ['t1', 't2'] as any;
      return null;
    };
    kv.mget = async (...keys: string[]) => keys.map(key => tweets[key.replace('tweet:', '') as keyof typeof tweets] ?? null) as any;
    kv.set = async () => 'OK';
    kv.del = async () => 1;
    kv.scanIterator = () => ({
      [Symbol.asyncIterator]: async function* () {
        return;
      },
    });

    const firstResponse = responseRecorder();
    await feedHandler({
      method: 'GET',
      query: { limit: '1' },
    } as any, firstResponse as any);

    assert.equal(firstResponse.statusCode, 200);
    assert.equal((firstResponse.body as any).data.tweets[0].tweet.id, 't1');

    kv.get = async () => {
      throw new Error('quota exceeded');
    };

    const cursorResponse = responseRecorder();
    await feedHandler({
      method: 'GET',
      query: { limit: '1', cursor: 't1', since: '2026-01-01T00:00:00.000Z' },
    } as any, cursorResponse as any);

    assert.equal(cursorResponse.statusCode, 503);
    assert.equal((cursorResponse.body as any).success, false);
  } finally {
    kv.get = originalGet;
    kv.mget = originalMget;
    kv.set = originalSet;
    kv.del = originalDel;
    kv.scanIterator = originalScanIterator;
  }
});
