import React, { useState } from 'react';
import { AnalyzeTextResponse, analyzeText } from '../api';

interface TextAnalyzerProps {
  onAnalyze?: (result: AnalyzeTextResponse) => void;
}

export const TextAnalyzer: React.FC<TextAnalyzerProps> = ({ onAnalyze }) => {
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AnalyzeTextResponse | null>(null);

  const handleAnalyze = async () => {
    if (!text.trim()) {
      setError('Please enter some text');
      return;
    }

    try {
      setLoading(true);
      setError(null);
      const response = await analyzeText(text);
      setResult(response);
      onAnalyze?.(response);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to analyze text');
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="card p-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h3>Analyze Text</h3>
        <span className="terminal-panel-kicker">POST</span>
      </div>

      <div className="space-y-3">
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Paste tweet, news, or market claim..."
          className="terminal-input min-h-[112px] resize-y text-[12px] leading-6"
          rows={4}
        />

        <button
          onClick={handleAnalyze}
          disabled={loading}
          className="terminal-button w-full"
        >
          {loading ? '[RUNNING] ANALYZE' : '[ENTER] ANALYZE'}
        </button>

        {error && (
          <div className="terminal-error-message p-3 text-sm">
            {error}
          </div>
        )}

        {result && (
          <div className="border border-[var(--border-primary)] bg-black/30 p-3 text-sm">
            <div className="grid grid-cols-2 gap-x-4 gap-y-2">
              <span className="terminal-muted">Type</span>
              <span className="text-[var(--text-primary)]">{result.signal_type}</span>
              <span className="terminal-muted">Urgency</span>
              <span className={
                result.urgency === 'critical' || result.urgency === 'high'
                  ? 'terminal-warning'
                  : 'terminal-positive'
              }>
                {result.urgency}
              </span>
              <span className="terminal-muted">Matches</span>
              <span className="text-[var(--text-primary)]">{result.data.markets.length}</span>
            </div>
          </div>
        )}
      </div>
    </section>
  );
};
