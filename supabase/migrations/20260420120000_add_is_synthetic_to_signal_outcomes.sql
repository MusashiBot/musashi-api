-- Add provenance marker for synthetic training rows.
-- Needed so analytics and real-model training can exclude fabricated outcomes.

ALTER TABLE signal_outcomes
  ADD COLUMN IF NOT EXISTS is_synthetic BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_signal_outcomes_synthetic
  ON signal_outcomes(is_synthetic);
