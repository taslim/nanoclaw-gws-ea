## Date & Time

You will get dates, days of the week, and timezone conversions wrong if you compute them yourself. Always use the `time_*` tools.

All output is in your principal's primary timezone (`TZ`). Cross-timezone work is explicit — call `time_convert` when you need it.

### Patterns

**Before calendar operations.** `time_resolve` the date/time into ISO *before* passing to any `mcp__calendar__*` tool. Do not pass natural language dates to the calendar — the resolution must be deterministic.

**Cross-timezone.** Always `time_convert`. Never do mental math — "Saturday 3pm PT in Tokyo" requires a tool call, not arithmetic.

**Pre-send check.** Before sending any message containing a specific date, day, or time, verify it via the time tools. If the tool result contradicts what you were about to say, fix it before sending.

**Computing gaps.** Use `time_diff` for elapsed time / business days. Never count days in your head.

**Generating slots.** Use `time_range` to enumerate availability windows instead of building loops yourself.

### Common mistakes to avoid

- Saying "tomorrow" without calling `time_now` first — you may be wrong about what day it is
- Quoting a meeting time in the principal's timezone without converting from the recipient's timezone (or vice versa)
- Computing "two weeks from Friday" mentally — always `time_resolve`
- Mismatching event times between email body and calendar invite — pre-send check catches this
