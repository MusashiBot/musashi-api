# Musashi API Reference

**Base URL**: `https://musashi-api.vercel.app`

Musashi provides a REST API for AI agents and trading bots to analyze text, detect arbitrage opportunities, and track market movers across Polymarket and Kalshi prediction markets.

---

## Endpoints

### 1. POST /api/analyze-text

Analyze text (tweet, news article, etc.) and return matching prediction markets with trading signals.

**Request:**
```json
POST /api/analyze-text
Content-Type: application/json

{
  "text": "Bitcoin just hit $100k!",
  "minConfidence": 0.3,    // optional, default: 0.3
  "maxResults": 5          // optional, default: 5
}
```

**Response:**
```json
{
  "event_id": "evt_abc123_xyz",
  "signal_type": "news_event",        // arbitrage | news_event | sentiment_shift | user_interest
  "urgency": "high",                   // low | medium | high | critical
  "success": true,
  "data": {
    "markets": [
      {
        "market": {
          "id": "polymarket-0x123...",
          "platform": "polymarket",
          "title": "Will Bitcoin reach $100k by March 2026?",
          "yesPrice": 0.67,
          "noPrice": 0.33,
          "volume24h": 250000,
          "url": "https://polymarket.com/event/bitcoin-100k",
          "category": "crypto"
        },
        "confidence": 0.85,
        "matchedKeywords": ["bitcoin", "100k"]
      }
    ],
    "matchCount": 1,
    "timestamp": "2026-03-01T12:00:00.000Z",
    "suggested_action": {
      "direction": "YES",              // YES | NO | HOLD
      "confidence": 0.75,
      "edge": 0.12,
      "reasoning": "Bullish sentiment (85% confidence) suggests YES is underpriced at 67%"
    },
    "sentiment": {
      "sentiment": "bullish",          // bullish | bearish | neutral
      "confidence": 0.85
    },
    "arbitrage": null,                 // or ArbitrageOpportunity if detected
    "metadata": {
      "processing_time_ms": 124,
      "sources_checked": 2,
      "markets_analyzed": 1234,
      "model_version": "v2.0.0",
      // Stage 0: Freshness tracking (added March 2026)
      "data_age_seconds": 18,              // How old the cached data is
      "fetched_at": "2026-03-01T11:59:42.000Z",  // When data was fetched
      "sources": {
        "polymarket": {
          "available": true,
          "last_successful_fetch": "2026-03-01T11:59:42.000Z",
          "market_count": 1200
        },
        "kalshi": {
          "available": true,
          "last_successful_fetch": "2026-03-01T11:59:42.000Z",
          "market_count": 500
        }
      }
    }
  }
}
```

**Signal Types:**
- `arbitrage`: Cross-platform price discrepancy detected
- `news_event`: Breaking news with market impact
- `sentiment_shift`: Sentiment strongly disagrees with current price
- `user_interest`: General match without strong signal

**Urgency Levels:**
- `critical`: Strong edge (>15%) + high volume + expires soon OR arbitrage >5%
- `high`: Good edge (>10%) OR moderate arbitrage (>3%)
- `medium`: Decent edge (>5%)
- `low`: Match without clear edge

---

### 2. GET /api/markets/arbitrage

Get cross-platform arbitrage opportunities between Polymarket and Kalshi.

**Request:**
```
GET /api/markets/arbitrage?mode=fast&minNetEdgeBps=50&maxDataAgeMs=5000&minConfidence=0.5&limit=20&category=crypto
```

**Query Parameters:**
- `mode` (optional): `fast | full` (default: `fast`)
- `minNetEdgeBps` (optional): Minimum net executable edge in bps (default derived from `minSpread`)
- `maxDataAgeMs` (optional): Freshness budget; stale data returns degraded empty payload
- `minSpread` (optional): Legacy fallback threshold (mapped to bps for backward compatibility)
- `minConfidence` (optional): Minimum match confidence (default: 0.5 = 50%)
- `limit` (optional): Max results (default: 20, max: 100)
- `category` (optional): Filter by category (crypto, us_politics, economics, etc.)

