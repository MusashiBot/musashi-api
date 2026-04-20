/**
 * Signal pipeline backtest — Monte Carlo with calibration sensitivity.
 *
 * Runs the end-to-end signal pipeline (matcher → sentiment → signal →
 * edge) over a fixed tweet corpus and a fixed market snapshot, then
 * simulates trade outcomes and compares three sizing strategies:
 *
 *   • KELLY   — quarter-Kelly capped at 10% bankroll (our default)
 *   • FLAT    — fixed $100 per signal
 *   • RANDOM  — $100 per signal, random direction (placebo control)
 *
 * Per replication:
 *   1. For each tweet → pick the top signal (if non-HOLD).
 *   2. Simulate the event: with probability `p_actual` the recommended
 *      side wins. `p_actual` is controlled by the `calibration`
 *      parameter — at calibration=1.0 we honor the reported `true_prob`;
 *      at calibration=0.0 we fall back to the market price (zero edge).
 *   3. Settle PnL with fee/slippage.
 *   4. Aggregate over N replications.
 *
 * Metrics:
 *   • total_return_pct   ending-bankroll / starting-bankroll - 1
 *   • sharpe             mean per-trade PnL / std of per-trade PnL
 *   • max_drawdown_pct   peak-to-trough on the cumulative curve
 *   • win_rate           fraction of trades with PnL > 0
 *   • brier              ∑ (true_prob - outcome)^2 / n, smaller is better
 *
 * Results printed as a markdown table and also persisted to
 * `scripts/backtest/fixtures/result.json` for PR automation.
 *
 * Reproducibility:
 *   npx tsx scripts/matcher-eval/snapshot-markets.ts   # regen market snapshot
 *   npx tsx scripts/backtest/run-backtest.ts           # run backtest
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Market } from '../../src/types/market';
import { KeywordMatcher } from '../../src/analysis/keyword-matcher';
import { generateSignal, TradingSignal } from '../../src/analysis/signal-generator';
import { computeEdge } from '../../src/analysis/edge';
import { costFraction, getFeeModel } from '../../src/analysis/fees';
import { brierScore } from '../../src/analysis/edge';

// ─── Deterministic PRNG (Mulberry32) ──────────────────────────────────────
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface TweetFixture {
  id: string;
  text: string;
  expectedCategories: string[];
}

interface SignalForBacktest {
  tweetId: string;
  signal: TradingSignal;
  topMarket: Market;
  trueProb: number;
  yesPrice: number;
}

type Strategy = 'KELLY' | 'FLAT' | 'RANDOM';

interface StrategyMetrics {
  totalReturnPct: number;
  /**
   * Per-trade Sharpe pooled over the *active* trades only (stake > 0).
   * Including skipped slots in the denominator deflates Kelly's number
   * because a selective strategy pads the distribution with zeros. The
   * active-only pooled Sharpe matches what a bot would actually see.
   */
  sharpe: number;
  maxDrawdownPct: number;
  /**
   * Win rate over active trades. Skipped slots are not counted as
   * "losses" because no position was taken.
   */
  winRate: number;
  /** Slots considered (signals × replications). */
  totalSlots: number;
  /** Slots the strategy actually traded (stake > 0). */
  activeTrades: number;
  /** activeTrades / totalSlots, per-replication mean. */
  activeRate: number;
  meanPnl: number;
  stdPnl: number;
}

const BANKROLL_START = 10_000;
const FLAT_STAKE = 100;
const REPLICATIONS = 500;
const CALIBRATION_POINTS = [0.0, 0.25, 0.5, 0.75, 1.0];

function loadMarkets(): Market[] {
  return JSON.parse(readFileSync(resolve('scripts/matcher-eval/fixtures/markets.snapshot.json'), 'utf8')) as Market[];
}

function loadTweets(): TweetFixture[] {
  return JSON.parse(readFileSync(resolve('scripts/matcher-eval/fixtures/tweets.json'), 'utf8')) as TweetFixture[];
}

/**
 * Collect tradable signals from the corpus.
 *
 * We apply stricter tradability filters here than the general matcher
 * gate, because a backtest should simulate *what a real bot would
 * actually execute* — not what the API merely surfaces. Specifically:
 *
 *   • yes price in [0.10, 0.90] → caps single-trade payout at ≤ 9×,
 *     which is where realistic sportsbook-style edges live.
 *   • 24h volume ≥ $25k → bot-scale liquidity (our Kelly stakes are
 *     typically $100–$500, so we need a market that absorbs that).
 */
