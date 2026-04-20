import test from 'node:test';
import assert from 'node:assert/strict';

const sentimentModule = await import('../../src/analysis/sentiment-analyzer.ts');
const entityModule = await import('../../src/analysis/entity-extractor.ts');
const kellyModule = await import('../../src/analysis/kelly-sizing.ts');
const keywordModule = await import('../../src/analysis/keyword-matcher.ts');

function getExport(module, name) {
  return module?.[name] ?? module?.default?.[name];
}

const analyzeSentiment = getExport(sentimentModule, 'analyzeSentiment');
const aggregateWeightedSentiment = getExport(sentimentModule, 'aggregateWeightedSentiment');
const extractEntities = getExport(entityModule, 'extractEntities');
const isEntity = getExport(entityModule, 'isEntity');
const kellySizing = getExport(kellyModule, 'kellySizing');
const detectVolatilityRegime = getExport(kellyModule, 'detectVolatilityRegime');
const detectAnomalousMove = getExport(kellyModule, 'detectAnomalousMove');
const KeywordMatcher = getExport(keywordModule, 'KeywordMatcher');

function createMarket(overrides = {}) {
  return {
    id: 'mkt-1',
    platform: 'polymarket',
    title: 'Will the Federal Reserve cut rates by June 2026?',
    description: 'Fed rate-cut market',
    keywords: ['federal reserve', 'rate cut', 'interest rates', 'fed'],
    yesPrice: 0.62,
    noPrice: 0.38,
    volume24h: 100000,
    url: 'https://example.com/mkt-1',
    category: 'economics',
    lastUpdated: new Date().toISOString(),
    oneDayPriceChange: 0.04,
    endDate: new Date(Date.now() + (5 * 24 * 60 * 60 * 1000)).toISOString(),
    ...overrides,
  };
}

// ─── Sentiment Analyzer ─────────────────────────────────────────────────────

test('analyzeSentiment returns bullish for bullish-heavy language', () => {
  const result = analyzeSentiment('very bullish rally moon pump up only');
  assert.equal(result.sentiment, 'bullish');
  assert.ok(result.confidence > 0.6);
});

test('analyzeSentiment handles negation by reversing polarity', () => {
  const result = analyzeSentiment('not bullish and not rally');
  assert.equal(result.sentiment, 'bearish');
  assert.ok(result.confidence > 0.6);
});

test('analyzeSentiment returns neutral with no sentiment terms', () => {
  const result = analyzeSentiment('the quick brown fox jumps over the lazy dog');
  assert.equal(result.sentiment, 'neutral');
  assert.equal(result.confidence, 0);
});

test('aggregateWeightedSentiment returns neutral for empty input', () => {
  const result = aggregateWeightedSentiment([]);
  assert.equal(result.direction, 'neutral');
  assert.equal(result.conviction, 0);
  assert.equal(result.tweet_count, 0);
});

test('aggregateWeightedSentiment weighs recent tweets more heavily', () => {
  const now = Date.now();
  const result = aggregateWeightedSentiment([
    {
      text: 'bullish rally',
      timestamp: now - (40 * 60 * 1000),
      author: { followers: 10000, engagementRate: 0.05 },
    },
    {
      text: 'bearish crash',
      timestamp: now - (60 * 1000),
      author: { followers: 10000, engagementRate: 0.05 },
    },
  ]);

  assert.equal(result.direction, 'bearish');
  assert.equal(result.tweet_count, 2);
  assert.equal(result.bullish_count, 1);
  assert.equal(result.bearish_count, 1);
});

test('aggregateWeightedSentiment factors follower/engagement influence', () => {
  const now = Date.now();
  const result = aggregateWeightedSentiment([
    {
      text: 'bullish breakout',
      timestamp: now,
      author: { followers: 1_000_000, engagementRate: 0.1 },
    },
    {
      text: 'bearish correction',
      timestamp: now,
      author: { followers: 100, engagementRate: 0.01 },
    },
  ]);

  assert.equal(result.direction, 'bullish');
  assert.ok(result.conviction > 0);
});

// ─── Entity Extractor ───────────────────────────────────────────────────────

test('extractEntities captures tickers, people, organizations, and dates', () => {
  const entities = extractEntities(
    'Jerome Powell said $BTC and NVDA could rise by March 2026 according to Federal Reserve updates.'
  );

  assert.ok(entities.people.includes('jerome powell'));
  assert.ok(entities.tickers.includes('BTC'));
  assert.ok(entities.tickers.includes('NVDA'));
  assert.ok(entities.organizations.includes('federal reserve'));
  assert.ok(entities.dates.includes('march 2026'));
  assert.ok(entities.all.length >= 4);
});

