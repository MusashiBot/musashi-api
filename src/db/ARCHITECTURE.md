# Signal Outcome Tracking Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                          SIGNAL FLOW                                 │
└─────────────────────────────────────────────────────────────────────┘

1. User Input (Tweet/News)
   │
   ▼
2. Keyword Matcher
   │ (matches markets)
   ▼
3. Signal Generator
   │ • Analyzes sentiment
   │ • Calculates edge
   │ • Generates action
   │ • Determines urgency
   │
   ├──────────────────────┐
   │                      │
   ▼                      ▼
4. API Response      5. Background Logger
   (immediate)           (async, non-blocking)
                         │
                         ▼
                    6. Supabase DB
                         │ signal_outcomes table
                         │
                         ▼
                    7. ML Training Dataset


┌─────────────────────────────────────────────────────────────────────┐
│                       DATABASE SCHEMA                                │
└─────────────────────────────────────────────────────────────────────┘

signal_outcomes
├── signal_id (PK)                  ← UUID primary key
├── event_id                        ← Links to trading event
├── market_id                       ← Links to prediction market
├── platform                        ← 'polymarket' | 'kalshi'
│
├── PREDICTION DATA
│   ├── predicted_direction         ← 'YES' | 'NO' | 'HOLD'
│   ├── predicted_prob              ← 0.0 to 1.0
│   ├── confidence                  ← 0.0 to 1.0
│   ├── edge                        ← Expected profit edge
│   ├── signal_type                 ← Type of signal
│   └── urgency                     ← Urgency level
│
├── FEATURES (JSONB)                ← All ML training features
│   ├── sentiment features
│   ├── market features
│   ├── match features
│   ├── arbitrage features
│   └── position sizing
│
├── TIMESTAMPS
│   ├── created_at                  ← When signal was generated
│   └── resolution_date             ← When market resolved
│
└── OUTCOME DATA
    ├── outcome                     ← Actual result ('YES' | 'NO')
    ├── was_correct                 ← Prediction accuracy
    └── pnl                         ← Profit/loss


┌─────────────────────────────────────────────────────────────────────┐
│                          DATA FLOW                                   │
└─────────────────────────────────────────────────────────────────────┘

Generation Phase:
─────────────────
generateSignal()
    ↓
logSignal() (async)
    ↓
INSERT INTO signal_outcomes
    (predicted_direction, features, etc.)


Resolution Phase:
─────────────────
Market Resolves
    ↓
Resolution Monitor
    ↓
updateResolution(signalId, outcome, wasCorrect, pnl)
    ↓
UPDATE signal_outcomes
    SET outcome = 'YES', was_correct = true, pnl = 0.15


Analytics Phase:
────────────────
getRecentPerformance(30)
    ↓
SELECT + Aggregate
    ↓
Performance Metrics
    ├── Win Rate: 67.3%
    ├── Brier Score: 0.142
    ├── Total PnL: $1,234.56
    └── Breakdowns by type/platform


┌─────────────────────────────────────────────────────────────────────┐
│                      INDEX STRATEGY                                  │
└─────────────────────────────────────────────────────────────────────┘

Fast Lookups:
─────────────
idx_signal_outcomes_event_id        ← Find signals by event
idx_signal_outcomes_market_id       ← Find signals by market
idx_signal_outcomes_platform        ← Filter by platform

ML Training Queries:
────────────────────
idx_signal_outcomes_created_at      ← Time-based windowing
idx_signal_outcomes_signal_type     ← Filter by signal type
idx_platform_signal_type            ← Combined filter

Resolution Monitoring:
──────────────────────
idx_signal_outcomes_resolution      ← Find resolved signals
idx_signal_outcomes_unresolved      ← Find pending (partial)

Performance Analytics:
──────────────────────
idx_signal_outcomes_correctness     ← Win rate calculation
idx_signal_outcomes_features (GIN)  ← Feature queries