function collectSignals(markets: Market[], tweets: TweetFixture[]): SignalForBacktest[] {
  const matcher = new KeywordMatcher(markets, 0.22, 5);
  const out: SignalForBacktest[] = [];

  for (const t of tweets) {
    const matches = matcher.match(t.text);
    if (matches.length === 0) continue;
    const signal = generateSignal(t.text, matches);
    if (!signal.suggested_action || signal.suggested_action.direction === 'HOLD') continue;
    if (signal.suggested_action.ev_per_dollar <= 0) continue;
    const top = matches[0].market;
    if (top.yesPrice < 0.1 || top.yesPrice > 0.9) continue;
    if (!Number.isFinite(top.volume24h) || top.volume24h < 25_000) continue;
    const trueProb = signal.metadata.implied_true_prob ?? top.yesPrice;
    out.push({
      tweetId: t.id,
      signal,
      topMarket: top,
      trueProb,
      yesPrice: top.yesPrice,
    });
  }
  return out;
}

/**
 * Settle a single trade.
 *
 * @param stake         Dollars staked (> 0 for YES/NO, 0 for no-trade)
 * @param side          'YES' | 'NO' | 'HOLD'
 * @param yesPrice      Current YES price
 * @param trueProbActual Actual probability the side wins (may differ from reported)
 * @param volume24h     Liquidity proxy
 * @param rng           PRNG
 */
function settleTrade(
  stake: number,
  side: 'YES' | 'NO' | 'HOLD',
  yesPrice: number,
  trueProbActual: number,
  volume24h: number,
  platform: string,
  rng: () => number,
): { pnl: number; won: boolean } {
  if (stake <= 0 || side === 'HOLD') return { pnl: 0, won: false };

  const entry = side === 'YES' ? yesPrice : 1 - yesPrice;
  const payoutIfWin = (1 - entry) / entry;
  const winProb = side === 'YES' ? trueProbActual : 1 - trueProbActual;

  const cost = costFraction(stake, volume24h, entry, getFeeModel(platform));
  const drawU = rng();
  const won = drawU < winProb;
  const pnl = won
    ? stake * payoutIfWin - stake * cost
    : -stake - stake * cost;
  return { pnl, won };
}

/**
 * Per-replication metrics.
 *
 * `pnlPath` contains one entry per *signal slot* (stake=0 for a slot the
 * strategy skipped, actual PnL otherwise). Max drawdown and total return
 * walk the full path (zeros don't change equity). Win rate and Sharpe
 * are computed over **active** entries only, so a selective strategy
 * isn't penalised for the slots it correctly refused to trade.
 */
function computeMetrics(pnlPath: number[]): StrategyMetrics {
  if (pnlPath.length === 0) {
    return {
      totalReturnPct: 0, sharpe: 0, maxDrawdownPct: 0, winRate: 0,
      totalSlots: 0, activeTrades: 0, activeRate: 0, meanPnl: 0, stdPnl: 0,
    };
  }

  const active = pnlPath.filter(p => p !== 0);
  const total = pnlPath.reduce((s, x) => s + x, 0);

  const activeMean = active.length > 0
    ? active.reduce((s, x) => s + x, 0) / active.length
    : 0;
  const activeVariance = active.length > 0
    ? active.reduce((s, x) => s + (x - activeMean) ** 2, 0) / active.length
    : 0;
  const activeStd = Math.sqrt(activeVariance);
  const activeSharpe = activeStd > 0 ? activeMean / activeStd : 0;

  let equity = BANKROLL_START;
  let peak = equity;
  let maxDd = 0;
  for (const p of pnlPath) {
    equity += p;
    peak = Math.max(peak, equity);
    const dd = (peak - equity) / peak;
    maxDd = Math.max(maxDd, dd);
  }

  return {
    totalReturnPct: total / BANKROLL_START,
    sharpe: activeSharpe,
    maxDrawdownPct: maxDd,
    winRate: active.length > 0
      ? active.filter(p => p > 0).length / active.length
      : 0,
    totalSlots: pnlPath.length,
    activeTrades: active.length,
    activeRate: active.length / pnlPath.length,
    meanPnl: activeMean,
    stdPnl: activeStd,
  };
}

