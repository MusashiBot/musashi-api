// Semantic market matching using transformer embeddings
// Uses @xenova/transformers with Xenova/all-MiniLM-L6-v2 for
// deep semantic similarity beyond keyword overlap.
//
// IMPORTANT: @xenova/transformers must be lazy-loaded via dynamic import().
// A static top-level import pulls in `sharp` (image preprocessing) which
// requires native binaries — that breaks `pnpm test:wallet`, Vercel cold
// starts, and any environment where install scripts were skipped.

import { Market } from '../types/market';

/** Output tensor shape from the feature-extraction pipeline */
interface FeatureExtractionOutput {
  data: Float32Array;
}

type FeatureExtractionPipeline = (
  text: string,
  options: { pooling: 'mean'; normalize: boolean }
) => Promise<FeatureExtractionOutput>;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface EmbeddingResult {
  marketId: string;
  embedding: number[];
}

export interface SemanticMatch {
  market: Market;
  similarity: number;
}

// ─── Model loading and caching ────────────────────────────────────────────────

let embeddingModel: FeatureExtractionPipeline | null = null;
const embeddingCache = new Map<string, number[]>();

/**
 * Load the transformer model (singleton pattern).
 * Model is cached after first load for fast subsequent calls.
 */
async function getEmbeddingModel(): Promise<FeatureExtractionPipeline> {
  if (!embeddingModel) {
    console.log('[SemanticMatcher] Loading Xenova/all-MiniLM-L6-v2 model...');
    const { pipeline } = await import('@xenova/transformers');
    embeddingModel = (await pipeline(
      'feature-extraction',
      'Xenova/all-MiniLM-L6-v2'
    )) as FeatureExtractionPipeline;
    console.log('[SemanticMatcher] Model loaded successfully');
  }
  return embeddingModel;
}

/**
 * Generate embedding for a single text string.
 * Returns a normalized vector suitable for cosine similarity.
 */
async function embedText(text: string): Promise<number[]> {
  const model = await getEmbeddingModel();
  
  // Generate embedding
  const output = await model(text, { pooling: 'mean', normalize: true });
  
  // Extract the actual array from the tensor
  const embedding = Array.from(output.data as Float32Array);
  
  return embedding;
}

/**
 * Compute cosine similarity between two normalized vectors.
 * Since vectors are pre-normalized, this is just the dot product.
 */
function cosineSimilarity(vec1: number[], vec2: number[]): number {
  if (vec1.length !== vec2.length) {
    throw new Error('Vector dimensions must match');
  }
  
  let dotProduct = 0;
  for (let i = 0; i < vec1.length; i++) {
    dotProduct += vec1[i] * vec2[i];
  }
  
  // Clamp to [-1, 1] to handle floating point errors
  return Math.max(-1, Math.min(1, dotProduct));
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Pre-compute and cache embeddings for a list of markets.
 * This should be called once when markets are loaded to avoid
 * recomputing embeddings on every search.
 * 
 * @param markets Array of markets to embed
 * @returns Array of embedding results with market IDs
 */
export async function embedMarkets(markets: Market[]): Promise<EmbeddingResult[]> {
  console.log(`[SemanticMatcher] Embedding ${markets.length} markets...`);
  
  const results: EmbeddingResult[] = [];
  let cached = 0;
  let computed = 0;
  
  for (const market of markets) {
    // Check cache first
    let embedding = embeddingCache.get(market.id);
    
    if (!embedding) {
      // Combine title and description for richer semantic context
      const text = `${market.title} ${market.description}`.trim();
      embedding = await embedText(text);
      embeddingCache.set(market.id, embedding);
      computed++;
    } else {
      cached++;
    }
    
    results.push({
      marketId: market.id,
      embedding,
    });
  }
  
  console.log(
    `[SemanticMatcher] Embeddings ready: ${computed} computed, ${cached} from cache`
  );
  
  return results;
}

/**
 * Find semantically similar markets using cosine similarity of embeddings.
 * 
 * @param query Search text (e.g., a market title)
 * @param markets List of candidate markets
 * @param topK Number of top matches to return
 * @returns Top K matches sorted by similarity (highest first)
 */
export async function findSemanticMatches(
  query: string,
  markets: Market[],
  topK: number = 5
): Promise<SemanticMatch[]> {
  // Embed the query
  const queryEmbedding = await embedText(query);
  
  // Compute similarities for all markets
  const matches: SemanticMatch[] = [];
  
  for (const market of markets) {
    // Get or compute embedding for this market
    let marketEmbedding = embeddingCache.get(market.id);
    
    if (!marketEmbedding) {
      const text = `${market.title} ${market.description}`.trim();
      marketEmbedding = await embedText(text);
      embeddingCache.set(market.id, marketEmbedding);
    }
    
    // Compute cosine similarity
    const similarity = cosineSimilarity(queryEmbedding, marketEmbedding);
    
    matches.push({
      market,
      similarity,
    });
  }
  
  // Sort by similarity (descending) and take top K
  matches.sort((a, b) => b.similarity - a.similarity);
  
  return matches.slice(0, topK);
}

/**
 * Compute semantic similarity between two markets using their cached embeddings.
 * Falls back to computing embeddings if not in cache.
 * 
 * @param market1 First market
 * @param market2 Second market
 * @returns Similarity score between 0 and 1
 */
export async function computeMarketSimilarity(
  market1: Market,
  market2: Market
): Promise<number> {
  // Get or compute embeddings
  let emb1 = embeddingCache.get(market1.id);
  if (!emb1) {
    const text1 = `${market1.title} ${market1.description}`.trim();
    emb1 = await embedText(text1);
    embeddingCache.set(market1.id, emb1);
  }
  
  let emb2 = embeddingCache.get(market2.id);
  if (!emb2) {
    const text2 = `${market2.title} ${market2.description}`.trim();
    emb2 = await embedText(text2);
    embeddingCache.set(market2.id, emb2);
  }
  
  const similarity = cosineSimilarity(emb1, emb2);
  
  // Convert from [-1, 1] to [0, 1] range
  return (similarity + 1) / 2;
}

/**
 * Clear the embedding cache (useful for testing or memory management).
 */
export function clearEmbeddingCache(): void {
  embeddingCache.clear();
  console.log('[SemanticMatcher] Embedding cache cleared');
}

/**
 * Get cache statistics for monitoring.
 */
export function getCacheStats(): { size: number; marketIds: string[] } {
  return {
    size: embeddingCache.size,
    marketIds: Array.from(embeddingCache.keys()),
  };
}
