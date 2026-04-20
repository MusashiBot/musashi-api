/**
 * Matcher evaluation harness.
 *
 * Runs the KeywordMatcher against a fixed snapshot of real Polymarket +
 * Kalshi markets and a fixed set of annotated tweets, with and without the
 * post-match quality gate, and reports deterministic junk-rate metrics.
 *
 * Reproducibility:
 *   npx tsx scripts/matcher-eval/snapshot-markets.ts   # regenerate snapshot
 *   npx tsx scripts/matcher-eval/run-eval.ts           # run eval
 *
 * Metrics (lower is better for the first three):
 *   junk_rate           fraction of matches flagged junk by at least one rule
 *   cross_domain_rate   fraction of matches in a category unrelated to tweet
 *   thin_market_rate    fraction of matches with 24h volume < $5k
 *   extreme_price_rate  fraction of matches priced <2% or >98%
 *   matches_per_tweet   average surfaced matches (recall proxy)
 *
 * Treating volume/category/price labels as ground truth is a
 * deterministic proxy for "would a bot actually want to trade this?"
 * It's not perfect, but it's reproducible, not subject to annotator
 * bias, and aligned with what the downstream trading math cares about.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Market, MarketMatch } from '../../src/types/market';
import { KeywordMatcher } from '../../src/analysis/keyword-matcher';

interface TweetFixture {
  id: string;
  text: string;
  expectedCategories: string[];
}

interface EvalMetrics {
  totalTweets: number;
  totalMatches: number;
  matchesPerTweet: number;
  junkRate: number;
  crossDomainRate: number;
  thinMarketRate: number;
  extremePriceRate: number;
  weakSignalRate: number;
  // Raw counts
  junkCount: number;
  crossDomainCount: number;
  thinMarketCount: number;
  extremePriceCount: number;
  weakSignalCount: number;
}

const THIN_VOLUME_FLOOR = 5_000;
const EXTREME_BAND = 0.02;
const STRONG_CONFIDENCE = 0.55;

function loadMarkets(): Market[] {
  const path = resolve('scripts/matcher-eval/fixtures/markets.snapshot.json');
  return JSON.parse(readFileSync(path, 'utf8')) as Market[];
}

function loadTweets(): TweetFixture[] {
  const path = resolve('scripts/matcher-eval/fixtures/tweets.json');
  return JSON.parse(readFileSync(path, 'utf8')) as TweetFixture[];
}

function isThin(m: MarketMatch): boolean {
  const v = Number(m.market.volume24h);
  return !Number.isFinite(v) || v < THIN_VOLUME_FLOOR;
}

function isExtremePrice(m: MarketMatch): boolean {
  const yes = Number(m.market.yesPrice);
  if (!Number.isFinite(yes)) return false;
  return yes < EXTREME_BAND || yes > 1 - EXTREME_BAND;
}

function isCrossDomain(m: MarketMatch, expected: string[]): boolean {
  if (expected.length === 0) return false; // tweet has no category claim
  return !expected.includes(m.market.category);
}

function isWeakSignal(m: MarketMatch): boolean {
  if (m.confidence >= STRONG_CONFIDENCE) return false;
  return !m.matchedKeywords.some(k => k.includes(' '));
}

function evaluate(
  tweets: TweetFixture[],
  markets: Market[],
  qualityGateEnabled: boolean,
): EvalMetrics {
  const matcher = new KeywordMatcher(markets, 0.22, 5, qualityGateEnabled ? {} : false);
  let totalMatches = 0;
  let junkCount = 0;
  let crossDomainCount = 0;
  let thinMarketCount = 0;
  let extremePriceCount = 0;
  let weakSignalCount = 0;

  for (const tw of tweets) {
    const matches = matcher.match(tw.text);
    for (const m of matches) {
      totalMatches++;
      const thin = isThin(m);
      const extreme = isExtremePrice(m);
      const cross = isCrossDomain(m, tw.expectedCategories);
      const weak = isWeakSignal(m);
      if (thin) thinMarketCount++;
      if (extreme) extremePriceCount++;
      if (cross) crossDomainCount++;
      if (weak) weakSignalCount++;
      if (thin || extreme || cross || weak) junkCount++;
    }
  }

  const n = Math.max(1, totalMatches);
  return {
    totalTweets: tweets.length,
    totalMatches,
    matchesPerTweet: totalMatches / tweets.length,
    junkRate: junkCount / n,
    crossDomainRate: crossDomainCount / n,
    thinMarketRate: thinMarketCount / n,
    extremePriceRate: extremePriceCount / n,
    weakSignalRate: weakSignalCount / n,
    junkCount,
    crossDomainCount,
    thinMarketCount,
    extremePriceCount,
    weakSignalCount,
  };
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function rowCompare(label: string, before: number, after: number, isRate = true): string {
  const b = isRate ? pct(before) : before.toFixed(2);
  const a = isRate ? pct(after) : after.toFixed(2);
  const delta = isRate
    ? `${(after - before >= 0 ? '+' : '')}${((after - before) * 100).toFixed(1)}pp`
    : `${(after - before >= 0 ? '+' : '')}${(after - before).toFixed(2)}`;
  return `| ${label.padEnd(32)} | ${b.padStart(8)} | ${a.padStart(8)} | ${delta.padStart(9)} |`;
}

function main(): void {
  const markets = loadMarkets();
  const tweets = loadTweets();
  console.log(
    `[eval] corpus: ${tweets.length} tweets × ${markets.length} markets ` +
    `(${markets.filter(m => m.platform === 'polymarket').length} Polymarket + ` +
    `${markets.filter(m => m.platform === 'kalshi').length} Kalshi)\n`,
  );

  const before = evaluate(tweets, markets, false); // baseline: gate disabled
  const after = evaluate(tweets, markets, true);   // gated: default options

  const sep = '|----------------------------------|----------|----------|-----------|';
  console.log('| metric                           |   before |    after |     delta |');
  console.log(sep);
  console.log(rowCompare('total matches surfaced', before.totalMatches, after.totalMatches, false));
  console.log(rowCompare('matches per tweet', before.matchesPerTweet, after.matchesPerTweet, false));
  console.log(rowCompare('junk rate (any rule)', before.junkRate, after.junkRate));
  console.log(rowCompare('thin-market rate (<$5k)', before.thinMarketRate, after.thinMarketRate));
  console.log(rowCompare('extreme-price rate (<2%/>98%)', before.extremePriceRate, after.extremePriceRate));
  console.log(rowCompare('cross-domain rate', before.crossDomainRate, after.crossDomainRate));
  console.log(rowCompare('weak-signal rate', before.weakSignalRate, after.weakSignalRate));
  console.log(sep);

  console.log('\nraw counts:');
  console.log(`  before → total=${before.totalMatches} junk=${before.junkCount} (thin=${before.thinMarketCount} ext=${before.extremePriceCount} cross=${before.crossDomainCount} weak=${before.weakSignalCount})`);
  console.log(`  after  → total=${after.totalMatches} junk=${after.junkCount} (thin=${after.thinMarketCount} ext=${after.extremePriceCount} cross=${after.crossDomainCount} weak=${after.weakSignalCount})`);

  // Write a machine-readable JSON too, for CI or PR-body automation.
  const outPath = resolve('scripts/matcher-eval/fixtures/eval-result.json');
  const payload = { before, after, generatedAt: new Date().toISOString() };
  require('node:fs').writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.log(`\n[eval] wrote machine-readable result to ${outPath}`);
}

main();
