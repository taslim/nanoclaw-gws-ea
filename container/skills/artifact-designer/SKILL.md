---
name: artifact-designer
description: Design a page the principal opens from a link, such as a decision with options, an itinerary or event plan, a meeting or person brief, a week ahead, research with sources, a plan with owners and dates, a handover for someone looking after things, or a page for family or guests. Use when the material holds more options, days, facts or sources than read comfortably in a chat message, or when the principal will come back to it or forward it.
allowed-tools: Read, Write, Edit, Glob, Grep, mcp__nanoclaw__artifact_save, mcp__nanoclaw__artifact_read, mcp__nanoclaw__artifact_list, mcp__nanoclaw__artifact_share, mcp__nanoclaw__artifact_delete, mcp__nanoclaw__request_status
---

# Artifact designer

A page is for what a chat message can't hold well:

- options compared across several attributes;
- days with times and places;
- a set of facts the principal will scan;
- sources they may want to check;
- something they will come back to or pass on.

Opening it costs a tap, and sometimes a sign-in, so a short answer stays in the conversation. When you send a page, the message still carries the answer or the key point in a sentence or two. The link carries the depth.

## Who reads it, and where

The principal reads it first, usually on a phone and often between other things. They may read it again later on a larger screen, or forward it. On iPhone, Safari and Firefox, the page is shown without its scripts, so the static HTML is what they get.

The first phone screen therefore answers the question:

- **the title,** which is the answer, or the subject and its date;
- **a standfirst** of one or two sentences: the one thing to know, with its key qualification;
- **what to do about it,** if anything.

Everything below supports that, in the order the reader will use it.

## Shape the information

- **Start from the question.** Work out the reader's question and what they will do next. Separate facts, calculations, your judgment and unknowns before you write.
- **Put each detail where it is used:**
  - evidence beside the claim it supports;
  - the as-of time beside the price;
  - the deadline beside the decision;
  - the confirmation number in the entry it confirms.
- **Be exact about what they will act on:** times, amounts, codes, addresses and phone numbers. State uncertainty in words, where it applies.
- **Write dates absolutely.** Give each date with its weekday, in the principal's time zone, date style, currency and units. The page outlives "tomorrow". Name the time zone when a trip crosses one.
- **Write in the assistant's voice:** short, calm, specific, and leading with the answer. Talk about the principal's world: people, times, places, money and decisions. The page never describes itself, its tools, how it was made, or how to use it.
- **Use only real material.** Leave a section out rather than fill it. Never invent a source, a quote or a confidence level.

## Compositions

Arrange the page by the job. These are orders of information, not layouts.

| Job | Order |
| --- | --- |
| Decision | Recommendation; why, with its evidence; the options on the criteria this principal cares about; risks and unknowns; what happens on yes, and by when. |
| Options to choose from | The pick and its reason; the comparison; each option's details; hold and booking deadlines. |
| Itinerary or event | The essentials at a glance; day by day, anchored to times, with travel and gaps; contacts; what to do if plans change. |
| Meeting or person brief | Purpose and the outcome wanted; who they are, and their relationship to the principal; the history that matters; what they will raise; the principal's asks; logistics. |
| Week ahead | What matters this week; decisions due; each day's notable items; time that is kept. |
| Research | The answer; findings with their sources; detail on demand. |
| Plan | The goal and its date; steps with owners and states; risks. |
| Handover (a sitter, a house-sitter, a colleague covering) | What could go wrong and what to do about it; who to call; the schedule; the house or the details. |

## Audience

**A private page can be candid.** Include your recommendation, the trade-offs, and what you would watch.

**A page for other people is written for someone who was not in the conversation.** It holds what that audience needs and what the principal would share with them. Write around a private detail rather than leaving a hole. Say what this reader needs, such as when the principal is reachable, the way the principal would say it to them.

**Sign it in a small line at the end** when the page is clearly from the assistant, saying who prepared it and for whom. A page for guests speaks for the occasion, never as the principal.

## The look

**Most pages share one house look:** [starter.html](starter.html). It is a complete page whose stylesheet gives the type, spacing, light and dark modes, links, tables and print styles.

**Write semantic HTML into its `<main>`:** `h1`, a standfirst paragraph, `h2` sections, `p`, lists, `dl`, `table`, `details`, `time` and `code`. Set `lang` when the principal reads another language.

[elements.md](elements.md) has the shapes that need a pattern: key facts, options, comparison tables that stack on phones, day by day, steps, people, figures, sources and callouts. Add CSS only for what this page needs.

**Hierarchy comes from the order first,** then size, weight, grey and space. Colour, boxes and labels carry meaning:

- the accent marks a link, the recommended option, or focus;
- a state colour sits beside the word that names the state;
- a box holds the one thing not to miss.

An eyebrow label, a badge, a card, an icon, a large number or a gradient belongs only where it tells the reader something.

**Branch from the house look when the occasion asks for it:** a celebration or a page for guests, a visual explainer, or a page that follows a company's own look.

- **A lighter shift:** override a few tokens in a second `:root` rule, such as `--head: var(--serif)`, `--accent` or `--bg`.
- **A full departure:** write your own system. Keep what makes the house look work: one clear reading order, legible type at phone size, contrast in light and dark, and decoration that serves the subject.

## Interaction

The static page carries every fact. Native `details` and `#` links work everywhere.

Add a script only when a desktop reader gains something the page cannot otherwise give, such as trying their own numbers or narrowing dozens of rows. On phones the script never runs, and the viewer adds a note that controls are unavailable. The pattern is in elements.md.

## What the viewer allows

- **One self-contained file.** Inline styles, inline `<svg>` and inline scripts only. No remote files, fonts, frames or forms.
- **Images only when the picture informs,** and only as `data:` PNG, JPEG, GIF, WebP or AVIF.
- **Links:**
  - HTTPS links open through the viewer's source list, which takes a second tap. Link the few that matter, with text that says what they are.
  - `#` links jump within the page.
  - `tel:` and `mailto:` are refused, so write phone numbers and email addresses as text.
- **CSS:**
  - It cannot contain a backslash; type the character itself.
  - `url()` takes only `data:` or `#id`.
- **The save title** appears in the viewer's bar. Write it as a person would name the document. The page starts at its `h1`, with no header strip above it.

## Write it, then revise by editing

- **Start from the starter page:**
  - **With a shell,** `cp` starter.html to a new `.html` file under `/workspace/agent/`. Then replace `<title></title>` through `<main></main>` in one `Edit`.
  - **Without a shell,** `Write` the whole page, with the starter's stylesheet included unchanged.
- **Keep it lean.** A typical page is 8–20 KB; go larger only when density is the point. Skip comments.
- **Revise with `Edit`,** all changes in one pass, without re-reading text you just wrote. Rewrite the page only when its structure changes.
- **Match the effort to the change.** A small fix needs no fresh design thinking.

Save and share with the artifact tools as the resident instructions describe.

## Before you send

Read it once as the principal on a phone:

- the first screen answers the question;
- nothing is said twice;
- every number has its unit and basis;
- every date is absolute;
- no sentence describes the page;
- links are few and labelled;
- nothing depends on colour alone;
- a page for others reads well to someone outside the conversation.

**Look at the rendered page only when the layout is at risk:** your own CSS or a branch from the house look, a chart, or a table of five or more columns. With `agent-browser`:

1. Open `file:///workspace/agent/<file>.html`.
2. Run `set viewport 390 844` and screenshot.
3. Run `set viewport 1280 800` and screenshot again.
4. If you set your own colours, also check with `set media dark`.

Fix what you see. A page built from the starter and its elements needs only the read-through, so it can go straight away.
