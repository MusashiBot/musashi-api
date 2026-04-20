#!/usr/bin/env node
/**
 * Single entry before interviews: runs the same ladder as `pnpm test:ci`, then prints pitch prompts.
 */

import { spawnSync } from 'node:child_process';

const result = spawnSync('pnpm', ['run', 'test:ci'], {
  stdio: 'inherit',
  cwd: process.cwd(),
});

if (result.status !== 0) {
  console.error('\nFix failures above before leaning on this repo in interviews.\n');
  process.exit(result.status ?? 1);
}

console.log('');
console.log('✓ Same automation as CI (typecheck + smoke + wallet tests).');
console.log('');
console.log('Talking points (say in your own words):');
console.log('  • Unified cross-venue cache → arbitrage with liquidity-adjusted net spread.');
console.log('  • Ops: WS + semantic embeddings are opt-in (cost, sharp/transformers); rate limits on hot routes.');
console.log('  • Learning loop: signal_outcomes → collect-resolutions → metrics → scripts/backtest.');
console.log('  • Honesty: mid-price arb is screening; executable edge needs books — see docs/ARBITRAGE_REALISM.md.');
console.log('');
console.log('Optional against a real deploy: MUSASHI_API_BASE_URL=<url> pnpm test:agent');
console.log('Pitch detail: README “Interview narrative”, GET /api/health readiness block.');
console.log('');
process.exit(0);
