/**
 * Embeddings (via server-side proxy) + cosine similarity helpers (Phase 8.5)
 *
 * We always use OpenAI's text-embedding-3-small model for embeddings,
 * regardless of which provider is active for chat completions. The OpenAI key
 * never reaches the browser: the request goes to ggbc-backend's embeddings
 * proxy, which resolves the user's stored secret server-side and calls OpenAI.
 */

import { apiRequest } from '../api/client';

const EMBED_MODEL = 'text-embedding-3-small';
/** API input limit for text-embedding-3-small (8 192 tokens ≈ ~32 000 chars). */
const MAX_INPUT_CHARS = 30_000;

/**
 * Fetch the embedding vector for a piece of text via the backend proxy.
 * Throws if no key is configured (400) or the upstream call fails (502).
 */
export async function getEmbedding(text: string): Promise<number[]> {
  const data = await apiRequest<{ data: { embedding: number[] }[] }>(
    '/api/backends/embeddings/generate',
    {
      method: 'POST',
      body: JSON.stringify({
        model: EMBED_MODEL,
        input: text.slice(0, MAX_INPUT_CHARS),
      }),
    },
  );

  const embedding = data?.data?.[0]?.embedding;
  if (!embedding) throw new Error('Embeddings proxy returned no embedding');
  return embedding;
}

/**
 * Cosine similarity between two equal-length vectors.
 * Returns a value in [−1, 1]; higher → more similar.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
