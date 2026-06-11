// app/services/retrieval.server.js
// Semantic + reference-aware retrieval over the NextLED manual index
// (data/manual-index.json). The index is statically imported so the Vercel
// bundler ships it inside the function. Embedding uses Voyage (voyage.server.js)
// so the query embedder always matches the index embedder. Any failure returns
// null so the chat flow continues without manual context (graceful degradation).
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

// Detect products referenced in text by SKU code, product name, alias, or
// multi-word keyword (from the index catalog). Returns SKUs in first-seen order.
function detectSkus(text, catalog) {
  const lower = (text || "").toLowerCase();
  const found = [];
  const add = (s) => {
    const u = s.toUpperCase();
    if (!found.includes(u)) found.push(u);
  };
  for (const m of (text || "").matchAll(SKU_RE)) add(m[0]);
  for (const p of catalog) {
    if (!p.sku) continue;
    const needles = [
      p.product_name,
      ...(p.aliases || []),
      ...(p.keywords || []).filter((k) => typeof k === "string" && k.includes(" ")),
    ];
    for (const n of needles) {
      if (n && n.length >= 4 && lower.includes(n.toLowerCase())) {
        add(p.sku);
        break;
      }
    }
  }
  return found;
}

/**
 * Detect product SKUs referenced in free text (by SKU code, product name, alias,
 * or multi-word keyword from the index catalog). First-seen order. Exported for
 * the price prefetch, so "what is the price" can resolve to the product being
 * discussed instead of searching the catalog for the literal question text.
 * @param {string} text
 * @returns {string[]}
 */
export function detectProductSkus(text) {
  return detectSkus(text || "", indexData?.catalog || []);
}

/**
 * Build manual context for a query. Always includes a catalog overview of all
 * products. For details it takes the semantic top-K for the CURRENT question
 * first (so an accessory/policy answer is never crowded out), then force-includes
 * every chunk for a product referenced in the current message or recent
 * conversation, up to a cap.
 * @param {string} query - the current user message
 * @param {string} [contextText] - recent conversation text, for reference detection
 * @param {Promise<number[]>} [embeddingPromise] - pre-started query embedding, so
 *   the Voyage round trip can overlap the caller's DB work instead of following it
 * @returns {Promise<string|null>}
 */
export async function getManualContext(query, contextText = "", embeddingPromise = null) {
  try {
    const chunks = indexData?.chunks;
    if (!chunks?.length) {
      console.warn("Manual index empty/missing; retrieval disabled.");
      return null;
    }
    const catalog = indexData.catalog || [];
    const catalogSummary = indexData.catalogSummary || "";

    const topK = AppConfig.retrieval?.topK ?? 6;
    const minScore = AppConfig.retrieval?.minScore ?? 0.4;
    const maxChunks = AppConfig.retrieval?.maxChunks ?? 14;

    const curRefs = detectSkus(query, catalog);
    const ctxRefs = detectSkus(contextText, catalog).reverse().filter((s) => !curRefs.includes(s));

    const selected = [];
    const seen = new Set();
    const take = (c) => {
      if (!seen.has(c.id) && selected.length < maxChunks) { seen.add(c.id); selected.push(c); }
    };

    // 1) Semantic top-K for the current query FIRST, so chunks most relevant to
    //    what is being asked now (e.g. an accessory/policy answer) are never
    //    crowded out by force-included product chunks.
    let ranked = [];
    try {
      const q = await (embeddingPromise || embedQuery(query));
      ranked = chunks.map((c) => ({ c, score: dot(q, c.embedding) })).sort((a, b) => b.score - a.score);
      for (const r of ranked.filter((r) => r.score >= minScore).slice(0, topK)) take(r.c);
    } catch (e) {
      console.warn("Voyage embedder failed; using catalog + reference matches only:", e.message);
    }

    // 2) Force-include the product named in the current message, then any from
    //    recent context, until the cap is reached.
    const forceSku = (sku) => {
      for (const c of chunks) if (c.sku && c.sku.toUpperCase() === sku) take(c);
    };
    for (const sku of curRefs) forceSku(sku);
    for (const sku of ctxRefs) forceSku(sku);

    // Always include the catalog overview, then the relevant manual details.
    const parts = [];
    if (catalogSummary) parts.push(`Catalog overview (all NextLED products):\n${catalogSummary}`);
    if (selected.length) {
      parts.push(`Relevant manual details:\n${selected.map((c) => c.text).join("\n\n---\n\n")}`);
    }
    if (!parts.length) return null;

    const top = ranked.slice(0, 5).map((r) => `${r.c.sku ?? r.c.section}=${r.score.toFixed(3)}`).join("  ");
    console.log(`[retrieval] q="${query.slice(0, 60)}" cur=[${curRefs.join(",")}] ctx=[${ctxRefs.join(",")}] details=${selected.length} top: ${top}`);

    return parts.join("\n\n");
  } catch (e) {
    console.warn("Manual retrieval failed, continuing without context:", e.message);
    return null;
  }
}

export default { getManualContext };
