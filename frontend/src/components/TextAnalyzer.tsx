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
    <div className="card p-4">
      <h3 className="font-semibold mb-4 text-gray-900 dark:text-gray-50">Analyze Text</h3>

      <div className="space-y-3">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Enter a tweet, news snippet, or market claim..."
          className="w-full p-3 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-500"
          rows={4}
        />

        <button
          onClick={handleAnalyze}
          disabled={loading}
          className="w-full py-2 px-4 bg-gray-700 hover:bg-gray-800 disabled:bg-gray-400 dark:bg-gray-600 dark:hover:bg-gray-700 text-white rounded-lg font-medium transition"
        >
          {loading ? 'Analyzing...' : 'Analyze'}
        </button>

        {error && (
          <div className="p-3 bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-200 rounded-lg text-sm">
            {error}
          </div>
        )}

        {result && (
          <div className="p-3 bg-gray-200 dark:bg-gray-800 rounded-lg text-sm space-y-2">
            <div>
              <span className="text-gray-600 dark:text-gray-400">Type:</span>
              <span className="ml-2 font-medium text-gray-900 dark:text-gray-100">{result.signal_type}</span>
            </div>
            <div>
              <span className="text-gray-600 dark:text-gray-400">Urgency:</span>
              <span className={`ml-2 font-medium ${
                result.urgency === 'critical' ? 'text-red-600 dark:text-red-500' :
                result.urgency === 'high' ? 'text-yellow-600 dark:text-yellow-500' :
                'text-green-600 dark:text-green-500'
              }`}>
                {result.urgency}
              </span>
            </div>
            <div>
              <span className="text-gray-600 dark:text-gray-400">Matches:</span>
              <span className="ml-2 font-medium text-gray-900 dark:text-gray-100">{result.data.markets.length}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