**Response (`mode=full`):**
```json
{
  "success": true,
  "data": {
    "opportunities": [
      {
        "polymarket": { "...": "full market object" },
        "kalshi": { "...": "full market object" },
        "buyVenue": "polymarket",
        "sellVenue": "kalshi",
        "buyPrice": 0.62,
        "sellPrice": 0.69,
        "grossEdgeBps": 1129,
        "estimatedFeesBps": 40,
        "slippageBps": 10,
        "latencyRiskBps": 5,
        "netEdgeBps": 1074,
        "matchConfidence": {
          "score": 0.84,
          "titleSimilarity": 0.78,
          "keywordOverlap": 4,
          "categoryAligned": true,
          "expiryAligned": true
        },
        "expiryDeltaMinutes": 45,
        "liquidityScore": 0.92,
        "sourceTimestamps": {
          "polymarket": "2026-03-01T11:59:42.000Z",
          "kalshi": "2026-03-01T11:59:41.000Z"
        },
        "asOfTs": "2026-03-01T12:00:00.000Z",
        // Backward-compatible fields during migration window:
        "spread": 0.07,
        "profitPotential": 0.07,
        "direction": "buy_poly_sell_kalshi",
        "confidence": 0.84,
        "matchReason": "High title similarity (78%)"
      }
    ],
    "count": 5,
    "timestamp": "2026-03-01T12:00:00.000Z",
    "filters": {
      "mode": "full",
      "minSpread": 0.03,
      "minNetEdgeBps": 300,
      "maxDataAgeMs": 5000,
      "minConfidence": 0.5,
      "limit": 20,
      "category": "crypto"
    }
  },
  "metadata": {
    "processing_time_ms": 89,
    "data_age_seconds": 18,
    "fetched_at": "2026-03-01T11:59:42.000Z",
    "mode": "full",
    "sources": {
      "polymarket": { "available": true, "market_count": 1200 },
      "kalshi": { "available": true, "market_count": 500 }
    }
  }
}
```

**Response (`mode=fast`):**
```json
{
  "success": true,
  "data": {
    "opportunities": [
      {
        "buyVenue": "polymarket",
        "sellVenue": "kalshi",
        "buyPrice": 0.62,
        "sellPrice": 0.69,
        "netEdgeBps": 1074,
        "estimatedFeesBps": 40,
        "slippageBps": 10,
        "latencyRiskBps": 5,
        "matchConfidence": 0.84,
        "expiryDeltaMinutes": 45,
        "liquidityScore": 0.92,
        "sourceTimestamps": {
          "polymarket": "2026-03-01T11:59:42.000Z",
          "kalshi": "2026-03-01T11:59:41.000Z"
        },
        "asOfTs": "2026-03-01T12:00:00.000Z"
      }
    ],
    "count": 1
  },
  "metadata": {
    "mode": "fast"
  }
}
```

---

### 3. GET /api/markets/movers

Get markets with significant price changes.

**Request:**
```
GET /api/markets/movers?minChange=0.05&limit=20&category=us_politics
```

**Query Parameters:**
- `minChange` (optional): Minimum price change (default: 0.05 = 5%)
- `limit` (optional): Max results (default: 20, max: 100)
- `category` (optional): Filter by category

**Response:**
```json
{
  "success": true,
  "data": {
    "movers": [
      {
        "market": {
          "id": "polymarket-0x456...",
          "title": "Will Trump win 2024 election?",
          "yesPrice": 0.72,
          "volume24h": 5000000,
          ...
        },
        "priceChange1h": 0.08,         // +8% in last hour
        "priceChange24h": 0.12,        // +12% in last 24h (if available)
        "previousPrice": 0.64,
        "currentPrice": 0.72,
        "direction": "up",             // up | down
        "timestamp": 1709294400000
      }
    ],
    "count": 12,
    "timestamp": "2026-03-01T12:00:00.000Z",
    "filters": {
      "minChange": 0.05,
      "limit": 20,
      "category": "us_politics"
    },
    "metadata": {
      "processing_time_ms": 45,
      "markets_analyzed": 1234,
      "markets_tracked": 1200,
      "storage": "Vercel KV (Redis)",
      "history_retention": "7 days",
      // Stage 0: Freshness tracking (added March 2026)
      "data_age_seconds": 18,
      "fetched_at": "2026-03-01T11:59:42.000Z",
      "sources": {
        "polymarket": {
          "available": true,
          "last_successful_fetch": "2026-03-01T11:59:42.000Z",
          "market_count": 1200
        },
        "kalshi": {
          "available": true,
          "last_successful_fetch": "2026-03-01T11:59:42.000Z",
          "market_count": 500
        }
      }
    }
  }
}
```

**Storage**: The API uses Vercel KV (Redis) to persist price snapshots across serverless invocations. Snapshots are stored for 7 days with automatic TTL expiration. See [VERCEL_KV_SETUP.md](./VERCEL_KV_SETUP.md) for setup instructions.

---

### 4. GET /api/health

Check API health and service status.

**Request:**
```
GET /api/health
```