test('extractEntities filters common uppercase words from tickers', () => {
  const entities = extractEntities('The CEO of USA based firm said YES to this plan.');

  assert.equal(entities.tickers.includes('CEO'), false);
  assert.equal(entities.tickers.includes('USA'), false);
  assert.equal(entities.tickers.includes('YES'), false);
});

test('isEntity matches across extracted entity buckets', () => {
  const entities = extractEntities('OpenAI and Jerome Powell discuss Q2 2026 outlook for $ETH.');

  assert.equal(isEntity('openai', entities), true);
  assert.equal(isEntity('jerome powell', entities), true);
  assert.equal(isEntity('ETH', entities), true);
  assert.equal(isEntity('q2 2026', entities), true);
  assert.equal(isEntity('totally-random-token', entities), false);
});

// ─── Kelly Sizing ───────────────────────────────────────────────────────────

test('kellySizing returns positive capped fraction for positive edge', () => {
  const result = kellySizing(0.1, 0.7, 0.5, 'normal');
  assert.ok(result.fraction > 0);
  assert.ok(result.fraction <= 0.1);
  assert.ok(result.rationale.includes('Kelly='));
});

test('kellySizing returns zero for negative expected edge', () => {
  const result = kellySizing(-0.1, 0.4, 0.6, 'normal');
  assert.equal(result.fraction, 0);
  assert.ok(result.rationale.includes('negative edge'));
});

test('kellySizing scales by volatility regime', () => {
  const low = kellySizing(0.12, 0.7, 0.5, 'low');
  const normal = kellySizing(0.12, 0.7, 0.5, 'normal');
  const high = kellySizing(0.12, 0.7, 0.5, 'high');

  assert.ok(low.fraction >= normal.fraction);
  assert.ok(normal.fraction >= high.fraction);
});

test('detectVolatilityRegime returns high when 1h variance dominates', () => {
  const now = Date.now();
  const history = [
    { price: 0.50, timestamp: now - (23 * 60 * 60 * 1000) },
    { price: 0.51, timestamp: now - (12 * 60 * 60 * 1000) },
    { price: 0.50, timestamp: now - (2 * 60 * 60 * 1000) },
    { price: 0.10, timestamp: now - (30 * 60 * 1000) },
    { price: 0.90, timestamp: now - (10 * 60 * 1000) },
  ];

  assert.equal(detectVolatilityRegime(history), 'high');
});

test('detectAnomalousMove flags 3-sigma-style spikes', () => {
  const now = Date.now();
  const history = [];

  // Build a stable baseline around 0.5 over the previous hour.
  for (let i = 0; i < 20; i++) {
    history.push({
      price: 0.5 + ((i % 2 === 0) ? 0.002 : -0.002),
      timestamp: now - ((70 - i) * 60 * 1000),
    });
  }

  // Recent window contains one normal tick and one extreme spike.
  history.push({ price: 0.5, timestamp: now - (9 * 60 * 1000) });
  history.push({ price: 0.95, timestamp: now - (2 * 60 * 1000) });

  assert.equal(detectAnomalousMove(history, 10), true);
});

// ─── Keyword Matcher ────────────────────────────────────────────────────────

test('KeywordMatcher uses synonym expansion for fed -> federal reserve', () => {
  const matcher = new KeywordMatcher([createMarket()], 0.2, 5);
  const matches = matcher.match('Fed will probably cut rates soon according to recent inflation data.');

  assert.equal(matches.length > 0, true);
  assert.equal(matches[0].market.id, 'mkt-1');
  assert.ok(matches[0].confidence >= 0.2);
});

test('KeywordMatcher enforces minimum tweet length', () => {
  const matcher = new KeywordMatcher([createMarket()], 0.2, 5);
  const matches = matcher.match('fed cut now');
  assert.equal(matches.length, 0);
});

test('KeywordMatcher avoids partial word false positives via boundaries', () => {
  const market = createMarket({
    id: 'mkt-trump',
    title: 'Will Trump win?',
    keywords: ['trump', 'win'],
  });

  const matcher = new KeywordMatcher([market], 0.2, 5);
  const matches = matcher.match('The trumpet section sounded great at tonight\'s concert in the city.');
  assert.equal(matches.length, 0);
});

test('KeywordMatcher respects max results ordering', () => {
  const markets = [
    createMarket({ id: 'mkt-1' }),
    createMarket({ id: 'mkt-2', title: 'Will rates be cut in 2026?', keywords: ['fed', 'rates', 'cut'] }),
    createMarket({ id: 'mkt-3', title: 'Will inflation cool?', keywords: ['inflation', 'fed', 'rates'] }),
  ];

  const matcher = new KeywordMatcher(markets, 0.2, 2);
  const matches = matcher.match('The Fed is likely to cut rates as inflation slows this year and policy turns.');

  assert.equal(matches.length <= 2, true);
  assert.equal(matches.every((m) => m.confidence >= 0.2), true);
});
