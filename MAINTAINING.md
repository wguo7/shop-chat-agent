# Maintaining the NextLED Chat Agent

Hand-off guide. The most common tasks are at the top; architecture and accounts at the bottom.

## What this is (30 seconds)

A chat widget on the NextLED storefront (mynextled.com / nextool.myshopify.com) answers product and policy questions. It runs on **Vercel** (server), stores chats in **Neon Postgres**, finds relevant manual text with **Voyage** embeddings, and answers with **Claude** (Anthropic). The widget itself is a **Shopify theme extension**. The assistant only answers from the knowledge base plus live Shopify search — it never invents specs or prices, never adds to cart, and falls back to contact info when unsure.

---

## Task 1: Add or update a product manual (most common)

The knowledge base is the `knowledge/` folder — one Markdown file per product.

**No-code path (recommended):**
1. On github.com, open `knowledge/` on the `deploy/vercel-postgres-voyage` branch.
2. To update: edit the product's `.md` file in the web editor.
   To add: copy the structure of `knowledge/_TEMPLATE.md` into a new file named after the SKU (e.g. `NT-1234.md`). Follow `knowledge/STYLE.md`.
3. Commit. GitHub Actions ("rebuild-index" workflow) automatically re-embeds the index and deploys to production. Takes ~3–5 minutes; check the Actions tab for a green check.
4. Verify by asking the chat on the storefront about the new content.

**Rules that matter** (from STYLE.md):
- Frontmatter must include `sku`, `product_name`, `keywords` (multi-word keywords are how generic phrases like "tripod light" map to a product).
- If the printed manual conflicts with the current catalog, the catalog wins — record the ruling in `spec_conflicts_resolved` so the discrepancy is documented.
- Use LF line endings if editing locally (the build script normalizes CRLF now, but don't tempt fate).

**Local path** (if you have the repo set up): edit the file, then
`npm run index:build` → `git commit` → `npx vercel deploy --prod`.

## Task 2: Change how the assistant behaves

Edit `app/prompts/prompts.json` (one system prompt, plain text). Bump `version`. Commit on the deploy branch — the same GitHub Action deploys it. Current rules of note: no purchasing in chat (points to product page), concise fallback with contact@mynextled.com / 877-886-6822 when unsure.

## Task 3: Read or export customer conversations

Shopify admin → **Apps → shop-chat-agent → Conversations**. List, per-chat transcripts, "Copy transcript", and **Export all transcripts (CSV)** for Excel/Sheets. Watch the **"not sure" replies** stat — it counts answers the bot couldn't find, i.e. what to add to the knowledge base next.

## Task 4: Change the chat widget (storefront UI)

The widget lives in `extensions/chat-bubble/` (`assets/chat.js`, `assets/chat.css`). Changes there deploy through **Shopify**, not Vercel:
`npm run deploy -- --allow-updates` (needs Shopify CLI login to the NextLED org). The widget config (colors, welcome message) is in the theme editor.

## Task 5: Allow a new storefront domain

The API only accepts chat requests from allowed origins. If the store gets a new domain: Vercel dashboard → project → Settings → Environment Variables → edit `ALLOWED_ORIGINS` (comma-separated full origins, e.g. `https://nextool.myshopify.com,https://mynextled.com`) → redeploy. A wrong value here breaks the whole widget ("Sorry, I couldn't process your request").

---

## Deploys: which one when

| You changed | Deploy with |
| --- | --- |
| `knowledge/`, `app/prompts/` | automatic via GitHub Action (or `npx vercel deploy --prod`) |
| anything else in `app/` | `npx vercel deploy --prod` |
| `extensions/chat-bubble/` | `npm run deploy -- --allow-updates` (Shopify) |
| `prisma/schema.prisma` | `npx prisma migrate deploy` against the unpooled DB URL, then Vercel deploy |

## Accounts & secrets

| Service | Used for | Where the secret lives |
| --- | --- | --- |
| Vercel (`shop-chat-agent` project) | hosting, env vars | vercel.com — env vars are the source of truth |
| Neon Postgres (us-east-1) | chat storage | `DATABASE_URL` (pooled) + `DATABASE_URL_UNPOOLED` in Vercel |
| Anthropic | Claude API (the only real per-use cost) | `CLAUDE_API_KEY` in Vercel |
| Voyage AI | embeddings (query-time + index builds) | `VOYAGE_API_KEY` in Vercel + GitHub Actions secret |
| Shopify Partners (NextLED org) | the app + theme extension | Shopify CLI login |
| GitHub (`wguo7/shop-chat-agent`) | code + CI | `VERCEL_TOKEN`, `VOYAGE_API_KEY` Action secrets |

Local dev uses a `.env` file (never committed) mirroring the Vercel values.

## Background jobs

- **keep-warm** (GitHub Action, every 5 min): pings the history endpoint so shoppers don't hit cold starts. Note it keeps Neon's compute awake ~24/7, which sits just under the free tier's monthly compute allowance. On a private repo it will also exhaust free Actions minutes — use an external uptime monitor (e.g. UptimeRobot, same URL) instead if the repo stays private.
- **rebuild-index** (GitHub Action): described in Task 1.

## Troubleshooting quick hits

- **Widget says "Sorry, I couldn't process your request" for everything** → almost always `ALLOWED_ORIGINS` (Task 5). Test with:
  `curl -X POST https://shop-chat-agent-henna.vercel.app/chat -H "Origin: https://nextool.myshopify.com" -H "Content-Type: application/json" -H "Accept: text/event-stream" -d '{"message":"hi"}'`
- **Bot doesn't know something it should** → the answer isn't in `knowledge/`; add it (Task 1). Check the "not sure" counter in the dashboard.
- **Wrong/odd price** → prices come live from Shopify catalog search; check the product's title contains its SKU (matching keys off titles), and that accessories aren't titled ambiguously.
- **First reply slow (~3s)** → cold start; check the keep-warm workflow is still running (Actions tab).
- **Index rebuild fails in CI** → check the Action log; usually the new `.md` file is missing frontmatter (`sku:` etc.).

## Architecture (for developers)

`extensions/chat-bubble/assets/chat.js` (widget, SSE client)
→ `app/routes/chat.jsx` (orchestrator: origin check, history, retrieval injection, price prefetch, agent loop)
→ `app/services/` (`claude.server.js` API streaming, `retrieval.server.js` vector search over `data/manual-index.json`, `voyage.server.js` embeddings, `tool.server.js` tool results, `config.server.js` tunables)
→ `app/mcp-client.js` (Shopify storefront/customer MCP tools; cart/checkout tools are filtered out on purpose)
→ `app/db.server.js` (Prisma/Neon).

`data/manual-index.json` is a derived artifact — never edit it by hand; edit `knowledge/` and rebuild. Retrieval context is injected into the user message (never the cached system prompt) to keep prompt caching effective.
