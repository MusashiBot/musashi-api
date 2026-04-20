# Performance Tracking & Resolution Webhooks

This document describes the performance tracking and resolution system for prediction market signals.

## Overview

The system consists of three components:
1. **Performance Metrics Endpoint** - Real-time analytics on signal accuracy
2. **Market Resolution Webhook** - API to manually resolve markets and update signals
3. **Automated Resolution Collector** - Batch job that automatically fetches resolutions from Polymarket/Kalshi

## 1. Performance Metrics Endpoint

### `GET /api/metrics/performance`

Returns comprehensive performance analytics for all signals.

**Response:**
```json
{
  "success": true,
  "data": {
    "win_rate_24h": {
      "arbitrage": 0.75,
      "mover": 0.62,
      "user_interest": 0.58
    },
    "win_rate_7d": { ... },
    "win_rate_30d": { ... },
    "brier_score_24h": 0.18,
    "brier_score_7d": 0.21,
    "brier_score_30d": 0.24,
    "top_categories": [
      {
        "category": "arbitrage",
        "win_rate": 0.73,
        "count": 45
      }
    ],
    "worst_false_positives": [
      {
        "signal_id": "sig_123",
        "market_id": "mkt_456",
        "platform": "polymarket",
        "signal_type": "arbitrage",
        "confidence": 0.85,
        "predicted_direction": "YES",
        "actual_outcome": "NO",
        "loss_amount": 42.50
      }
    ],
    "signal_stats": {
      "total_generated": 1250,
      "total_resolved": 892,
      "pending_resolution": 358
    },
    "timestamp": "2026-04-18T12:00:00Z"
  }
}
```

**Key Metrics:**

- **Win Rate**: Percentage of correct predictions by signal type and time period
- **Brier Score**: Calibration metric (lower is better, 0 = perfect calibration)
- **Top Categories**: Best performing signal types with minimum 5 samples
- **Worst False Positives**: High-confidence signals that were incorrect
- **Signal Stats**: Overall counts of generated vs resolved signals

**Usage:**
```bash
curl https://your-domain.vercel.app/api/metrics/performance
```

## 2. Market Resolution Webhook

### `POST /api/internal/resolve-market`

Manually resolve a market and update all associated signals with outcomes and P&L.

**Authentication:**
Requires one of the following:
- Header: `X-API-Key: your_internal_api_key`
- Header: `Authorization: Bearer your_internal_api_key`
- Request from internal IP (configure `INTERNAL_IPS` env var)

**Request Body:**
```json
{
  "market_id": "mkt_abc123",
  "platform": "polymarket",
  "outcome": "YES",
  "resolution_date": "2026-04-18T15:30:00Z",
  "bankroll": 1000
}
```

**Parameters:**
- `market_id` (required): The market identifier from Polymarket or Kalshi
- `platform` (required): Either `"polymarket"` or `"kalshi"`
- `outcome` (required): Either `"YES"` or `"NO"`
- `resolution_date` (optional): ISO timestamp, defaults to current time
- `bankroll` (optional): Bankroll size for P&L calculation, defaults to $1000

**Response:**
```json
{
  "success": true,
  "signals_updated": 8,
  "total_pl": -127.50
}
```

**P&L Calculation:**
- Uses Quarter Kelly sizing: `bet_size = |edge| * 0.25 * bankroll`
- Win: `pnl = bet_size * (1 / predicted_prob - 1)`
- Loss: `pnl = -bet_size`

**Usage:**
```bash
curl -X POST https://your-domain.vercel.app/api/internal/resolve-market \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your_internal_key" \
  -d '{
    "market_id": "0x1234...",
    "platform": "polymarket",
    "outcome": "YES"
  }'
```

## 3. Automated Resolution Collector

### Script: `scripts/ml/collect-resolutions.ts`

Batch job that automatically fetches resolved markets from external APIs and updates signal outcomes.

**Features:**
- Fetches markets resolved in the last 7 days
- Queries both Polymarket and Kalshi APIs
- Updates all unresolved signals for each market
- Calculates P&L using Kelly criterion
- Logs all updates and errors

**Manual Execution:**
```bash
# Ensure environment variables are set
export NEXT_PUBLIC_SUPABASE_URL="https://your-project.supabase.co"
export SUPABASE_SERVICE_KEY="your_service_key"

# Run the script
node --import tsx scripts/ml/collect-resolutions.ts
```

**Cron Job Setup (Vercel):**

Add to `vercel.json`:
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

Then create `api/cron/collect-resolutions.ts`:
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
    console.error('[cron] collect-resolutions error:', error);
    res.status(500).json({ 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown error' 
    });
  }
}
```

**Output:**
```
[collect-resolutions] Starting batch job...
[collect-resolutions] Fetching markets resolved since 2026-04-11T12:00:00.000Z
[collect-resolutions] Found 12 Polymarket resolutions
[collect-resolutions] Found 8 Kalshi resolutions
[collect-resolutions] ✓ Updated signal sig_abc for Will Bitcoin reach $100k?
[collect-resolutions] ✓ Updated signal sig_def for Will Trump win 2024?
...
[collect-resolutions] Batch job complete!
  Signals updated: 47
  Errors: 0