**Response:**
```json
{
  "status": "healthy",               // healthy | degraded | down
  "timestamp": "2026-03-01T12:00:00.000Z",
  "uptime_ms": 123456,
  "response_time_ms": 45,
  "version": "2.0.0",
  "services": {
    "polymarket": {
      "status": "healthy",
      "markets": 734
    },
    "kalshi": {
      "status": "healthy",
      "markets": 500
    }
  },
  "endpoints": {
    "/api/analyze-text": {
      "method": "POST",
      "description": "Analyze text and return matching markets with trading signals",
      "status": "healthy"
    },
    "/api/markets/arbitrage": {
      "method": "GET",
      "description": "Get cross-platform arbitrage opportunities",
      "status": "healthy"
    },
    "/api/markets/movers": {
      "method": "GET",
      "description": "Get markets with significant price changes",
      "status": "healthy"
    },
    "/api/health": {
      "method": "GET",
      "description": "API health check",
      "status": "healthy"
    }
  },
  "limits": {
    "max_markets_per_request": 5,
    "cache_ttl_seconds": 300,
    "rate_limit": "none (currently)"
  }
}
```

---

## Data Freshness & Graceful Degradation

**Stage 0 Improvements (March 2026)**: All API endpoints now include freshness metadata and handle partial source failures gracefully.

### Freshness Metadata

Every response includes these fields in `metadata`:

```json
{
  "data_age_seconds": 18,              // How many seconds old the cached data is
  "fetched_at": "2026-03-01T11:59:42Z", // ISO timestamp when data was fetched
  "sources": {
    "polymarket": {
      "available": true,                // Is this source healthy?
      "last_successful_fetch": "2026-03-01T11:59:42Z",
      "market_count": 1200              // Markets from this source
    },
    "kalshi": {
      "available": true,
      "last_successful_fetch": "2026-03-01T11:59:42Z",
      "market_count": 500
    }
  }
}
```

**What this means for your bot:**
- Check `data_age_seconds` to know how stale the data is (typically 0-20 seconds)
- If `data_age_seconds > 30`, data may be stale due to high load
- Use `sources.*.available` to know which platforms are currently healthy
- If one source is unavailable, you still get data from the other source

### Graceful Degradation

**The API never fails completely.** If one data source is down, you still get data from the other:

**Example: Kalshi rate-limited**
```json
{
  "success": true,  // ← Still returns success!
  "data": {
    "markets": [...],  // ← Only Polymarket markets
    "metadata": {
      "markets_analyzed": 1200,  // ← Reduced count
      "sources": {
        "polymarket": {
          "available": true,
          "market_count": 1200
        },
        "kalshi": {
          "available": false,  // ← Source down
          "last_successful_fetch": null,
          "error": "Kalshi API responded with 429",  // ← Error details
          "market_count": 0
        }
      }
    }
  }
}
```

**Benefits:**
- **HTTP 200 (not 500)**: Your bot won't crash on partial failures
- **Partial data**: Better to have some data than no data
- **Error transparency**: You know exactly which source failed and why
- **Auto-recovery**: When the source comes back, it's automatically included

**Timeout behavior:**
- Each source has a **5-second timeout**
- If Polymarket hangs, Kalshi data comes through in 5s
- If Kalshi hangs, Polymarket data comes through in 5s
- Total request time never exceeds ~5 seconds per source

### Cache Strategy

**Default TTLs:**
- Markets: **20 seconds** (shared across endpoints)
- Arbitrage: **15 seconds** (highly volatile)
- Movers: Price snapshots stored in Redis for **7 days**

**For bot developers:**

```python
# Check data freshness
response = requests.post('https://musashi-api.vercel.app/api/analyze-text', json={'text': '...'})
metadata = response.json()['data']['metadata']

if metadata['data_age_seconds'] > 30:
    print("Warning: Data may be stale")

# Check source health
if not metadata['sources']['polymarket']['available']:
    print("Polymarket is down:", metadata['sources']['polymarket'].get('error'))

# Still trade on available data
if metadata['sources']['kalshi']['available']:
    print(f"Trading on {metadata['sources']['kalshi']['market_count']} Kalshi markets")
```

---

## Example Usage

### Python

```python
import requests

# Analyze text
response = requests.post(
    'https://musashi-api.vercel.app/api/analyze-text',
    json={'text': 'Bitcoin mooning! $100k inevitable!'}
)
signal = response.json()

if signal['urgency'] in ['high', 'critical']:
    action = signal['data']['suggested_action']
    print(f"TRADE SIGNAL: {action['direction']} with {action['confidence']*100}% confidence")
    print(f"Edge: {action['edge']*100}%")
    print(f"Reasoning: {action['reasoning']}")

# Get arbitrage opportunities
response = requests.get(
    'https://musashi-api.vercel.app/api/markets/arbitrage',
    params={'minSpread': 0.05, 'limit': 10}
)
arb = response.json()

for opportunity in arb['data']['opportunities']:
    print(f"Arbitrage: {opportunity['spread']*100}% spread")
    print(f"  Buy on {opportunity['direction'].split('_')[1]}")
    print(f"  Profit potential: {opportunity['profitPotential']*100}%")
```

