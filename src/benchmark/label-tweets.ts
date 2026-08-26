/**
 * Interactive / CLI tweet labeler for the benchmark dataset.
 *
 * Rubric: src/benchmark/LABELING_RUBRIC.md
 *
 * Usage:
 *   pnpm run label                  # interactive unlabeled queue
 *   pnpm run label -- --status      # progress summary
 *   pnpm run label -- --tweet-id ID --is-relevant no --sentiment neutral --confidence high --labeler-id anon-1
 *   pnpm run label -- --clear --tweet-id ID
 */

import fs from 'fs/promises';
import path from 'path';
import readline from 'readline';
import {
  BenchmarkMarket,
  BenchmarkTweet,
  ConfidenceLabel,
  RelevanceLabel,
  SentimentLabel,
  benchmarkDir,
  isLabeled,
  readJsonl,
  writeJsonl,
} from './schema';

function argValue(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function parseRelevance(v: string): RelevanceLabel {
  const x = v.toLowerCase();
  if (x === 'yes' || x === 'y' || x === '1') return 'yes';
  if (x === 'no' || x === 'n' || x === '0') return 'no';
  throw new Error(`Invalid is_relevant "${v}" (expected yes|no)`);
}

function parseSentiment(v: string): SentimentLabel {
  const x = v.toLowerCase();
  if (x === 'bullish' || x === 'bull' || x === 'b') return 'bullish';
  if (x === 'bearish' || x === 'bear' || x === 's') return 'bearish';
  if (x === 'neutral' || x === 'neu' || x === 'n') return 'neutral';
  throw new Error(`Invalid sentiment "${v}" (expected bullish|bearish|neutral)`);
}

function parseConfidence(v: string): ConfidenceLabel {
  const x = v.toLowerCase();
  if (x === 'high' || x === 'h') return 'high';
  if (x === 'medium' || x === 'med' || x === 'm') return 'medium';
  if (x === 'low' || x === 'l') return 'low';
  throw new Error(`Invalid confidence "${v}" (expected high|medium|low)`);
}

async function loadDataset(version: string): Promise<{
  dir: string;
  markets: BenchmarkMarket[];
  tweets: BenchmarkTweet[];
  marketsById: Map<string, BenchmarkMarket>;
}> {
  const dir = benchmarkDir(version);
  const markets = await readJsonl<BenchmarkMarket>(path.join(dir, 'markets.jsonl'));
  const tweets = await readJsonl<BenchmarkTweet>(path.join(dir, 'tweets.jsonl'));
  return {
    dir,
    markets,
    tweets,
    marketsById: new Map(markets.map(m => [m.market_id, m])),
  };
}

function printStatus(tweets: BenchmarkTweet[]): void {
  const labeled = tweets.filter(isLabeled).length;
  const unlabeled = tweets.length - labeled;
  console.log(`tweets: ${tweets.length}  labeled: ${labeled}  unlabeled: ${unlabeled}`);
}

function ask(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise(resolve => rl.question(prompt, answer => resolve(answer.trim())));
}

async function interactiveLabel(
  tweets: BenchmarkTweet[],
  marketsById: Map<string, BenchmarkMarket>,
  labelerId: string,
  limit: number,
  tweetsPath: string
): Promise<void> {
  const queue = tweets.filter(t => !isLabeled(t)).slice(0, limit);
  if (queue.length === 0) {
    console.log('No unlabeled tweets remaining.');
    return;
  }

  console.log(`Labeling ${queue.length} tweet(s). Rubric: src/benchmark/LABELING_RUBRIC.md`);
  console.log('Commands: yes/no | bullish/bearish/neutral | high/medium/low | s=skip | q=quit\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let saved = 0;

  try {
    for (let i = 0; i < queue.length; i++) {
      const tweet = queue[i];
      const market = marketsById.get(tweet.market_id);
      console.log('─'.repeat(72));
      console.log(`[${i + 1}/${queue.length}] tweet_id=${tweet.tweet_id}`);
      console.log(`market: ${market?.question ?? tweet.market_id}`);
      console.log(`category=${market?.category ?? '?'}  resolution=${market?.resolution ?? '?'}  offset=${tweet.offset_minutes}m`);
      console.log(`matcher: ${tweet.matcher_result.status} (score=${tweet.matcher_result.score.toFixed(3)})`);
      console.log(`text:\n${tweet.text}\n`);

      const relRaw = await ask(rl, 'is_relevant [yes/no] (s skip, q quit): ');
      if (relRaw.toLowerCase() === 'q') break;
      if (relRaw.toLowerCase() === 's' || relRaw === '') continue;

      const sentRaw = await ask(rl, 'sentiment [bullish/bearish/neutral]: ');
      if (sentRaw.toLowerCase() === 'q') break;
      if (sentRaw.toLowerCase() === 's' || sentRaw === '') continue;

      const confRaw = await ask(rl, 'confidence [high/medium/low]: ');
      if (confRaw.toLowerCase() === 'q') break;
      if (confRaw.toLowerCase() === 's' || confRaw === '') continue;

      try {
        tweet.is_relevant = parseRelevance(relRaw);
        tweet.sentiment_label = parseSentiment(sentRaw);
        tweet.label_confidence = parseConfidence(confRaw);
        tweet.labeler_id = labelerId;
        saved++;
        await writeJsonl(tweetsPath, tweets);
        console.log('Saved.\n');
      } catch (err) {
        console.error(`Invalid input: ${err instanceof Error ? err.message : err}`);
      }
    }
  } finally {
    rl.close();
  }

  console.log(`Labeled ${saved} tweet(s) this session.`);
  printStatus(tweets);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const version = argValue(args, '--version') ?? process.env.BENCHMARK_VERSION ?? 'v1';
  const labelerId = argValue(args, '--labeler-id') ?? process.env.BENCHMARK_LABELER_ID ?? 'anon-1';
  const limit = Number(argValue(args, '--limit') ?? Infinity);

  const { dir, tweets, marketsById } = await loadDataset(version);
  const tweetsPath = path.join(dir, 'tweets.jsonl');

  if (hasFlag(args, '--status')) {
    printStatus(tweets);
    return;
  }

  const tweetId = argValue(args, '--tweet-id');

  if (hasFlag(args, '--clear')) {
    if (!tweetId) throw new Error('--clear requires --tweet-id');
    const tweet = tweets.find(t => t.tweet_id === tweetId);
    if (!tweet) throw new Error(`tweet_id not found: ${tweetId}`);
    tweet.is_relevant = null;
    tweet.sentiment_label = null;
    tweet.label_confidence = null;
    tweet.labeler_id = null;
    await writeJsonl(tweetsPath, tweets);
    console.log(`Cleared labels for ${tweetId}`);
    printStatus(tweets);
    return;
  }

  if (tweetId) {
    const isRelevant = argValue(args, '--is-relevant');
    const sentiment = argValue(args, '--sentiment');
    const confidence = argValue(args, '--confidence');
    if (!isRelevant || !sentiment || !confidence) {
      throw new Error('Non-interactive mode requires --is-relevant, --sentiment, and --confidence');
    }
    const tweet = tweets.find(t => t.tweet_id === tweetId);
    if (!tweet) throw new Error(`tweet_id not found: ${tweetId}`);
    tweet.is_relevant = parseRelevance(isRelevant);
    tweet.sentiment_label = parseSentiment(sentiment);
    tweet.label_confidence = parseConfidence(confidence);
    tweet.labeler_id = labelerId;
    await writeJsonl(tweetsPath, tweets);
    console.log(`Labeled ${tweetId}`);
    printStatus(tweets);
    return;
  }

  // Ensure rubric is present next to this tool
  const rubricPath = path.join(__dirname, 'LABELING_RUBRIC.md');
  try {
    await fs.access(rubricPath);
  } catch {
    console.warn(`Warning: missing rubric at ${rubricPath}`);
  }

  await interactiveLabel(tweets, marketsById, labelerId, limit, tweetsPath);
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
