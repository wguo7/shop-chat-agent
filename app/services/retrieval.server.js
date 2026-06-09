// app/services/retrieval.server.js
// Semantic retrieval over the NextLED manual index (data/manual-index.json).
// The index is statically imported so the Vercel bundler ships it inside the
// function (fs path resolution is unreliable in serverless bundles). Embedding is
// done via Voyage (see voyage.server.js) so the query embedder always matches the
// index embedder. Any failure returns null so the chat flow continues without
// manual context (same graceful degradation as the MCP tools).
import indexData from "../../data/manual-index.json";
import { embedQuery } from "./voyage.server";
import AppConfig from "./config.server";

// Embeddings are unit-normalized at index and query time, so cosine == dot product.
function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/**
 * Retrieve the top manual chunks for a query that clear the similarity floor.
 * @param {string} query
 * @returns {Promise<string|null>} joined chunk texts, or null if nothing relevant / unavailable
 */
export async function getManualContext(query) {
  try {
    const chunks = indexData?.chunks;
    if (!chunks?.length) {
      console.warn("Manual index empty/missing; retrieval disabled.");
      return null;
    }

    let q;
    try {
      q = await embedQuery(query);
    } catch (e) {
      console.warn("Voyage embedder failed, continuing without context:", e.message);
      return null;
    }

    const topK = AppConfig.retrieval?.topK ?? 6;
    const minScore = AppConfig.retrieval?.minScore ?? 0.45;

    const ranked = chunks
      .map((c) => ({ sku: c.sku, section: c.section, text: c.text, score: dot(q, c.embedding) }))
      .sort((a, b) => b.score - a.score);

    // Diagnostics only — does not affect the returned set.
    const label = (r) => `${r.sku ?? r.section}=${r.score.toFixed(3)}`;
    console.log(`[retrieval] q="${query.slice(0, 70)}" top: ${ranked.slice(0, 6).map(label).join("  ")}`);

    const cleared = ranked.filter((r) => r.score >= minScore).slice(0, topK);
    if (!cleared.length) {
      console.log(`[retrieval] nothing cleared minScore=${minScore} -> injecting null`);
      return null;
    }
    console.log(`[retrieval] injecting ${cleared.length} chunk(s) >= ${minScore}: ${cleared.map(label).join("  ")}`);
    return cleared.map((r) => r.text).join("\n\n---\n\n");
  } catch (e) {
    console.warn("Manual retrieval failed, continuing without context:", e.message);
    return null;
  }
}

export default { getManualContext };