```

## Environment Variables

Required:
```bash
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your_service_role_key
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_anon_key
```

Optional (for resolve-market auth):
```bash
INTERNAL_API_KEY=your_secret_key
INTERNAL_IPS=127.0.0.1,10.0.0.0/8
```

## Database Schema

The `signal_outcomes` table structure:

```sql
CREATE TABLE signal_outcomes (
  signal_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  market_id TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('polymarket', 'kalshi')),
  predicted_direction TEXT NOT NULL CHECK (predicted_direction IN ('YES', 'NO', 'HOLD')),
  predicted_prob NUMERIC NOT NULL CHECK (predicted_prob >= 0 AND predicted_prob <= 1),
  confidence NUMERIC NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  edge NUMERIC NOT NULL,
  signal_type TEXT NOT NULL,
  urgency TEXT NOT NULL,
  features JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  resolution_date TIMESTAMPTZ,
  outcome TEXT CHECK (outcome IN ('YES', 'NO')),
  was_correct BOOLEAN,
  pnl NUMERIC
);

CREATE INDEX idx_signal_outcomes_market ON signal_outcomes(market_id, platform);
CREATE INDEX idx_signal_outcomes_created ON signal_outcomes(created_at DESC);
CREATE INDEX idx_signal_outcomes_resolved ON signal_outcomes(outcome) WHERE outcome IS NOT NULL;
```

## Integration Example

### Storing Signals

When generating a new signal, store it in the database:

```typescript
import { createSupabaseBrowserClient, TABLES } from './src/api/supabase-client';

const supabase = createSupabaseBrowserClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

const signal = generateSignal(text, matches, arbitrage, volRegime);

await supabase.from(TABLES.signalOutcomes).insert({
  signal_id: signal.event_id,
  event_id: signal.event_id,
  market_id: signal.matches[0].market.id,
  platform: signal.matches[0].market.platform,
  predicted_direction: signal.suggested_action === 'BUY_YES' ? 'YES' : 
                       signal.suggested_action === 'BUY_NO' ? 'NO' : 'HOLD',
  predicted_prob: signal.matches[0].market.yesPrice,
  confidence: signal.matches[0].confidence,
  edge: signal.arbitrage?.net_spread || 0,
  signal_type: signal.signal_type,
  urgency: signal.urgency,
  features: {
    sentiment: signal.sentiment,
    arbitrage: signal.arbitrage,
    is_near_resolution: signal.is_near_resolution,
  },
});
```

### Dashboard Integration

Create a dashboard to monitor performance:

```typescript
async function loadPerformanceMetrics() {
  const response = await fetch('/api/metrics/performance');
  const { data } = await response.json();
  
  console.log(`Overall Win Rate (30d): ${
    Object.values(data.win_rate_30d).reduce((a, b) => a + b, 0) / 
    Object.keys(data.win_rate_30d).length
  }`);
  
  console.log(`Calibration (Brier): ${data.brier_score_30d.toFixed(3)}`);
  console.log(`Pending Resolutions: ${data.signal_stats.pending_resolution}`);
}
```

## Monitoring & Alerts

### Key Metrics to Monitor

1. **Win Rate Trends**: Alert if 7d win rate drops below 55%
2. **Brier Score**: Alert if > 0.30 (poor calibration)
3. **Pending Resolutions**: Alert if > 500 (backlog building)
4. **False Positive Rate**: Alert if high-confidence losses exceed 20%

### Logs

All endpoints and scripts log to console. View logs in Vercel dashboard or pipe to your monitoring service.

## Troubleshooting

**Q: No signals are being updated by the batch job**
- Check that `signal_outcomes` table has records with `outcome = NULL`
- Verify `market_id` matches exactly what Polymarket/Kalshi returns
- Check API rate limits (Polymarket: 100 req/min, Kalshi: varies)

**Q: P&L calculations seem off**
- Verify `edge` and `predicted_prob` fields are set correctly
- Adjust `bankroll` parameter in resolve-market requests
- Check Kelly fraction (currently 0.25x) is appropriate for your risk tolerance

**Q: Performance endpoint returns 500**
- Ensure Supabase credentials are correct
- Check that `signal_outcomes` table exists and is accessible
- Verify database has data (empty tables return valid responses)

## Future Enhancements

- [ ] Add real-time WebSocket updates for live performance tracking
- [ ] Implement ML model retraining based on outcome data
- [ ] Add Sharpe ratio and max drawdown calculations
- [ ] Support for multi-outcome markets (beyond binary YES/NO)
- [ ] Backtesting framework using historical outcomes