function stakeForStrategy(
  strategy: Strategy,
  signal: SignalForBacktest,
  bankroll: number,
  rng: () => number,
): { stake: number; side: 'YES' | 'NO' } {
  const recommendedSide = (signal.signal.suggested_action?.direction ?? 'YES') as 'YES' | 'NO';
  switch (strategy) {
    case 'FLAT':
      return { stake: FLAT_STAKE, side: recommendedSide };
    case 'RANDOM':
      return { stake: FLAT_STAKE, side: rng() < 0.5 ? 'YES' : 'NO' };
    case 'KELLY': {
      const fees = getFeeModel(signal.topMarket.platform);
      const edge = computeEdge({
        trueProb: signal.trueProb,
        yesPrice: signal.yesPrice,
        volume24h: signal.topMarket.volume24h,
        fees,
        stake: Math.min(bankroll * 0.1, 1000),
        confidence: signal.signal.sentiment?.confidence ?? 1,
        kellyCap: 0.25,
      });
      const side = edge.side === 'HOLD' ? recommendedSide : edge.side;
      const fraction = Math.min(edge.kellyFraction, 0.1);
      // Cap against the *starting* bankroll so a lucky streak doesn't
      // size subsequent trades past what the book can absorb. This is
      // the anti-blowup rule real desks apply (a.k.a. "fixed-fraction-
      // of-peak" sizing).
      const capBankroll = Math.min(bankroll, BANKROLL_START * 2);
      return { stake: Math.max(0, capBankroll * fraction), side };
    }
  }
}

function runReplication(
  signals: SignalForBacktest[],
  strategy: Strategy,
  calibration: number,
  rng: () => number,
): { pnlPath: number[]; brierSum: number; brierCount: number } {
  let bankroll = BANKROLL_START;
  const pnlPath: number[] = [];
  let brierSum = 0;
  let brierCount = 0;

  for (const sig of signals) {
    // Calibration: blend reported trueProb toward the market price.
    // calibration=1 → use reported; calibration=0 → use market (zero edge).
    const trueProbActual = calibration * sig.trueProb + (1 - calibration) * sig.yesPrice;
    const { stake, side } = stakeForStrategy(strategy, sig, bankroll, rng);
    if (stake <= 0) { pnlPath.push(0); continue; }

    const { pnl, won } = settleTrade(
      stake,
      side,
      sig.yesPrice,
      trueProbActual,
      sig.topMarket.volume24h,
      sig.topMarket.platform,
      rng,
    );
    bankroll += pnl;
    pnlPath.push(pnl);

    // Brier on the reported prob vs realized outcome (side-agnostic).
    const outcomeYes = side === 'YES' ? (won ? 1 : 0) : (won ? 0 : 1);
    brierSum += brierScore(sig.trueProb, outcomeYes as 0 | 1);
    brierCount++;
  }

  return { pnlPath, brierSum, brierCount };
}

/**
 * Aggregate metrics across replications.
 *
 * Sharpe and mean/std are pooled across *active* trades from every
 * replication; per-rep Sharpe on a handful of active trades is too
 * noisy to average. totalReturn, maxDD, winRate, activeRate are means
 * of the per-replication numbers.
 */
function averageMetrics(results: { pnlPath: number[]; brierSum: number; brierCount: number }[]): StrategyMetrics & { brier: number } {
  const perRepMetrics = results.map(r => computeMetrics(r.pnlPath));
  const mean = (f: (m: StrategyMetrics) => number): number =>
    perRepMetrics.reduce((s, m) => s + f(m), 0) / perRepMetrics.length;

  const brier = results.reduce((s, r) => s + (r.brierCount > 0 ? r.brierSum / r.brierCount : 0), 0) / results.length;

  const activePnls: number[] = [];
  for (const r of results) for (const p of r.pnlPath) if (p !== 0) activePnls.push(p);
  const pooledMean = activePnls.length > 0
    ? activePnls.reduce((s, x) => s + x, 0) / activePnls.length
    : 0;
  const pooledVar = activePnls.length > 0
    ? activePnls.reduce((s, x) => s + (x - pooledMean) ** 2, 0) / activePnls.length
    : 0;
  const pooledStd = Math.sqrt(pooledVar);
  const pooledSharpe = pooledStd > 0 ? pooledMean / pooledStd : 0;

  return {
    totalReturnPct: mean(m => m.totalReturnPct),
    sharpe: pooledSharpe,
    maxDrawdownPct: mean(m => m.maxDrawdownPct),
    winRate: mean(m => m.winRate),
    totalSlots: perRepMetrics[0]?.totalSlots ?? 0,
    activeTrades: Math.round(mean(m => m.activeTrades)),
    activeRate: mean(m => m.activeRate),
    meanPnl: pooledMean,
    stdPnl: pooledStd,
    brier,
  };
}

