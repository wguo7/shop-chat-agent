// Live QA suite: runs one question of each type against production and prints
// timing + answer. Usage: node scripts/qa-suite.mjs
const BASE = "https://shop-chat-agent-henna.vercel.app/chat";
const ORIGIN = "https://nextool.myshopify.com";

async function ask(message, conversationId) {
  const t0 = Date.now();
  const res = await fetch(BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream", Origin: ORIGIN },
    body: JSON.stringify({ message, ...(conversationId ? { conversation_id: conversationId } : {}) }),
  });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", text = "", first = 0, conv = conversationId || "", tools = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() || "";
    for (const p of parts) {
      if (!p.startsWith("data: ")) continue;
      let d; try { d = JSON.parse(p.slice(6)); } catch { continue; }
      if (d.type === "id") conv = d.conversation_id;
      if (d.type === "chunk") { if (!first) first = Date.now() - t0; text += d.chunk; }
      if (d.type === "tool_use") tools++;
    }
  }
  return { text: text.trim(), first, total: Date.now() - t0, conv, tools };
}

const suite = [
  ["spec", "what is the CRI of the NT-7885M"],
  ["procedure", "how do I use turbo mode on the NT-7885M"],
  ["procedure", "how do I charge the NT-5571"],
  ["procedure (regression)", "how to use tripod remote"],
  ["price", "how much is the NT-1010UV"],
  ["stock", "is the NT-6648 in stock"],
  ["policy", "what is your return policy"],
  ["warranty", "what warranty comes with the NT-7885M"],
  ["catalog", "what kinds of lights do you sell"],
  ["fallback", "do you sell air compressors"],
];

for (const [kind, q] of suite) {
  const r = await ask(q);
  console.log(`\n[${kind}] "${q}"  first=${r.first}ms total=${r.total}ms tools=${r.tools}`);
  console.log(`  ${r.text.replace(/\n+/g, " | ").slice(0, 320)}`);
}

// Multi-turn follow-up
const r1 = await ask("tell me about the NT-6633");
const r2 = await ask("how much is it", r1.conv);
console.log(`\n[follow-up price] first=${r2.first}ms total=${r2.total}ms tools=${r2.tools}`);
console.log(`  ${r2.text.replace(/\n+/g, " | ").slice(0, 200)}`);
