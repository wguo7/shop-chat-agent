# STYLE.md — Writing Rules for NextLED Product Knowledge Files

These rules govern every file in `knowledge/`. They sit on top of the structure defined in `_TEMPLATE.md`, and they obey `decisions.md` (authoritative) and the closed rulings in `conflicts_to_resolve.md`.

## Voice and punctuation
- Use plain, direct language a customer would understand. Short sentences.
- No em dashes anywhere.
- No colons inside sentences. (Colons are allowed only to introduce a list or a table, not mid sentence.)

## Accuracy (hard limits)
- Fix obvious prose typos in marketing copy, for example "Shoop" becomes "Shop" and "seperately" becomes "separately".
- Never alter a spec value, a unit, or a model number, even if it looks wrong. If a value was changed, it was changed only because `decisions.md` overrode it, and it must be listed under `spec_conflicts_resolved`.
- Never guess a value. If no source states it, omit the row.
- Never publish anything marked UNRESOLVED or any unconfirmed charger value. The only charger guidance allowed for NT-2143C-B and NT-5571 is the exact approved wording in `decisions.md` §7c.

## Self-contained chunks
- Every file must be self-contained. Any single chunk read on its own must name the product and its SKU, so the heading and early lines always carry "NextLED {product_name} ({sku})".
- Spell out the SKU in answers where it aids retrieval. Do not rely on context from other files.

## Per-template reminders
- `product_line` is exactly `standard` or `ULTIMATE`. ULTIMATE is only NT-6692M, NT-7885M, NT-6926M.
- `warranty_years` is `3` for the three ULTIMATE models and `1` for all others, per `decisions.md`.
- Normalize units to lm, hrs, ft, in, mm, K, V, mAh. Multi-mode values go on separate rows.
- Record every aliased or transposed SKU in `aliases` and `keywords` so customers who arrive with the wrong number still match.