function fmtPct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function fmtMoney(x: number): string {
  const sign = x >= 0 ? '+' : '-';
  return `${sign}$${Math.abs(x).toFixed(2)}`;
}

function main(): void {
  const markets = loadMarkets();
  const tweets = loadTweets();
  console.log(
    `[backtest] corpus: ${tweets.length} tweets × ${markets.length} markets ` +
    `(${markets.filter(m => m.platform === 'polymarket').length} Polymarket + ` +
    `${markets.filter(m => m.platform === 'kalshi').length} Kalshi)`,
  );

  const signals = collectSignals(markets, tweets);
  console.log(`[backtest] produced ${signals.length} non-HOLD signals (out of ${tweets.length} tweets)\n`);
  if (signals.length === 0) {
    console.log('No actionable signals; nothing to simulate.');
    return;
  }

  const strategies: Strategy[] = ['KELLY', 'FLAT', 'RANDOM'];
  const headline: Record<Strategy, StrategyMetrics & { brier: number }> = {} as Record<Strategy, StrategyMetrics & { brier: number }>;

  // 1) Headline results at calibration=1.0 (signal-calibration assumption)
  for (const strategy of strategies) {
    const results: { pnlPath: number[]; brierSum: number; brierCount: number }[] = [];
    for (let i = 0; i < REPLICATIONS; i++) {
      const rng = makeRng(20260420 + i);
      results.push(runReplication(signals, strategy, 1.0, rng));
    }
    headline[strategy] = averageMetrics(results);
  }

  console.log('### Headline (calibration = 1.0, ' + REPLICATIONS + ' replications)\n');
  console.log('| strategy | active / slots | total return | active Sharpe | max DD | active win rate |   Brier |');
  console.log('|----------|---------------:|-------------:|--------------:|-------:|----------------:|--------:|');
  for (const s of strategies) {
    const m = headline[s];
    const slots = m.totalSlots;
    console.log(
      `| ${s.padEnd(8)} | ${`${m.activeTrades}/${slots}`.padStart(14)} |` +
      ` ${fmtPct(m.totalReturnPct).padStart(12)} |` +
      ` ${m.sharpe.toFixed(3).padStart(13)} |` +
      ` ${fmtPct(m.maxDrawdownPct).padStart(6)} |` +
      ` ${fmtPct(m.winRate).padStart(15)} |` +
      ` ${m.brier.toFixed(3).padStart(7)} |`,
    );
  }

  // 2) Calibration sensitivity
  console.log('\n### Kelly sensitivity to signal calibration\n');
  console.log('| calibration | total return | active Sharpe | max DD | active win rate |');
  console.log('|------------:|-------------:|--------------:|-------:|----------------:|');
  const sens: Array<{ calibration: number; metrics: StrategyMetrics & { brier: number } }> = [];
  for (const c of CALIBRATION_POINTS) {
    const results: { pnlPath: number[]; brierSum: number; brierCount: number }[] = [];
    for (let i = 0; i < REPLICATIONS; i++) {
      const rng = makeRng(20260421 + i * 7);
      results.push(runReplication(signals, 'KELLY', c, rng));
    }
    const m = averageMetrics(results);
    sens.push({ calibration: c, metrics: m });
    console.log(
      `| ${c.toFixed(2).padStart(11)} | ${fmtPct(m.totalReturnPct).padStart(12)} |` +
      ` ${m.sharpe.toFixed(3).padStart(13)} |` +
      ` ${fmtPct(m.maxDrawdownPct).padStart(6)} |` +
      ` ${fmtPct(m.winRate).padStart(15)} |`,
    );
  }

  const outPath = resolve('scripts/backtest/fixtures/result.json');
  writeFileSync(outPath, JSON.stringify({
    corpus: { tweets: tweets.length, markets: markets.length, signals: signals.length },
    replications: REPLICATIONS,
    headline,
    sensitivity: sens,
    generatedAt: new Date().toISOString(),
  }, null, 2));
  console.log(`\n[backtest] wrote machine-readable result to ${outPath}`);
}

main();
