import { twitterClient } from '../../src/api/twitter-client';
import {
  TWITTER_ACCOUNTS,
  getHighPriorityAccounts,
  getMediumPriorityAccounts,
} from '../../src/data/twitter-accounts';
import fs from 'fs/promises';

const ACCOUNTS_PER_BATCH = 1;

const allHighPriorityAccounts = getHighPriorityAccounts();
const highPriorityAccounts = allHighPriorityAccounts.slice(0, ACCOUNTS_PER_BATCH);

async function main() {
    const results = await twitterClient.batchFetchTimelines(
        highPriorityAccounts.map(a => a.username),
        15
    );

    // See full nested objects in console
    console.dir(Object.fromEntries(results), {
        depth: null
    });

    // Convert Map -> Object before saving
    const serializable = Object.fromEntries(results);

    await fs.writeFile(
        'results.json',
        JSON.stringify(serializable, null, 2)
    );

    console.log('Saved results to results.json');
}

main().catch(console.error);