### JavaScript

```javascript
// Analyze text
const response = await fetch(
  'https://musashi-api.vercel.app/api/analyze-text',
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: 'Fed announces rate cut!'
    })
  }
);

const signal = await response.json();

if (signal.urgency === 'critical') {
  console.log('CRITICAL SIGNAL:', signal.signal_type);
  console.log('Action:', signal.data.suggested_action);
}

// Get movers
const moversRes = await fetch(
  'https://musashi-api.vercel.app/api/markets/movers?minChange=0.05&limit=10'
);

const movers = await moversRes.json();
movers.data.movers.forEach(mover => {
  console.log(`${mover.market.title}: ${mover.direction === 'up' ? '↑' : '↓'} ${mover.priceChange1h * 100}%`);
});
```

---

## Rate Limits

Currently: **No rate limits** (subject to change)

Future plans:
- Free tier: 100 requests/hour
- Pro tier: 1000 requests/hour

---

## Error Responses

All endpoints return errors in this format:

```json
{
  "success": false,
  "error": "Error message here",
  "event_id": "evt_error",
  "signal_type": "user_interest",
  "urgency": "low"
}
```

**Common HTTP Status Codes:**
- `200`: Success (includes partial success with one source down)
- `400`: Bad request (invalid parameters)
- `405`: Method not allowed
- `500`: Internal server error (only if both sources fail catastrophically)
- `503`: Service unavailable (only if no cached data available)

**Stage 0 Note**: With graceful degradation, you'll almost always get HTTP 200. Check `sources.*.available` in metadata to see which platforms are healthy. Even if one source is down, you still get data from the other with `success: true`.

---

## Categories

Supported market categories:
- `crypto` - Cryptocurrency markets
- `us_politics` - US political events
- `economics` - Economic indicators, Fed policy
- `technology` - Tech companies, AI, innovation
- `sports` - Sports events, championships
- `geopolitics` - International conflicts, diplomacy
- `climate` - Climate change, weather events
- `other` - Uncategorized markets

---

## Caching & Storage

**Cache TTLs (Stage 0 optimized for trading):**
- **Markets**: **20 seconds** in-memory (shared across endpoints)
- **Arbitrage**: **15 seconds** (highly volatile, needs fresh data)
- **Movers**: Price snapshots stored in **Vercel KV (Redis)** for **7 days**

> **Stage 0 Update (March 2026)**: All responses now include `data_age_seconds` and per-source freshness metadata. Cache TTLs were reduced from 5 minutes to 15-20 seconds for trading-grade freshness.

**How freshness tracking works:**
1. When markets are fetched from Polymarket/Kalshi, timestamp is recorded
2. `data_age_seconds` = current time - oldest fetch timestamp
3. Cache hits return data with original `fetched_at` timestamp
4. Bots can check freshness and decide whether to wait for cache expiry

**Configurable via environment variables:**
- `MARKET_CACHE_TTL_SECONDS` (default: **20**)
- `ARBITRAGE_CACHE_TTL_SECONDS` (default: **15**)

### Vercel KV Setup

The movers endpoint requires Vercel KV to persist price history across serverless invocations. See [VERCEL_KV_SETUP.md](./VERCEL_KV_SETUP.md) for setup instructions.

**Environment Variables Required**:
- `KV_REST_API_URL` - KV REST API endpoint
- `KV_REST_API_TOKEN` - Authentication token

**Cache Configuration (Optional)**:
- `MARKET_CACHE_TTL_SECONDS` - Market data cache duration (default: **20 seconds**, was 5 minutes)
- `ARBITRAGE_CACHE_TTL_SECONDS` - Arbitrage cache duration (default: **15 seconds**, was 5 minutes)

**Note for Trading Agents**: Cache TTLs have been reduced from 5 minutes to 15-20 seconds by default to provide fresher data for trading decisions. You can adjust these values based on your trading strategy:
- **High-frequency trading**: Set to 10-15 seconds for maximum freshness
- **Cost optimization**: Set to 60-300 seconds to reduce external API calls
- **Production recommended**: Keep at 15-30 seconds for balance

---

## Support

- **GitHub**: https://github.com/VittorioC13/Musashi
- **Issues**: https://github.com/VittorioC13/Musashi/issues
- **Email**: [Create issue on GitHub]

---

**Built with ❤️ by rotciv + Claude Code**
