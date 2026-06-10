// scripts/build-index.mjs
// Builds a local vector index from knowledge/*.md (excluding STYLE.md, _TEMPLATE.md).
// Structure-aware chunking + identity-stamped chunk text. Fully local embeddings (WASM).
// Knowledge files are the single source of truth; this output is a derived artifact.
import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { embedDocuments, EMBED_MODEL } from "../app/services/voyage.server.js";

const KNOWLEDGE_DIR = path.resolve("knowledge");
const OUT_FILE = path.resolve("data", "manual-index.json");
const EXCLUDE = new Set(["_TEMPLATE.md", "STYLE.md"]);

function listMarkdown() {
  return fs
    .readdirSync(KNOWLEDGE_DIR)
    .filter((f) => f.endsWith(".md") && !EXCLUDE.has(f))
    .sort();
}

// First top-level "# Heading" in the body, used as identity for non-product docs.
function firstH1(body) {
  const m = body.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

// Split body into [{ heading, content }] by "## " headings.
function splitSections(body) {
  const lines = body.split("\n");
  const sections = [];
  let cur = { heading: null, content: [] };
  for (const line of lines) {
    const h = line.match(/^##\s+(.+)$/);
    if (h) {
      if (cur.content.join("").trim() || cur.heading) sections.push(cur);
      cur = { heading: h[1].trim(), content: [] };
    } else {
      cur.content.push(line);
    }
  }
  if (cur.content.join("").trim() || cur.heading) sections.push(cur);
  return sections.map((s) => ({ heading: s.heading, content: s.content.join("\n").trim() }));
}

// Split a "Common questions" section into one string per bold-question + answer.
function splitQnaPairs(content) {
  const lines = content.split("\n");
  const pairs = [];
  let cur = null;
  const isQuestion = (l) => /^\*\*.+\*\*$/.test(l.trim());
  for (const line of lines) {
    if (isQuestion(line)) {
      if (cur) pairs.push(cur.trim());
      cur = line + "\n";
    } else if (cur !== null) {
      cur += line + "\n";
    }
  }
  if (cur) pairs.push(cur.trim());
  return pairs.filter(Boolean);
}

// Split the product-index comparison table into one chunk per data row,
// keeping the header + separator so each row reads as a labelled mini-table.
function splitComparisonRows(content) {
  const rows = content.split("\n").filter((l) => l.trim().startsWith("|"));
  if (rows.length < 3) return [{ text: content, sku: null, name: null }];
  const [header, sep, ...dataRows] = rows;
  return dataRows.map((row) => {
    const cells = row.split("|").map((c) => c.trim()).filter(Boolean);
    return {
      text: [header, sep, row].join("\n"),
      sku: cells[0] || null,
      name: cells[1] || null,
    };
  });
}

// Split a section that contains "### " subsections into one piece per subsection.
// Used for spec tables broken out per variant (e.g. the 3-in-1 kit's three heads),
// so each head is its own self-contained chunk and stays under the token limit.
// Returns [{ sub, text }]; sub is null when there are no subsections.
function splitBySubsections(content) {
  const lines = content.split("\n");
  const subs = [];
  const preamble = [];
  let cur = null;
  for (const line of lines) {
    const h = line.match(/^###\s+(.+)$/);
    if (h) {
      if (cur) subs.push(cur);
      cur = { sub: h[1].trim(), content: [] };
    } else if (cur) {
      cur.content.push(line);
    } else {
      preamble.push(line);
    }
  }
  if (cur) subs.push(cur);
  if (subs.length === 0) return [{ sub: null, text: content }];
  const result = subs.map((s) => ({ sub: s.sub, text: s.content.join("\n").trim() }));
  const pre = preamble.join("\n").trim();
  if (pre) result.unshift({ sub: "Overview", text: pre });
  return result;
}

// Turn one file into labelled, self-contained chunks.
function chunkFile(file, raw) {
  const { data, content } = matter(raw);
  const docType = data.doc_type || (data.sku ? "product" : "unknown");
  const baseSku = data.sku || null;
  const baseName = data.product_name || firstH1(content) || file;
  const baseLabel = baseSku ? `${baseSku} | ${baseName}` : baseName;
  const sections = splitSections(content);
  const chunks = [];

  const push = (label, section, text, sku, name) => {
    if (!text || !text.trim()) return;
    const stamped = `[${label}] — Section: ${section}\n${text.trim()}`;
    chunks.push({
      id: `${file}#${chunks.length}`,
      sku: sku ?? baseSku,
      product_name: name ?? baseName,
      source: file,
      section,
      doc_type: docType,
      text: stamped,
    });
  };

  for (const { heading, content: secContent } of sections) {
    const name = heading || "Overview";
    if (/^common questions$/i.test(name)) {
      for (const qa of splitQnaPairs(secContent)) push(baseLabel, "Common questions", qa);
    } else if (docType === "product-index" && /comparison/i.test(name)) {
      for (const r of splitComparisonRows(secContent)) {
        const label = r.sku ? `${r.sku} | ${r.name}` : baseLabel;
        push(label, "Comparison", r.text, r.sku, r.name);
      }
    } else {
      // Specifications, Troubleshooting, What it is, How this differs, etc.
      // Kept whole — unless the section has "### " subsections (e.g. the 3-in-1
      // kit's per-head spec tables), in which case split one chunk per subsection.
      const subs = splitBySubsections(secContent);
      if (subs.length > 1) {
        for (const s of subs) push(baseLabel, `${name} — ${s.sub}`, s.text);
      } else {
        push(baseLabel, name, secContent);
      }
    }
  }
  return chunks;
}

async function main() {
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  const files = listMarkdown();
  console.log(`Indexing ${files.length} files from knowledge/\n`);

  const allChunks = [];
  const perFile = new Map();
  const catalog = [];      // per-product { sku, product_name, aliases, keywords } for reference detection
  let catalogSummary = ""; // compact catalog (the product-index comparison table) always injected
  for (const file of files) {
    const raw = fs.readFileSync(path.join(KNOWLEDGE_DIR, file), "utf8");
    const { data } = matter(raw);
    if (data.sku) {
      catalog.push({
        sku: data.sku,
        product_name: data.product_name || "",
        category: data.category || "",
        aliases: Array.isArray(data.aliases) ? data.aliases : [],
        keywords: Array.isArray(data.keywords) ? data.keywords : [],
      });
    }
    const chunks = chunkFile(file, raw);
    perFile.set(file, chunks.length);
    allChunks.push(...chunks);
  }

  // Compact catalog overview (one line per product) — injected on every request so
  // the assistant always knows the full lineup, while keeping per-request tokens low.
  catalogSummary = catalog
    .map((p) => `- ${p.sku} ${p.product_name}${p.category ? ` (${p.category})` : ""}`)
    .join("\n");

  // Per-file chunk counts + zero-chunk guard.
  console.log("Per-file chunk counts:");
  const zeroFiles = [];
  for (const file of files) {
    const n = perFile.get(file);
    console.log(`  ${String(n).padStart(3)}  ${file}`);
    if (n === 0) zeroFiles.push(file);
  }
  if (zeroFiles.length) {
    console.log(`\n!! WARNING: ${zeroFiles.length} file(s) produced ZERO chunks (structure did not parse):`);
    for (const f of zeroFiles) console.log(`   - ${f}`);
  } else {
    console.log("\nAll files produced at least one chunk.");
  }

  console.log(`\nTotal chunks: ${allChunks.length}. Embedding with ${EMBED_MODEL} (Voyage) ...`);

  // Batch-embed (Voyage accepts up to 128 inputs per request).
  const BATCH = 128;
  let dim = 0;
  for (let i = 0; i < allChunks.length; i += BATCH) {
    const batch = allChunks.slice(i, i + BATCH);
    const vectors = await embedDocuments(batch.map((c) => c.text));
    for (let j = 0; j < batch.length; j++) {
      batch[j].embedding = vectors[j];
      dim = vectors[j].length;
    }
    console.log(`  embedded ${Math.min(i + BATCH, allChunks.length)}/${allChunks.length}`);
  }

  // Truncation check: voyage-3.5-lite has a 32k-token context, far above any chunk
  // here, so the per-chunk truncation risk that applied to MiniLM (256 tokens) is
  // gone. Flag only pathologically large chunks as a sanity net.
  const CHAR_WARN = 16000; // ~4k tokens
  const oversized = allChunks.filter((c) => c.text.length > CHAR_WARN);
  if (oversized.length) {
    console.log(`\n!! OVERSIZED CHUNKS (>${CHAR_WARN} chars): ${oversized.length}`);
    for (const c of oversized) {
      console.log(`   - ${c.source}  [sku=${c.sku ?? "n/a"}]  section="${c.section}"  ${c.text.length} chars`);
    }
  } else {
    console.log(`\nNo oversized chunks (all well within Voyage's 32k-token context).`);
  }

  console.log(`Embedding dimension: ${dim}`);
  fs.writeFileSync(
    OUT_FILE,
    JSON.stringify(
      { model: EMBED_MODEL, dim, createdAt: new Date().toISOString(), count: allChunks.length, catalog, catalogSummary, chunks: allChunks },
      null,
      2,
    ),
  );
  console.log(`\nWrote ${allChunks.length} chunks (dim ${dim}) to ${path.relative(process.cwd(), OUT_FILE)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
