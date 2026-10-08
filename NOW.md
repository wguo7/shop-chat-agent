# NOW: shop-chat-agent (updated 2026-10-07)

Read this first. Rewrite it (don't append) at the end of each task and before /clear. Keep it under 80 lines and 6,000 characters.
History lives in git log: search it, don't read it whole.

## Goal
NextLED storefront support chatbot (Shopify app, React Router on Vercel, Neon Postgres, Voyage embeddings, Claude). Current task is done: Claude Haiku 5.5 is live in production and catalog search works again.

## Current state
- Production (shop-chat-agent-henna.vercel.app) runs commit 4ddf424, deployed 2026-10-07. Verified live: manual question, price+stock question ("$39.99 USD and in stock"), tool-driven search with 3 product cards carrying images.
- Model: `claude-haiku-5-5`, maxTokens 2048, effort `low`, adaptive thinking (app/services/config.server.js, claude.server.js). chat.jsx strips prior-turn thinking blocks, loops only on tool_use, and answers refusals with the not-sure-plus-human line. Prompt v3.16.
- Catalog fix (90d3208): Shopify removed catalog tools from {shop}/api/mcp on 2026-08-31, so prices had silently been "not sure". Tools now come from {shop}/api/ucp/mcp with the agent profile public/ucp-agent-profile.json (Shopify's example copied verbatim; `payment_handlers: {}` is required). Profile injected server-side in app/mcp-client.js and app/routes/chat.jsx fetchLivePrice; stripped from the schema the model sees. Legacy endpoint still supplies search_shop_policies_and_faqs. `node scripts/snapshot-mcp-tools.mjs` regenerates data/mcp-tools.json.
- Branch deploy/vercel-postgres-voyage is 3 commits ahead of origin. NOT pushed (needs William's go-ahead).
- PDF upload for the Knowledge page is parked in `git stash` ("pdf-upload"), per William: not deployed. test-manual.pdf at repo root is gitignored.
- Local `.env` CLAUDE_API_KEY has zero credit; production uses a different, working key. Local smoke tests: `CLAUDE_API_KEY="$ANTHROPIC_API_KEY" node <script>`.
- Vercel CLI login refreshed 2026-10-07 (device flow).

## Running right now
- nothing

## Next 3 actions
1. William: say whether to `git push origin deploy/vercel-postgres-voyage` (3 commits: 10b83ae Haiku 5.5, 90d3208 UCP catalog, 4ddf424 cards).
2. Watch production for a week: empty replies or ignored prompt rules mean raise `effort` to `medium` in config.server.js (Haiku 5.5 is $0.10/$0.50 per MTok, 10x cheaper than 4.5).
3. If Shopify drops {shop}/api/mcp entirely (sunset 2026-08-31), policy/FAQ questions lose their tool; mcp-client.js already tolerates that endpoint failing.

## Open questions for William
- Push the 3 commits to GitHub?
- Keep or drop the stashed PDF upload feature?

## Do not
- Do not re-send the conversation when stop_reason is not tool_use (prefill 400 on Haiku 5.5; chat.jsx loop comment).
- Do not send `budget_tokens`, temperature/top_p, or `tool_choice: any` to Haiku 5.5 (all 400).
- Do not call {shop}/api/ucp/mcp without meta.ucp-agent.profile (UCP discovery error); the profile must include `payment_handlers`.
- Do not print or pipe `.env` (guard hook blocks it; memory deploy-architecture gotcha 6).

## Key files
- app/services/config.server.js: model, maxTokens, effort, retrieval knobs, ucp.agentProfileUrl
- app/services/claude.server.js: the single Claude request (streaming, caching)
- app/routes/chat.jsx: public /chat SSE endpoint, agentic tool loop, history, price prefetch
- app/mcp-client.js: storefront (UCP + legacy) and customer MCP tool loading/calls
- app/services/tool.server.js: tool results, product card formatting
- app/prompts/prompts.json: system prompt (v3.16)
- public/ucp-agent-profile.json, data/mcp-tools.json, scripts/snapshot-mcp-tools.mjs
