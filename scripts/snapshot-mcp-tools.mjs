// Regenerate data/mcp-tools.json: the build-time snapshot of MCP tool lists
// that new function instances use instead of a tools/list round-trip.
// Applies the same filtering as MCPClient._formatToolsData (no cart, checkout
// or order tools; UCP `meta` stripped from schemas). Customer-account tools
// are kept from the existing file because that endpoint needs a login.
//
//   node scripts/snapshot-mcp-tools.mjs
import fs from "fs";

const SHOP = "https://nextool.myshopify.com";
const PROFILE = "https://shop-chat-agent-henna.vercel.app/ucp-agent-profile.json";
const OUT = new URL("../data/mcp-tools.json", import.meta.url);

const endpoints = [
  { url: `${SHOP}/api/ucp/mcp`, params: { meta: { "ucp-agent": { profile: PROFILE } } } },
  { url: `${SHOP}/api/mcp`, params: {} },
];

function format(toolsData) {
  return toolsData
    .filter((tool) => !/cart|checkout|order/i.test(tool.name))
    .map((tool) => {
      const raw = tool.inputSchema || tool.input_schema || {};
      let input_schema = raw;
      if (raw.properties && raw.properties.meta) {
        const properties = { ...raw.properties };
        delete properties.meta;
        input_schema = {
          ...raw,
          properties,
          ...(Array.isArray(raw.required) ? { required: raw.required.filter((r) => r !== "meta") } : {}),
        };
      }
      return { name: tool.name, description: tool.description, input_schema };
    });
}

const existing = JSON.parse(fs.readFileSync(OUT, "utf8"));
const next = { createdAt: new Date().toISOString(), endpoints: {} };
for (const [url, tools] of Object.entries(existing.endpoints || {})) {
  if (url.includes("/customer/api/mcp")) next.endpoints[url] = tools;
}
for (const { url, params } of endpoints) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params }),
  });
  const data = await res.json();
  const tools = format(data.result?.tools || []);
  if (tools.length) next.endpoints[url] = tools;
  console.log(url, "->", tools.map((t) => t.name).join(", ") || "(none)");
}
fs.writeFileSync(OUT, JSON.stringify(next, null, 2) + "\n");
console.log("wrote", OUT.pathname);
