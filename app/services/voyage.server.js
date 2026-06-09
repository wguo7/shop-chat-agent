// app/services/voyage.server.js
// Voyage AI embeddings — the SINGLE source of truth for the embedding model used
// by BOTH the index builder (scripts/build-index.mjs) and runtime retrieval
// (retrieval.server.js). They must always use the same model, so it lives here.
// No native deps: this is a plain fetch to Voyage's hosted API, so it runs the
// same locally and on Vercel serverless.

export const EMBED_MODEL = "voyage-3.5-lite";
export const EMBED_DIM = 1024;

const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";

// Unit-normalize so cosine similarity reduces to a dot product downstream.
function normalize(v) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
}

async function callVoyage(input, inputType) {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) throw new Error("VOYAGE_API_KEY is not set");
  const res = await fetch(VOYAGE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: EMBED_MODEL,
      input,
      input_type: inputType,
      output_dimension: EMBED_DIM,
    }),
  });
  if (!res.ok) {
    throw new Error(`Voyage API ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  return json.data.map((d) => normalize(d.embedding));
}

// Batch-embed documents for indexing (Voyage accepts up to 128 inputs per call).
export async function embedDocuments(texts) {
  return callVoyage(texts, "document");
}

// Embed a single user query.
export async function embedQuery(text) {
  const [vector] = await callVoyage([text], "query");
  return vector;
}