┌─────────────────────────────────────────────────────────────────────┐
│                      API FUNCTIONS                                   │
└─────────────────────────────────────────────────────────────────────┘

logSignal(signal, additionalFeatures?)
├── Input: TradingSignal + optional features
├── Extracts: 20+ features from signal
├── Returns: signal_id | null
└── Use: Automatic (called by generateSignal)

updateResolution(signalId, outcome, wasCorrect, pnl?)
├── Input: signal_id + resolution data
├── Updates: outcome, was_correct, pnl, resolution_date
├── Returns: boolean (success)
└── Use: Manual (call from resolution monitor)

getUnresolvedSignals()
├── Input: None
├── Query: WHERE resolution_date IS NULL
├── Returns: SignalOutcome[]
└── Use: Build resolution monitor

getRecentPerformance(days = 30)
├── Input: Time window in days
├── Calculates: Win rate, Brier, PnL, breakdowns
├── Returns: PerformanceMetrics | null
└── Use: Dashboard, model evaluation


┌─────────────────────────────────────────────────────────────────────┐
│                      FEATURE EXTRACTION                              │
└─────────────────────────────────────────────────────────────────────┘

From Signal:
────────────
✓ sentiment, sentiment_confidence, sentiment_keywords
✓ yes_price, no_price, volume_24h, category
✓ one_day_price_change, is_anomalous
✓ match_confidence, matched_keywords, num_matches
✓ valid_until_seconds, is_near_resolution
✓ processing_time_ms, tweet_text

Arbitrage (if present):
───────────────────────
✓ has_arbitrage, arbitrage_spread
✓ arbitrage_net_spread, arbitrage_profit_potential

Position Sizing:
────────────────
✓ kelly_fraction, kelly_full
✓ risk_level, vol_regime


┌─────────────────────────────────────────────────────────────────────┐
│                     PERFORMANCE METRICS                              │
└─────────────────────────────────────────────────────────────────────┘

Core Metrics:
─────────────
• Win Rate        → % predictions correct
• Brier Score     → Calibration (0 = perfect)
• Total PnL       → Sum of all profits/losses
• Avg PnL         → Mean per resolved signal

Breakdowns:
───────────
• By Signal Type  → arbitrage, news_event, sentiment_shift, user_interest
• By Platform     → polymarket, kalshi

Counts:
───────
• Total Signals    → All generated
• Resolved         → Markets that resolved
• Unresolved       → Awaiting outcome


┌─────────────────────────────────────────────────────────────────────┐
│                       ML TRAINING WORKFLOW                           │
└─────────────────────────────────────────────────────────────────────┘

Step 1: Data Collection (1-2 weeks)
────────────────────────────────────
→ Generate signals automatically
→ Run resolution monitor to update outcomes
→ Target: 500+ resolved signals

Step 2: Feature Engineering
────────────────────────────
→ Extract features from JSONB column
→ Add derived features (time-to-resolution, momentum)
→ Test feature importance

Step 3: Model Training
──────────────────────
→ Split data by time (avoid look-ahead bias)
→ Train classifier: P(correct) given features
→ Optimize for Brier score (calibration)
→ Cross-validate by platform/signal_type

Step 4: Production
───────────────────
→ Replace rule-based calculateEdge() with ML model
→ Keep logging to improve model over time
→ A/B test ML vs. rule-based
→ Monitor calibration drift


┌─────────────────────────────────────────────────────────────────────┐
│                     ERROR HANDLING                                   │
└─────────────────────────────────────────────────────────────────────┘

Graceful Degradation:
─────────────────────
✓ Missing Supabase credentials → Log error, return null
✓ Database connection failure  → Log error, don't throw
✓ Invalid signal data          → Skip logging, don't block API
✓ Server-side only            → Check typeof window === 'undefined'

Non-Blocking Pattern:
─────────────────────
generateSignal() {
  const signal = { ... };
  
  // Fire and forget (async)
  logSignal(signal).catch(console.error);
  
  // Return immediately
  return signal;
}

Result: API response time unaffected by database latency
