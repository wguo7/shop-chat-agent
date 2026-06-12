// Temporary: time the SSE events of a production chat request.
// Usage: node scripts/tmp-time-chat.mjs "message" [conversation_id]
const msg = process.argv[2] || "how bright is the tripod light";
const convId = process.argv[3];

const t0 = Date.now();
const res = await fetch("https://shop-chat-agent-henna.vercel.app/chat", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    Origin: "https://nextool.myshopify.com",
  },
  body: JSON.stringify({ message: msg, ...(convId ? { conversation_id: convId } : {}) }),
});
console.log(`headers (TTFB-ish): ${Date.now() - t0}ms  status=${res.status}`);

const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = "";
let firstChunk = null;
let idAt = null;
let chunkCount = 0;
let convOut = "";
for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  const parts = buf.split("\n\n");
  buf = parts.pop() || "";
  for (const p of parts) {
    if (!p.startsWith("data: ")) continue;
    const d = JSON.parse(p.slice(6));
    const t = Date.now() - t0;
    if (d.type === "id") { idAt = t; convOut = d.conversation_id; }
    if (d.type === "chunk") {
      chunkCount++;
      if (!firstChunk) { firstChunk = t; console.log(`first chunk: ${t}ms`); }
    }
    if (d.type === "end_turn") console.log(`end_turn: ${t}ms (${chunkCount} chunks)`);
  }
}
console.log(`total: ${Date.now() - t0}ms  id@${idAt}ms  conv=${convOut}`);
