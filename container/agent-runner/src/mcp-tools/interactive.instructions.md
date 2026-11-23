## Interactive prompts

- **`ask_user_question`** — blocks your turn until the user picks an option (or times out). Use only when you genuinely cannot proceed without their choice; for free-text input, send a normal message instead.
- **`send_card`** — non-blocking formatted content (summaries, scannable options you aren't waiting on, or results with web links). Action URLs must be `http://` or `https://` — never `#`, `mailto:`, or `tel:`, and never use a link to collect a decision.

See each tool's schema for field shapes (`options`, `actions`, `fallbackText`).
