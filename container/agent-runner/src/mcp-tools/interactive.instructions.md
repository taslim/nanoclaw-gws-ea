## Interactive prompts

The two tools here solve different problems: `ask_user_question` forces a decision and waits for it; `send_card` sends formatted content and moves on.

### Asking a multiple-choice question (`ask_user_question`)

`mcp__nanoclaw__ask_user_question({ title, question, options, timeout? })` puts a set of choices to the user and **blocks your turn** until they answer in the conversation or the timeout expires (default: 300 seconds). Returns the value of the option they chose.

`options` can be plain strings or `{ label, selectedLabel?, value? }` objects:
- `label` — the option as the user sees it
- `selectedLabel` — what the question shows once that option is chosen (useful for confirmations, e.g. `"✓ Confirmed"`)
- `value` — the string returned to you when that option is chosen (defaults to `label`)

Use this when you genuinely cannot proceed without a decision. For free-text input, send a normal message and wait for their reply — don't reach for this tool.

### Formatted content (`send_card`)

`mcp__nanoclaw__send_card({ card, fallbackText? })` sends structured content and **returns immediately** — it does not pause your turn or collect a response.

`card` supports: `title`, `description`, `children` (strings or objects with a `text` field), and top-level `actions`. Each action needs a non-empty `label` and a `url` that is a web link (http or https, like `https://example.com`), and is shown as a link. Invalid actions are dropped before the content is sent and the tool result tells you how many — that includes a placeholder such as `#`, and other schemes such as `mailto:` or `tel:`, which not every chat platform shows as a link. A link is never a way for the user to answer you: to have them choose, use `ask_user_question`. An action's optional `style` is `primary`, `danger` or `default`; any other value counts as `default`. Nested action blocks are unsupported. `fallbackText` is a plain-text version of the content, for channels that need one alongside it.

Use this for presenting information in a cleaner format than prose: summaries, options the user can read (but you're not waiting on), or results with links. If you need the user to actually *choose* something and return a value, use `ask_user_question` instead.
