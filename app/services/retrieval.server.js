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
 * Build manual context for a query. Always includes a catalog overview of all
 * products (so the assistant is aware of the full lineup), plus detailed manual
 * excerpts: every chunk for any product referenced by SKU/name/keyword in the
 * current message (prioritized) or recent conversation, then semantic top-K.
 * @param {string} query - the current user message
 * @param {string} [contextText] - recent conversation text, for reference detection
 * @returns {Promise<string|null>}
 */
export async function getManualContext(query, contextText = "") {
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

    // Referenced products: current message first, then recent context (most recent
    // first), so the current question's product is never starved by the cap.
    const curRefs = detectSkus(query, catalog);
    const ctxRefs = detectSkus(contextText, catalog).reverse();
    const orderedSkus = [];
    for (const s of [...curRefs, ...ctxRefs]) if (!orderedSkus.includes(s)) orderedSkus.push(s);

    const selected = [];
    const seen = new Set();
    const take = (c) => {
      if (!seen.has(c.id)) { seen.add(c.id); selected.push(c); }
    };

    // 1) Force-include chunks for referenced products, priority order, up to cap.
    let forcedCount = 0;
    for (const sku of orderedSkus) {
      if (selected.length >= maxChunks) break;
      for (const c of chunks) {
        if (selected.length >= maxChunks) break;
        if (c.sku && c.sku.toUpperCase() === sku) { take(c); forcedCount++; }
      }
    }

    // 2) Semantic top-K above the floor fills remaining detail slots.
    let ranked = [];
    try {
      const q = await embedQuery(query);
      ranked = chunks.map((c) => ({ c, score: dot(q, c.embedding) })).sort((a, b) => b.score - a.score);
      for (const r of ranked.filter((r) => r.score >= minScore).slice(0, topK)) {
        if (selected.length >= maxChunks) break;
        take(r.c);
      }
    } catch (e) {
      console.warn("Voyage embedder failed; using catalog + reference matches only:", e.message);
    }

    // Always include the catalog overview, then the relevant manual details.
    const parts = [];
    if (catalogSummary) parts.push(`Catalog overview (all NextLED products):\n${catalogSummary}`);
    if (selected.length) {
      parts.push(`Relevant manual details:\n${selected.map((c) => c.text).join("\n\n---\n\n")}`);
    }
    if (!parts.length) return null;

    const top = ranked.slice(0, 5).map((r) => `${r.c.sku ?? r.c.section}=${r.score.toFixed(3)}`).join("  ");
    console.log(`[retrieval] q="${query.slice(0, 60)}" skus=[${orderedSkus.join(",")}] forced=${forcedCount} details=${selected.length} top: ${top}`);

    return parts.join("\n\n");
  } catch (e) {
    console.warn("Manual retrieval failed, continuing without context:", e.message);
    return null;
  }
}

export default { getManualContext };
