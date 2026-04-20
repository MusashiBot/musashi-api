# Quick Start: Performance Tracking

Get up and running with performance tracking for your prediction market signals in 5 minutes.

## Prerequisites

- Supabase project with `signal_outcomes` table (see Database Schema below)
- Environment variables configured
- Vercel deployment (or local dev server)

## Step 1: Environment Setup

Add to your `.env.local` or Vercel environment variables:

```bash
# Required
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your_service_role_key
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_anon_key

# Optional (for resolve-market endpoint auth)
INTERNAL_API_KEY=your_secret_internal_key
```

## Step 2: Database Setup

Create the `signal_outcomes` table in Supabase:

```sql
CREATE TABLE signal_outcomes (
  signal_id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  event_id TEXT NOT NULL,
  market_id TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('polymarket', 'kalshi')),
  predicted_direction TEXT NOT NULL CHECK (predicted_direction IN ('YES', 'NO', 'HOLD')),
  predicted_prob NUMERIC NOT NULL CHECK (predicted_prob >= 0 AND predicted_prob <= 1),
  confidence NUMERIC NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  edge NUMERIC NOT NULL,
  signal_type TEXT NOT NULL,
  urgency TEXT NOT NULL,
  features JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  resolution_date TIMESTAMPTZ,
  outcome TEXT CHECK (outcome IN ('YES', 'NO')),
  was_correct BOOLEAN,
  pnl NUMERIC
);

-- Indexes for performance
CREATE INDEX idx_signal_outcomes_market ON signal_outcomes(market_id, platform);
CREATE INDEX idx_signal_outcomes_created ON signal_outcomes(created_at DESC);
CREATE INDEX idx_signal_outcomes_resolved ON signal_outcomes(outcome) WHERE outcome IS NOT NULL;
CREATE INDEX idx_signal_outcomes_type ON signal_outcomes(signal_type);
```

## Step 3: Deploy

Push your changes to Vercel:

```bash
git add .
git commit -m "Add performance tracking and resolution webhooks"
git push origin main
```

Or test locally:

```bash
pnpm dev
```

## Step 4: Store Your First Signal

When generating signals in your app, store them:

```typescript
import { createSupabaseBrowserClient, TABLES } from './src/api/supabase-client';

// After generating a signal
const signal = generateSignal(text, matches, arbitrage, volRegime);

const supabase = createSupabaseBrowserClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

await supabase.from(TABLES.signalOutcomes).insert({
  event_id: signal.event_id,
  market_id: signal.matches[0].market.id,
  platform: signal.matches[0].market.platform,
  predicted_direction: signal.suggested_action === 'BUY_YES' ? 'YES' : 'NO',
  predicted_prob: signal.matches[0].market.yesPrice,
  confidence: signal.matches[0].confidence,
  edge: signal.arbitrage?.net_spread || 0,
  signal_type: signal.signal_type,
  urgency: signal.urgency,
  features: {
    sentiment: signal.sentiment,
    arbitrage: signal.arbitrage,
  },
});
```

## Step 5: Test the Endpoints

### View Performance Metrics

```bash
curl https://your-domain.vercel.app/api/metrics/performance | jq
```

Expected response:
```json
{
  "success": true,
  "data": {
    "win_rate_24h": {},
    "brier_score_30d": 0,
    "signal_stats": {
      "total_generated": 1,
      "total_resolved": 0,
      "pending_resolution": 1
    }
  }
}
```

### Manually Resolve a Market

```bash
curl -X POST https://your-domain.vercel.app/api/internal/resolve-market \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your_secret_key" \
  -d '{
    "market_id": "0x1234...",
    "platform": "polymarket",
    "outcome": "YES"
  }' | jq
```

Expected response:
```json
{
  "success": true,
  "signals_updated": 1,
  "total_pl": 42.50
}
```

## Step 6: Automate Resolution Collection

Run the batch job manually to test:

```bash
node --import tsx scripts/ml/collect-resolutions.ts
```

Or set up as a cron job (add to `vercel.json`):

```json
{
  "crons": [
    {
      "path": "/api/cron/collect-resolutions",
      "schedule": "0 */6 * * *"
    }
  ]
}
```

Then create the cron endpoint at `api/cron/collect-resolutions.ts`:

```typescript
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { collectResolutions } from '../../scripts/ml/collect-resolutions';

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  try {
    await collectResolutions();
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown error' 
    });
  }
}
```

## Step 7: Run the Test Suite

Verify everything works:

```bash
# Local testing
MUSASHI_API_BASE_URL=http://localhost:3000 \
INTERNAL_API_KEY=your_key \
node --import tsx scripts/test-performance-endpoints.ts
```

Expected output:
```
============================================================
Performance Tracking Endpoints Test Suite
============================================================

✓ Performance metrics endpoint test passed
✓ Resolve market endpoint test passed
✓ Authentication failure test passed
✓ Invalid payload test passed

============================================================
Test Results Summary
============================================================
✓ Performance Metrics (234ms)
✓ Resolve Market (156ms)
✓ Authentication Failure (89ms)
✓ Invalid Payload (102ms)

Total: 4 tests
Passed: 4
Failed: 0

🎉 All tests passed!
```

## Common Issues

### "Supabase configuration missing"
- Ensure `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_KEY` are set
- Check Vercel environment variables are deployed

### "Failed to fetch signals"
- Verify the `signal_outcomes` table exists in Supabase
- Check table permissions (service key should have full access)

### "Unauthorized"
- Set `INTERNAL_API_KEY` environment variable
- Include `X-API-Key` header in requests to `/api/internal/resolve-market`

### "No signals found"
- Insert test signals using the code from Step 4
- Check signals are stored with `outcome = NULL`

## Next Steps

1. **Build a Dashboard**: Create a UI to visualize the performance metrics
2. **Add Alerts**: Set up monitoring for win rate drops or calibration issues
3. **Integrate with Trading Bot**: Use P&L data to adjust position sizing
4. **Backtest Strategies**: Use historical outcomes to validate signal quality

For detailed documentation, see [PERFORMANCE_TRACKING.md](./PERFORMANCE_TRACKING.md)

## Sample Dashboard Code

```typescript
// Example React component
import { useEffect, useState } from 'react';

export function PerformanceDashboard() {
  const [metrics, setMetrics] = useState(null);

  useEffect(() => {
    fetch('/api/metrics/performance')
      .then(res => res.json())
      .then(data => setMetrics(data.data));
  }, []);

  if (!metrics) return <div>Loading...</div>;

  const avgWinRate = Object.values(metrics.win_rate_30d)
    .reduce((a, b) => a + b, 0) / Object.keys(metrics.win_rate_30d).length;

  return (
    <div>
      <h1>Signal Performance</h1>
      <div>
        <h2>30-Day Metrics</h2>
        <p>Average Win Rate: {(avgWinRate * 100).toFixed(1)}%</p>
        <p>Brier Score: {metrics.brier_score_30d.toFixed(3)}</p>
        <p>Total Signals: {metrics.signal_stats.total_generated}</p>
        <p>Pending: {metrics.signal_stats.pending_resolution}</p>
      </div>
      
      <div>
        <h2>Top Signal Types</h2>
        <ul>
          {metrics.top_categories.slice(0, 5).map(cat => (
            <li key={cat.category}>
              {cat.category}: {(cat.win_rate * 100).toFixed(1)}% 
              ({cat.count} signals)
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
```

## Support

For questions or issues:
- Check the [full documentation](./PERFORMANCE_TRACKING.md)
- Review Vercel logs for error details
- Verify Supabase logs for database errors
