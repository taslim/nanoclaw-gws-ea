# Weekly Review

Friday review of key projects — matters with a `tracking_file`. These are the long-running, high-stakes workstreams that warrant a detailed weekly check-in. Routine email matters and one-off tasks are not in scope — the sweep handles those.

Your principal scans this over the weekend to plan the week ahead.

Use `mcp__time__*` tools for ALL date/time computation. Never calculate dates yourself.

## Execution

1. Load all matters via `list_matters` — filter to those with a `tracking_file` (use `get_matter` to check)
2. For each, read the tracking file for detailed context, then check linked artifacts (email threads, calendar events, tasks) for recent activity
3. Update the tracking file contents with current status and blockers, and refresh the matter's context summary
4. Compose one message with what your principal needs to see. Send via `mcp__nanoclaw__send_message`, even if everything is green

## What to Surface

In the message to your principal:
- Stalled or blocked matters get a one-line status each — what's wrong and what you recommend
- Healthy matters get skipped. If everything is healthy, say so
- If a matter has been waiting or active for multiple weeks with no progress, escalate the framing — it's drifting, not just "needs attention"
- Matters that should be resolved but aren't — surface the question

## Decisions Needed

If any matter is blocked on your principal's input, surface it here — numbered, with your recommendation and deadline.

If nothing needs a decision, skip this section entirely.

## Tone

Write like a weekly staff memo, not a dashboard dump. Judgment-forward — don't just list what's overdue, say what matters and what you recommend. Terse, direct, scannable in 2 minutes.

## Output

Your final response text must be completely empty — output nothing. All communication happens exclusively through MCP tools.
