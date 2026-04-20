# Semantic Market Matching

This module provides semantic similarity matching for prediction markets using transformer-based embeddings. It enables deep semantic understanding beyond simple keyword matching, helping to identify markets about the same event across different platforms (Polymarket and Kalshi).

## Features

- **Transformer-based embeddings**: Uses `Xenova/all-MiniLM-L6-v2` model via `@xenova/transformers`
- **Efficient caching**: Embeddings are cached in memory to avoid recomputation
- **Cosine similarity**: Fast comparison of normalized embedding vectors
- **Batch processing**: Pre-compute embeddings for all markets at once
- **Graceful fallback**: Integrates with text-based matching as a fallback

## Architecture

### Model Selection

We use `Xenova/all-MiniLM-L6-v2` because:
- **Lightweight**: 384-dimensional embeddings (vs 768+ for larger models)
- **Fast**: ~100ms per embedding on CPU
- **Semantic**: Captures meaning beyond keywords (e.g., "Fed" ≈ "FOMC", "rate cut" ≈ "reduction")
- **Browser-compatible**: Can run in Node.js via ONNX Runtime

### Similarity Thresholds

Based on empirical testing with prediction markets:

| Similarity | Confidence | Action |
|-----------|-----------|--------|
| ≥ 0.75 | High | Accept as same event |
| 0.65-0.74 | Moderate | Validate with keyword overlap |
| < 0.65 | Low | Fall back to text-based matching |

### Cache Strategy

Embeddings are cached by market ID in a `Map<string, number[]>`:
- **Key**: Market ID (unique across platforms)
- **Value**: 384-dimensional embedding vector
- **Lifetime**: In-memory (cleared on process restart)
- **Size**: ~1.5KB per market (384 floats × 4 bytes)

For 2000 markets: ~3MB memory usage

## API Reference

### `embedMarkets(markets: Market[]): Promise<EmbeddingResult[]>`

Pre-compute and cache embeddings for a list of markets. Call this once when markets are loaded.

```typescript
import { embedMarkets } from './semantic-matcher';
import { getMarkets } from '../api/market-cache';

const markets = await getMarkets();
await embedMarkets(markets);
```

**Returns**: Array of `{ marketId: string; embedding: number[] }`

### `findSemanticMatches(query: string, markets: Market[], topK: number): Promise<SemanticMatch[]>`

Find top K semantically similar markets to a query string.

```typescript
import { findSemanticMatches } from './semantic-matcher';

const matches = await findSemanticMatches(
  'Federal Reserve interest rate decision',
  markets,
  5
);

matches.forEach(match => {
  console.log(`${match.market.title}: ${match.similarity * 100}%`);
});
```

**Parameters**:
- `query`: Search text (e.g., market title or description)
- `markets`: List of candidate markets
- `topK`: Number of top matches to return

**Returns**: Array of `{ market: Market; similarity: number }` sorted by similarity (descending)

### `computeMarketSimilarity(market1: Market, market2: Market): Promise<number>`

Compute semantic similarity between two markets using cached embeddings.

```typescript
import { computeMarketSimilarity } from './semantic-matcher';

const sim = await computeMarketSimilarity(polyMarket, kalshiMarket);

if (sim >= 0.75) {
  console.log('High confidence match - likely same event');
}
```

**Returns**: Similarity score between 0 and 1

### `clearEmbeddingCache(): void`

Clear the embedding cache (useful for testing or memory management).

```typescript
import { clearEmbeddingCache } from './semantic-matcher';

clearEmbeddingCache();
```

### `getCacheStats(): { size: number; marketIds: string[] }`

Get cache statistics for monitoring.

```typescript
import { getCacheStats } from './semantic-matcher';

const stats = getCacheStats();
console.log(`${stats.size} markets cached`);
```

## Integration with Arbitrage Detection

The semantic matcher is integrated into `arbitrage-detector.ts`:

1. **Primary signal**: Semantic similarity (≥ 0.75 threshold)
2. **Moderate confidence**: Semantic + keyword validation (≥ 0.65)
3. **Fallback**: Text-based similarity (original implementation)
4. **Guard**: Directional opposition detection (prevents false positives)

```typescript
// In arbitrage-detector.ts
async function areMarketsSimilar(poly: Market, kalshi: Market) {
  // Try semantic matching first
  try {
    const semanticSim = await computeMarketSimilarity(poly, kalshi);
    
    if (semanticSim >= 0.75) {
      return {
        isSimilar: true,
        confidence: semanticSim,
        reason: `Semantic embedding similarity ${(semanticSim * 100).toFixed(0)}%`,
      };
    }
  } catch (err) {
    // Fall back to text-based methods
  }
  
  // ... text-based fallbacks ...
}
```

## Performance Considerations

### Model Loading

The model is loaded once on first use (singleton pattern):
- **Cold start**: ~2-3 seconds (downloads ~23MB ONNX model)
- **Warm start**: ~100ms (loaded from disk cache)

Model files are cached in `~/.cache/transformers/` by default.

### Embedding Generation

- **Single embedding**: ~100-150ms on CPU
- **Batch of 100 markets**: ~10-15 seconds
- **Cached lookup**: <1ms

### Memory Usage

- **Model**: ~60MB in memory
- **Embeddings**: ~1.5KB per market
- **2000 markets**: ~60MB + 3MB = ~63MB total

## Example Usage

See `semantic-matcher-example.ts` for complete examples:

```bash
npm run dev -- src/analysis/semantic-matcher-example.ts
```

Or run specific examples:

```typescript
import {
  example1_PreComputeEmbeddings,
  example2_FindSimilarMarkets,
  example3_PairwiseSimilarity,
  example4_ArbitrageWorkflow,
} from './semantic-matcher-example';

await example1_PreComputeEmbeddings();
```

## Debugging

Enable verbose logging:

```typescript
// The model logs to console automatically
// Check for these messages:
// [SemanticMatcher] Loading Xenova/all-MiniLM-L6-v2 model...
// [SemanticMatcher] Model loaded successfully
// [SemanticMatcher] Embedding 100 markets...
// [SemanticMatcher] Embeddings ready: 50 computed, 50 from cache
```

## Testing

```bash
# Run typecheck
npm run typecheck

# Test semantic matcher in isolation
node --import tsx src/analysis/semantic-matcher-example.ts

# Test integrated arbitrage detection
npm run test:agent
```

## Future Improvements

1. **Batch embeddings**: Process multiple texts in a single model call
2. **GPU acceleration**: Use CUDA for 10x faster embeddings
3. **Embedding persistence**: Save embeddings to disk/database
4. **Fine-tuning**: Train on prediction market data for better accuracy
5. **Dimension reduction**: Use PCA to reduce 384 → 128 dims for faster search

## Related Files

- `src/analysis/semantic-matcher.ts` - Core implementation
- `src/analysis/semantic-matcher-example.ts` - Usage examples
- `src/api/arbitrage-detector.ts` - Integration with arbitrage detection
- `src/types/market.ts` - Market type definitions
- `api/lib/market-cache.ts` - Market caching layer
