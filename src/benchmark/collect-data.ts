import { twitterClient } from '../../src/api/twitter-client';
import { fetchPolymarkets } from "../api/polymarket-client";
import { fetchKalshiMarkets } from '../api/kalshi-client';
import {
  TWITTER_ACCOUNTS,
  getHighPriorityAccounts,
  getMediumPriorityAccounts,
} from '../../src/data/twitter-accounts';
import fs from 'fs/promises';

const MAX_ACCOUNTS_PER_BATCH = -1;
const COLLECTION_MINUTES = 15

const allHighPriorityAccounts = getHighPriorityAccounts();
const highPriorityAccounts = allHighPriorityAccounts.slice(0, MAX_ACCOUNTS_PER_BATCH);

export async function collect_data() {
    const collectionEnd = new Date();
    const collectionStart = new Date(collectionEnd.getTime() - COLLECTION_MINUTES * 60 * 1000);

    const tweet_results = await twitterClient.batchFetchTimelines(
        highPriorityAccounts.map(a => a.username),
        COLLECTION_MINUTES
    );

    // Flatten all tweets from all accounts into a single array
    const tweets = Array.from(tweet_results.values()).flatMap(account => account.tweets);

    const polymarket_markets = await fetchPolymarkets()
    const kalshi_markets = await fetchKalshiMarkets()
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

    await fs.mkdir('unlabeled_data', { recursive: true });

    const filename = `unlabeled_data/results_${timestamp}.json`;

    await fs.writeFile(
        filename,
        JSON.stringify(serializable, null, 2)
    );

    console.log(`Saved results to ${filename}`);
}

collect_data().catch(console.error);