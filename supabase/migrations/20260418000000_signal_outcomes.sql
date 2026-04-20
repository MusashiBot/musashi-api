-- Signal Outcomes Table for ML Model Training
-- Tracks every trading signal generated and its real-world outcome
-- for model training and performance evaluation.

CREATE TABLE IF NOT EXISTS signal_outcomes (
  signal_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id TEXT NOT NULL,
  market_id TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('polymarket', 'kalshi')),
  
  -- Signal prediction details
  predicted_direction TEXT NOT NULL CHECK (predicted_direction IN ('YES', 'NO', 'HOLD')),
  predicted_prob FLOAT NOT NULL CHECK (predicted_prob >= 0 AND predicted_prob <= 1),
  confidence FLOAT NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  edge FLOAT NOT NULL,
  signal_type TEXT NOT NULL,
  urgency TEXT NOT NULL,
  
  -- ML training features (all features used to generate signal)
  features JSONB NOT NULL,
  
  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  resolution_date TIMESTAMP WITH TIME ZONE,
  
  -- Outcome tracking
  outcome TEXT CHECK (outcome IN ('YES', 'NO')),
  was_correct BOOLEAN,
  pnl FLOAT
);

-- ─── Indexes for fast queries ────────────────────────────────────────────────

-- Primary lookup indexes
CREATE INDEX idx_signal_outcomes_event_id ON signal_outcomes(event_id);
CREATE INDEX idx_signal_outcomes_market_id ON signal_outcomes(market_id);
CREATE INDEX idx_signal_outcomes_platform ON signal_outcomes(platform);

-- ML training query optimization
CREATE INDEX idx_signal_outcomes_created_at ON signal_outcomes(created_at DESC);
CREATE INDEX idx_signal_outcomes_signal_type ON signal_outcomes(signal_type);
CREATE INDEX idx_signal_outcomes_platform_signal_type ON signal_outcomes(platform, signal_type);

-- Performance analytics
CREATE INDEX idx_signal_outcomes_resolution ON signal_outcomes(resolution_date) 
  WHERE resolution_date IS NOT NULL;
CREATE INDEX idx_signal_outcomes_unresolved ON signal_outcomes(created_at) 
  WHERE resolution_date IS NULL;
CREATE INDEX idx_signal_outcomes_correctness ON signal_outcomes(was_correct) 
  WHERE was_correct IS NOT NULL;

-- JSONB feature lookups (GIN index for flexible feature queries)
CREATE INDEX idx_signal_outcomes_features ON signal_outcomes USING GIN (features);

-- ─── Comments ─────────────────────────────────────────────────────────────────

COMMENT ON TABLE signal_outcomes IS 
  'Tracks trading signals and outcomes for ML model training and performance evaluation';

COMMENT ON COLUMN signal_outcomes.features IS 
  'JSON object containing all features used to generate this signal (sentiment, market stats, urgency factors, etc.)';

COMMENT ON COLUMN signal_outcomes.predicted_prob IS 
  'Model-implied probability (0-1) that outcome will be YES';

COMMENT ON COLUMN signal_outcomes.edge IS 
  'Expected profit edge calculated by the signal generator';

COMMENT ON COLUMN signal_outcomes.was_correct IS 
  'True if predicted_direction matched actual outcome, False otherwise, NULL if not yet resolved';

COMMENT ON COLUMN signal_outcomes.pnl IS 
  'Profit and loss if trade was executed at recommended position size (NULL if not resolved)';
