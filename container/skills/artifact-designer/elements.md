# Elements

Shapes that are hard to describe in words. Each uses classes from the starter page's stylesheet; most need no added CSS. Placeholders (`…`) stand for real material. Read only the element you need.

## Opening

Use for every page. The `h1` is the answer, or the subject with its date. The paragraph after it is the standfirst: one or two sentences giving the one thing to know, with its key qualification.

```html
<h1>… <time>…</time></h1>
<p>…</p>
<p class="meta">…</p>
```

Wrapping a date in `time` keeps it on one line. The meta line holds only what changes how the page is read, such as an as-of time for prices. Leave it out when nothing qualifies.

## Key facts

Use for what the reader acts on: when, where, who, cost, confirmation, deadline. It fits at the top of an itinerary, an option or a brief.

```html
<dl>
  <dt>…</dt><dd>…</dd>
  <dt>…</dt><dd><time>…</time></dd>
  <dt>…</dt><dd><code>…</code></dd>
</dl>
```

Use `code` for confirmation numbers and identifiers; one tap selects the whole code. Put phone numbers in `<span class="nowrap">` so they never break across lines. A `dd` may hold a second line in `<small>`. Keep `dt`/`dd` pairs as direct children, without wrapper `div`s.

## Options side by side

Use for two to four options that each need a sentence or a few facts. They sit in columns on desktop and stack on phones on their own.

```html
<div class="cols">
  <section class="pick">
    <h3>…</h3>
    <p><strong>Recommended.</strong> …</p>
    <dl>…</dl>
  </section>
  <section>
    <h3>…</h3>
    <p>…</p>
    <dl>…</dl>
  </section>
</div>
```

Give every option the same facts, in the same order and units, so they compare line by line. `.pick` marks the recommendation with the accent rule; the word "Recommended" carries the meaning.

## Comparison table

Use for three or more options across three or more attributes. On phones, `stack` turns each row into a labelled block, so nothing scrolls sideways.

```html
<table class="stack">
  <caption>…</caption>
  <thead><tr><th scope="col">…</th><th scope="col" class="num">…</th><th scope="col">…</th></tr></thead>
  <tbody>
    <tr class="pick"><th scope="row">… <small>Recommended</small></th><td data-label="…" class="num">…</td><td data-label="…">…</td></tr>
    <tr><th scope="row">…</th><td data-label="…" class="num">…</td><td data-label="…">…</td></tr>
  </tbody>
</table>
```

Each `data-label` repeats its column heading. Right-align numbers with `num`, and put units in the heading rather than every cell. Order rows by the recommendation or by the criterion that matters most, not by source order. Show an unknown value as "Unknown" or "Not stated", never as a blank.

For data that is truly wide, such as many numeric columns, keep the table whole inside a labelled scroller, with the caption outside it:

```html
<p id="t1-title"><strong>…</strong></p>
<div class="scroll wide" role="region" aria-labelledby="t1-title" tabindex="0"><table>…</table></div>
```

## Day by day

Use for itineraries, a week ahead and runs of show. Each day's heading stays in view while its entries scroll.

```html
<section>
  <h3 class="sticky">…</h3>
  <ol class="timeline">
    <li><time>…</time><div><strong>…</strong><br><small>…</small></div></li>
    <li><time>…</time><div>…</div></li>
  </ol>
</section>
```

Use local time at the place, and name the time zone when the trip crosses one. Show gaps that matter (travel, buffer, check-in windows) as entries. Put the address and the confirmation number in the entry they belong to. A week ahead keeps what matters each day, not every event.

## Steps and owners

Use for a plan or a set of things in motion. For a few steps, an `ol` is enough: the step, its state in a word, and its owner and date on the small line. For many, use a comparison table with columns for step, owner, due date and state.

```html
<ol>
  <li><strong>…</strong> <span class="good">…</span><br><small>…</small></li>
  <li><strong>…</strong> <span class="warn">…</span><br><small>…</small></li>
</ol>
```

Use one vocabulary for state across the page. Colour adds to the word; it never replaces it.

## People

Use for a meeting or event brief: who they are to the principal, and what matters about them for this encounter.

```html
<section>
  <h3>…</h3>
  <p class="meta">…</p>
  <p>…</p>
  <dl><dt>…</dt><dd>…</dd></dl>
</section>
```

Lead with the relationship and the context that changes the conversation, such as what they want or the last exchange. A biography comes after, if at all.

## Figures

Use a figure when a number or a trend is the point. Write the sentence that says what it means first.

One number, with its basis:

```html
<p><span class="stat">…</span> …</p>
```

A few values compared:

```html
<div class="bars" role="img" aria-label="…">
  <span>…</span><span class="track"><span style="width:…%"></span></span><span class="num">…</span>
  <span>…</span><span class="track"><span style="width:…%"></span></span><span class="num">…</span>
</div>
```

A trend, as inline SVG with the latest value stated in text:

```html
<svg viewBox="0 0 120 32" width="120" height="32" role="img" aria-label="…"><polyline fill="none" stroke="currentColor" stroke-width="1.5" points="…"/></svg>
```

Bars start at zero. Every value is printed, not left to hover. Put units and the period in the label or the sentence.

## Sources and as-of

Use where a claim, price or availability came from somewhere the reader may want to check. Link the source in the sentence, with text that says what it is. When there are many, list them at the end:

```html
<h2>Sources</h2>
<ol>
  <li><a href="https://…">…</a> <small>…, <time>…</time></small></li>
</ol>
```

Put the as-of time beside the fact that can change, not in a footer. Cite only what the page used.

## The one thing not to miss

Use for a decision the principal must make by a date, or a risk that changes the plan. Use one on a page; two at the very most.

```html
<div class="callout">
  <p><strong>…</strong> …</p>
</div>
```

The bold lead-in states the decision or risk and its date. The rest says what happens on each answer.

Add `alert` (`class="callout alert"`) when ignoring it could cause harm or real loss, such as an allergy and what to do, or a safety step. It belongs near the top of the page.

## More detail

Use for method, fine print, full lists and the reasoning behind a number: anything a careful reader may want and the main reader will skip.

```html
<details>
  <summary>…</summary>
  <p>…</p>
</details>
```

Keep anything the decision depends on outside `details`. The browser's print view shows only the summary of a closed `details`.

## What-if table and the optional script

Use a precomputed table when the reader wants to see how a choice changes the outcome. It works on every device. Mark the current assumption with `.pick`.

A script earns its place only when a desktop reader will try their own numbers, or filter more rows than a reader can scan. The static page still carries the table. Keep the controls in a hidden container and reveal it after the script has attached its listeners and drawn the first result:

```html
<div id="try" hidden>…labelled inputs…<output id="result" aria-live="polite"></output></div>
<script>
  /* read inputs, compute, write #result */
  document.getElementById('try').hidden = false;
</script>
```

Phones and Safari never run it, and the viewer then notes that controls are unavailable. Put the hidden container after the content it enhances, so revealing it does not push the reading position.
