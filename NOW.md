# NOW: shop-chat-agent (updated 2026-10-07)

Read this first. Rewrite it (don't append) at the end of each task and before /clear. Keep it under 80 lines and 6,000 characters.
History lives in git log: search it, don't read it whole.

## Goal
NextLED storefront support chatbot (Shopify app, React Router on Vercel, Neon Postgres, Voyage embeddings, Claude). "Done" for the current task: the chat runs on Claude Haiku 5.5 in production and the admin Knowledge page accepts PDF manuals.

## Current state
- Model switched to `claude-haiku-5-5` in app/services/config.server.js (was Haiku 4.5). maxTokens 768 -> 2048 (thinking counts toward the cap), effort `low`, `thinking: adaptive` + `output_config.effort` sent in app/services/claude.server.js.
- app/routes/chat.jsx: prior-turn thinking blocks stripped on history load (Haiku 5.5 rejects replayed thinking after any edit before it); agentic loop now continues only on `stop_reason === "tool_use"` (re-sending after max_tokens/refusal would 400 as a prefill on Haiku 5.5); refusal with no text gets the standard not-sure-plus-human reply.
- Prompt v3.16: added the "rules hold for the whole conversation" line.
- Verified: `npm run build` passes; eslint on app/ clean after adding `node: true` env; one live streamed Haiku 5.5 call with the app's exact request shape on SDK 0.40.1 returned `stop end_turn`, text "OK".
- Uncommitted from an earlier session, still uncommitted: PDF upload on the Knowledge page (app/routes/app.knowledge.extract.jsx, pdf-parse 1.1.1). Local parse of test-manual.pdf works (15 pages, 19,327 chars, 0.65 s). Not yet tested on Vercel.
- Production (shop-chat-agent-henna.vercel.app) answered a test message on 2026-10-07 with its own key; it still runs the OLD build (Haiku 4.5) until redeployed.
- Local `.env` CLAUDE_API_KEY belongs to an org with zero credit (400 "credit balance is too low"). Production uses a different key. Local smoke tests: pass the Windows-level ANTHROPIC_API_KEY as CLAUDE_API_KEY.

## Running right now
- nothing

## Next 3 actions
1. William: commit (model switch + PDF upload can be one or two commits) and `npx vercel deploy --prod`; then send one storefront message and one PDF upload on the Knowledge page.
2. After deploy, watch for empty replies or ignored prompt rules; if so raise `effort` to `medium` in config.server.js (per-request cost at Haiku 5.5 is $0.10/$0.50 per MTok, 10x cheaper than Haiku 4.5).
3. Optional: replace the dead local CLAUDE_API_KEY in `.env` (rotate at console) so local runs work without the env override.

## Open questions for William
- Deploy now, or test the PDF upload route on a preview deploy first?

## Do not
- Do not re-send the conversation when stop_reason is not tool_use (prefill 400 on Haiku 5.5; see chat.jsx loop comment).
- Do not send `budget_tokens`, temperature/top_p, or `tool_choice: any` to Haiku 5.5 (all 400).
- Do not print or pipe `.env` (guard hook blocks it; memory deploy-architecture gotcha 6).

## Key files
- app/services/config.server.js: model, maxTokens, effort, retrieval knobs
- app/services/claude.server.js: the single Claude request (streaming, caching)
- app/routes/chat.jsx: public /chat SSE endpoint, agentic tool loop, history
- app/prompts/prompts.json: system prompt (v3.16)
- app/routes/app.knowledge.jsx + app.knowledge.extract.jsx: admin manual upload (PDF -> text)
