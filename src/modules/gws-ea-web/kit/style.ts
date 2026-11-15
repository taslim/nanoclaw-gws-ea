import { GEIST_FONT_FACE } from './font.generated.js';

/**
 * The look and accessibility baseline every principal page inherits. Main sends these links in chat, so a
 * phone is a primary surface: one column at phone width, 44px targets, visible focus, and status carried by
 * text rather than colour alone. Surfaces separate by tone; the violet accent is spent only on focus, the
 * current page and the assistant's own things, and the main action is ink, not accent.
 */
export const KIT_STYLE = `
${GEIST_FONT_FACE}
:root {
  color-scheme: light dark;
  --page: #fff;
  --surface: #fff;
  --fill: #f5f5f5;
  --fill-strong: #ebebeb;
  --line: #e8e8e8;
  --line-strong: #d6d6d6;
  --text: #161616;
  --muted: #6b6b6b;
  --faint: #8a8a8a;
  --ink: #161616;
  --ink-hover: #2e2e2e;
  --ink-text: #fff;
  --accent: #7c3aed;
  --accent-text: #6d28d9;
  --accent-soft: rgb(124 58 237 / .1);
  --ring: rgb(124 58 237 / .22);
  --success: #15803d;
  --success-soft: rgb(34 197 94 / .12);
  --warning: #a16207;
  --warning-soft: rgb(234 179 8 / .16);
  --danger: #b91c1c;
  --danger-soft: rgb(239 68 68 / .1);
  --danger-hover: #991b1b;
  --shadow-pop: 0 0 0 1px rgb(0 0 0 / .06), 0 4px 16px rgb(0 0 0 / .08), 0 12px 32px rgb(0 0 0 / .06);
  --ease-out: cubic-bezier(.23, 1, .32, 1);
}
@media (prefers-color-scheme: dark) {
  :root {
    --page: #0b0b0c;
    --surface: #141415;
    --fill: #1c1c1e;
    --fill-strong: #262628;
    --line: #232325;
    --line-strong: #333336;
    --text: #f2f2f2;
    --muted: #a1a1a6;
    --faint: #7c7c82;
    --ink: #f2f2f2;
    --ink-hover: #ffffff;
    --ink-text: #0b0b0c;
    --accent: #a78bfa;
    --accent-text: #c4b5fd;
    --accent-soft: rgb(167 139 250 / .14);
    --ring: rgb(167 139 250 / .3);
    --success: #4ade80;
    --success-soft: rgb(74 222 128 / .14);
    --warning: #facc15;
    --warning-soft: rgb(250 204 21 / .14);
    --danger: #f87171;
    --danger-soft: rgb(248 113 113 / .14);
    --danger-hover: #fca5a5;
    --shadow-pop: 0 0 0 1px rgb(255 255 255 / .08), 0 8px 28px rgb(0 0 0 / .5);
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--page);
  color: var(--text);
  font: 14px/1.55 "Geist", ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  letter-spacing: .003em;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
a { color: inherit; text-decoration: none; }
button, input { font: inherit; letter-spacing: inherit; color: inherit; }
button, a, input { -webkit-tap-highlight-color: transparent; }
button, a { touch-action: manipulation; }
button { cursor: pointer; }
button:disabled, a[aria-disabled="true"] { opacity: .55; cursor: wait; }
[hidden] { display: none !important; }
h1, h2, h3, p, ol { margin: 0; }
code { overflow-wrap: anywhere; }
.icon { width: 18px; height: 18px; flex-shrink: 0; vertical-align: middle; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }

/* Shell */
.shell {
  width: min(680px, calc(100% - 48px));
  margin-inline: auto;
  padding-block: 16px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 24px;
}
.shell-name { display: flex; align-items: center; gap: 10px; min-width: 0; font-size: 14px; font-weight: 600; letter-spacing: -.01em; }
.shell-name > span:last-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.shell-mark { display: grid; place-items: center; flex-shrink: 0; width: 28px; height: 28px; border-radius: 9px; background: var(--accent-soft); color: var(--accent-text); font-size: 12px; font-weight: 600; letter-spacing: 0; }
.shell-nav ul { display: flex; gap: 2px; margin: 0; padding: 0; list-style: none; }
.shell-nav a {
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  padding-inline: 12px;
  border-radius: 10px;
  color: var(--muted);
  font-size: 13px;
  font-weight: 500;
  transition: color .15s, background-color .15s;
}
.shell-nav li:last-child a { margin-right: -12px; }
.shell-nav a[aria-current="page"] { color: var(--text); }
.shell-nav a[aria-current="page"]::before { content: ""; width: 6px; height: 6px; margin-right: 8px; border-radius: 50%; background: var(--accent); }

main {
  width: min(680px, calc(100% - 48px));
  margin-inline: auto;
  padding-block: 40px 80px;
  outline: none;
}
main[data-width="narrow"] { width: min(520px, calc(100% - 48px)); }

/* Headings */
h1 { font-size: 28px; font-weight: 600; line-height: 1.2; letter-spacing: -.025em; overflow-wrap: anywhere; }
h2 { font-size: 14px; font-weight: 600; line-height: 1.4; letter-spacing: -.005em; }
.page-heading { display: flex; justify-content: space-between; align-items: center; gap: 16px; margin-bottom: 28px; }
.page-heading > div { min-width: 0; }
.page-heading > .button { flex-shrink: 0; }
.page-metadata { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 8px; color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
.section-title { margin: 0 0 8px; padding-inline: 4px; color: var(--muted); font-size: 13px; font-weight: 500; }
* + .section { margin-top: 32px; }
.back-link { display: inline-flex; align-items: center; gap: 6px; min-height: 44px; margin: -12px 0 12px -2px; color: var(--muted); font-size: 13px; font-weight: 500; transition: color .15s; }
.back-link { max-width: 100%; }
.back-link > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.back-link .icon { width: 16px; height: 16px; }

/* Buttons */
.button {
  position: relative;
  min-height: 44px;
  padding: 10px 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border: 0;
  border-radius: 12px;
  font-size: 14px;
  font-weight: 500;
  line-height: 1.3;
  letter-spacing: -.005em;
  white-space: nowrap;
  transition: background-color .15s, color .15s, box-shadow .15s, transform .16s var(--ease-out);
}
.button .icon { width: 16px; height: 16px; margin-left: -2px; }
.button:active:not(:disabled) { transform: scale(.97); }
.button-primary { background: var(--ink); color: var(--ink-text); }
.button-secondary { background: var(--fill); color: var(--text); }
.button-quiet { background: transparent; color: var(--muted); }
.button-danger { background: transparent; color: var(--danger); }
.dialog-actions .button-danger { background: var(--danger); color: #fff; }
.icon-button { width: 44px; padding: 0; color: var(--muted); background: transparent; }
.icon-button .icon { margin: 0; width: 20px; height: 20px; }
.icon-button[aria-expanded="true"] { background: var(--fill-strong); color: var(--text); }

/* Fields */
.field + .field { margin-top: 20px; }
.field label { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 6px; font-size: 13px; font-weight: 500; }
.optional { color: var(--faint); font-size: 12px; font-weight: 400; }
.field-hint { display: block; margin-top: 6px; color: var(--muted); font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; }
input {
  width: 100%;
  min-width: 0;
  min-height: 44px;
  padding: 10px 14px;
  background: var(--fill);
  border: 1px solid transparent;
  border-radius: 12px;
  font-size: 16px;
  line-height: 1.4;
  transition: border-color .15s, box-shadow .15s, background-color .15s;
}
input::placeholder { color: var(--faint); }
input:focus { outline: none; border-color: var(--accent); background: var(--surface); box-shadow: 0 0 0 3px var(--ring); }
.form-actions { display: flex; flex-direction: row-reverse; justify-content: flex-start; gap: 8px; margin-top: 28px; }

/* Lists: one card of rows, each row inset with its own hover */
.list { margin: 0; padding: 4px; list-style: none; background: var(--surface); border: 1px solid var(--line); border-radius: 16px; }
.row { position: relative; display: flex; align-items: center; gap: 12px; min-height: 60px; padding: 10px 8px 10px 14px; border-radius: 12px; transition: background-color .15s; }
.row + .row::before { content: ""; position: absolute; top: -2px; left: 14px; right: 14px; border-top: 1px solid var(--line); }
a.row { padding-right: 12px; }
.row-main { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 2px; }
.row-title { font-size: 14px; font-weight: 500; line-height: 1.4; letter-spacing: -.01em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row-sub { color: var(--muted); font-size: 13px; line-height: 1.45; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row > .badge, .row > .menu, .row > form, .row > .row-note { flex-shrink: 0; }
.row-chevron { width: 16px; height: 16px; color: var(--faint); }
.row-note { color: var(--muted); font-size: 13px; padding-right: 6px; }

/* Badges: status is said in words, the tint only repeats it */
.badge { display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 10px; border-radius: 999px; background: var(--fill); color: var(--muted); font-size: 12px; font-weight: 500; white-space: nowrap; }
.badge::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; opacity: .9; }
.badge-success { background: var(--success-soft); color: var(--success); }
.badge-warning { background: var(--warning-soft); color: var(--warning); }
.badge-accent { background: var(--accent-soft); color: var(--accent-text); }
.badge-plain { padding-inline: 9px; }
.badge-plain::before { display: none; }

/* Notices and outcomes */
.notice { display: flex; gap: 10px; padding: 12px 14px; border-radius: 12px; background: var(--fill); color: var(--muted); font-size: 13px; line-height: 1.5; }
.notice .icon { width: 16px; height: 16px; margin-top: 2px; color: var(--faint); }
.notice strong { color: var(--text); font-weight: 500; }
* + .notice, .notice + * { margin-top: 20px; }
#outcome { display: flex; align-items: flex-start; gap: 10px; margin: 0 0 24px; padding: 12px 14px; border-radius: 12px; background: var(--success-soft); color: var(--success); font-size: 13px; font-weight: 500; line-height: 1.5; overflow-wrap: anywhere; }
#outcome[data-error="true"] { background: var(--danger-soft); color: var(--danger); }
#outcome:empty { display: none; }
#outcome a { margin-left: 4px; color: inherit; text-decoration: underline; text-underline-offset: 2px; }

/* Empty states */
.empty-state { display: flex; flex-direction: column; align-items: center; gap: 16px; padding: 64px 24px; text-align: center; background: var(--fill); border-radius: 16px; }
.empty-state h2 { font-size: 15px; font-weight: 600; }
.empty-icon { display: grid; place-items: center; width: 44px; height: 44px; border-radius: 14px; background: var(--surface); color: var(--muted); box-shadow: 0 0 0 1px var(--line); }
.empty-icon .icon { width: 20px; height: 20px; }

/* Menus */
.menu { position: relative; display: inline-block; }
.menu [role="menu"] { position: absolute; right: 0; top: calc(100% + 4px); z-index: 10; min-width: 184px; padding: 4px; background: var(--surface); border-radius: 14px; box-shadow: var(--shadow-pop); transform-origin: top right; transition: opacity .15s var(--ease-out), transform .2s var(--ease-out); }
.menu [role="menuitem"] { display: flex; align-items: center; width: 100%; min-height: 44px; padding: 8px 12px; background: transparent; border: 0; border-radius: 10px; color: var(--text); font-size: 14px; text-align: left; }
.menu [role="menuitem"]:focus-visible { outline: none; background: var(--fill); }
.menu [role="menuitem"][data-danger] { color: var(--danger); }
.menu form + form:has([data-danger]), .menu a + form:has([data-danger]) { margin-top: 4px; padding-top: 4px; border-top: 1px solid var(--line); }

/* Dialogs */
dialog { width: min(400px, calc(100% - 32px)); max-height: calc(100svh - 48px); overflow: auto; overscroll-behavior: contain; padding: 24px; background: var(--surface); color: var(--text); border: 0; border-radius: 20px; box-shadow: var(--shadow-pop); transition: opacity .2s var(--ease-out), transform .25s var(--ease-out); }
dialog::backdrop { background: rgb(0 0 0 / .4); transition: opacity .2s var(--ease-out); }
dialog h2 { font-size: 17px; font-weight: 600; letter-spacing: -.015em; }
dialog p { margin-top: 8px; color: var(--muted); font-size: 14px; line-height: 1.55; overflow-wrap: anywhere; }
.dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 24px; }

/* Entrances only: exits are immediate, and nothing animates under reduced motion */
@starting-style {
  .menu [role="menu"]:not([hidden]) { opacity: 0; transform: translateY(-4px) scale(.97); }
  dialog[open] { opacity: 0; transform: scale(.96); }
  dialog[open]::backdrop { opacity: 0; }
}

:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.row:focus-visible { outline-offset: -2px; }

@media (hover: hover) and (pointer: fine) {
  .shell-nav a:hover, .back-link:hover { color: var(--text); }
  .button-primary:hover { background: var(--ink-hover); }
  .button-secondary:hover { background: var(--fill-strong); }
  .button-quiet:hover, .icon-button:hover { background: var(--fill); color: var(--text); }
  .button-danger:hover { background: var(--danger-soft); }
  .dialog-actions .button-danger:hover { background: var(--danger-hover); }
  a.row:hover { background: var(--fill); }
  .menu [role="menuitem"]:hover { background: var(--fill); transition: none; }
  input:hover:not(:focus) { border-color: var(--line-strong); }
}

@media (max-width: 600px) {
  .shell, main, main[data-width="narrow"] { width: calc(100% - 32px); }
  .shell { padding-block: 10px 0; }
  .shell-nav { width: 100%; }
  .shell-nav ul { margin-left: -12px; }
  .shell-nav li:last-child a { margin-right: 0; }
  main { padding-block: 24px 48px; }
  h1 { font-size: 24px; }
  .page-heading { margin-bottom: 24px; }
  .form-actions .button { flex: 1; white-space: normal; text-align: center; }
  .empty-state { padding: 48px 20px; }
  dialog { padding: 20px; }
  .dialog-actions .button { flex: 1; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition-property: opacity, color, background-color, border-color, box-shadow !important; scroll-behavior: auto !important; }
  .button:active:not(:disabled) { transform: none; }
  @starting-style {
    .menu [role="menu"]:not([hidden]) { transform: none; }
    dialog[open] { transform: none; }
  }
}
@media (prefers-contrast: more) {
  :root { --line: var(--line-strong); --muted: var(--text); }
  .list, .notice, .empty-state, input { border: 1px solid var(--line-strong); }
}
`;
