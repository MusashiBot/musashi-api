import { twitterClient } from '../../src/api/twitter-client';
import { fetchPolymarkets } from "../api/polymarket-client";
import { fetchKalshiMarkets } from '../api/kalshi-client';
import {
  TWITTER_ACCOUNTS,
  getHighPriorityAccounts,
  getMediumPriorityAccounts,
} from '../../src/data/twitter-accounts';
import fs from 'fs/promises';
import path from 'path';

// Cap the number of Twitter accounts to fetch (-1 = all)
const MAX_ACCOUNTS_PER_BATCH = -1;
// How far back to collect tweets (in minutes)
const COLLECTION_MINUTES = 15;

const allHighPriorityAccounts = getHighPriorityAccounts();
const highPriorityAccounts = allHighPriorityAccounts.slice(0, MAX_ACCOUNTS_PER_BATCH);

/**
 * Calls an async fetch function with exponential backoff on 429 rate-limit errors.
 * Returns an empty array if all retries are exhausted or a non-429 error occurs,
 * so a single failing source never blocks the rest of the collection run.
 *
 * @param fn      - The fetch function to call
 * @param name    - Display name used in warning messages (e.g. 'Kalshi')
 * @param retries - Maximum number of attempts (default: 3)
 * @param delayMs - Base delay in ms; multiplied by attempt number each retry (default: 2000)
 */
async function fetchWithRetry<T>(
    fn: () => Promise<T[]>,
    name: string,
    retries = 3,
    delayMs = 2000
): Promise<T[]> {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            return await fn();
        } catch (err: any) {
            if (err.message?.includes('429') && attempt < retries) {
                console.warn(`${name} rate limited, retrying in ${attempt * delayMs}ms... (${attempt}/${retries})`);
                await new Promise(res => setTimeout(res, attempt * delayMs));
            } else {
                console.warn(`${name} fetch failed, skipping:`, err.message);
                return [];
            }
        }
    }
    return [];
}

/**
 * Main collection routine. Fetches tweets and prediction market data in parallel,
 * then writes a timestamped JSON snapshot to src/benchmark/unlabeled_data/.
 *
 * Output shape:
 * {
 *   meta:    { collection window, account list, counts, ... },
 *   tweets:  Tweet[],
 *   markets: Market[]   -- polymarket + kalshi combined
 * }
 */
export async function collect_data() {
    const collectionEnd = new Date();
    const collectionStart = new Date(collectionEnd.getTime() - COLLECTION_MINUTES * 60 * 1000);

    // batchFetchTimelines() automatically uses current time as the window end
    const tweet_results = await twitterClient.batchFetchTimelines(
        highPriorityAccounts.map(a => a.username),
        COLLECTION_MINUTES
    );

    // Flatten per-account tweet arrays into one list
    const tweets = Array.from(tweet_results.values()).flatMap(account => account.tweets);

    const polymarket_markets = await fetchWithRetry(fetchPolymarkets, 'Polymarket');
    const kalshi_markets = await fetchWithRetry(fetchKalshiMarkets, 'Kalshi');
    const markets = [...polymarket_markets, ...kalshi_markets];

    const serializable = {
        meta: {
            collected_at: collectionEnd.toISOString(),
            window_start: collectionStart.toISOString(),
            window_end: collectionEnd.toISOString(),
            window_minutes: COLLECTION_MINUTES,
            twitter_accounts_queried: highPriorityAccounts.map(a => a.username),
            tweet_count: tweets.length,
            market_count: markets.length,
            polymarket_count: polymarket_markets.length,
            kalshi_count: kalshi_markets.length,
        },
        tweets,
        markets,
    };

    const timestamp = collectionEnd
        .toISOString()
        .replace(/[:.]/g, '-');

    // Save to src/benchmark/unlabeled_data/ (absolute path relative to this file)
    const outDir = path.join(__dirname, 'unlabeled_data');
    const filename = path.join(outDir, `results_${timestamp}.json`);

    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(filename, JSON.stringify(serializable, null, 2));

    console.log(`Saved results to ${filename}`);
    console.log(`  tweets:  ${tweets.length}`);
    console.log(`  markets: ${markets.length} (polymarket: ${polymarket_markets.length}, kalshi: ${kalshi_markets.length})`);
}

collect_data().catch(console.error);