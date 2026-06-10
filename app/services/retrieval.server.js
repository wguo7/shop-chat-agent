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

// Matches NextLED SKUs like NT-7647, NT-7647-1, NT-2061A-10UV, NT-LS002373.
const SKU_RE = /\bNT-[0-9A-Z]+(?:-[0-9A-Z]+)*\b/gi;

/**
 * Retrieve manual chunks for a query. Combines semantic top-K with SKU-aware
 * force-include: any SKU named in the current message OR recent conversation has
 * all its chunks injected regardless of score. This makes "tell me about NT-7647"
 * return the full product, and lets follow-ups like "what's the battery type"
 * resolve to the product discussed earlier in the chat.
 * @param {string} query - the current user message
 * @param {string} [contextText] - recent conversation text, for SKU detection
 * @returns {Promise<string|null>} joined chunk texts, or null if nothing relevant
 */
export async function getManualContext(query, contextText = "") {
  try {
    const chunks = indexData?.chunks;
    if (!chunks?.length) {
      console.warn("Manual index empty/missing; retrieval disabled.");
      return null;
    }

    const topK = AppConfig.retrieval?.topK ?? 6;
    const minScore = AppConfig.retrieval?.minScore ?? 0.4;
    const maxChunks = AppConfig.retrieval?.maxChunks ?? 14;

    // SKU priority: those named in the CURRENT message first, then recent
    // conversation (most-recent first). Current-message SKUs must not be starved
    // by the maxChunks cap when older SKUs are also present in the history.
    const fromCurrent = [...query.matchAll(SKU_RE)].map((m) => m[0].toUpperCase());
    const fromContext = [...contextText.matchAll(SKU_RE)].map((m) => m[0].toUpperCase()).reverse();
    const orderedSkus = [];
    for (const s of [...fromCurrent, ...fromContext]) {
      if (!orderedSkus.includes(s)) orderedSkus.push(s);
    }

    const selected = [];
    const seen = new Set();
    const take = (c) => {
      if (!seen.has(c.id)) { seen.add(c.id); selected.push(c); }
    };

    // 1) Force-include chunks for named SKUs, in priority order, up to the cap.
    let forcedCount = 0;
    for (const sku of orderedSkus) {
      if (selected.length >= maxChunks) break;
      for (const c of chunks) {
        if (selected.length >= maxChunks) break;
        if (c.sku && c.sku.toUpperCase() === sku) { take(c); forcedCount++; }
      }
    }

    // 2) Add semantic top-K above the floor.
    let ranked = [];
    try {
      const q = await embedQuery(query);
      ranked = chunks
        .map((c) => ({ c, score: dot(q, c.embedding) }))
        .sort((a, b) => b.score - a.score);
      for (const r of ranked.filter((r) => r.score >= minScore).slice(0, topK)) take(r.c);
    } catch (e) {
      console.warn("Voyage embedder failed; using SKU matches only:", e.message);
    }

    if (!selected.length) {
      console.log(`[retrieval] nothing relevant (skus=${orderedSkus.join(",") || "none"}) -> null`);
      return null;
    }

    const finalChunks = selected.slice(0, maxChunks);
    const top = ranked.slice(0, 6).map((r) => `${r.c.sku ?? r.c.section}=${r.score.toFixed(3)}`).join("  ");
    console.log(`[retrieval] q="${query.slice(0, 60)}" skus=[${orderedSkus.join(",")}] forced=${forcedCount} top: ${top}`);
    console.log(`[retrieval] injecting ${finalChunks.length} chunk(s)`);

    return finalChunks.map((c) => c.text).join("\n\n---\n\n");
  } catch (e) {
    console.warn("Manual retrieval failed, continuing without context:", e.message);
    return null;
  }
}

export default { getManualContext };
