import { GEIST_FONT_FACE } from './font.generated.js';

/**
 * The look and accessibility baseline every principal page inherits. Main sends these links in chat, so a
 * phone is a primary surface: one column at phone width, 44px targets, visible focus, and status carried by
 * text rather than colour alone.
 */
export const KIT_STYLE = `
${GEIST_FONT_FACE}
:root {
  color-scheme: light dark;
  --bg: #fafafa;
  --panel: #fff;
  --subtle: #f2f2f4;
  --hover: #f8f7fc;
  --text: #252529;
  --muted: #6b6b73;
  --line: #e5e5e9;
  --accent: #7c3aed;
  --accent-hover: #6d28d9;
  --accent-ink: #fff;
  --danger: #b42318;
  --danger-bg: #fff1f0;
  --success: #17633e;
  --success-bg: #f0faf4;
  --danger-ink: #fff;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #1a1a1a;
    --panel: #222225;
    --subtle: #2b2b30;
    --hover: #29262f;
    --text: #eeeef0;
    --muted: #aaaab3;
    --line: #36363c;
    --accent: #c4b5fd;
    --accent-hover: #d0c4ff;
    --accent-ink: #241342;
    --danger: #fda29b;
    --danger-bg: #352422;
    --success: #9ee3bb;
    --success-bg: #1f3027;
    --danger-ink: #2b1411;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 15px/1.5 "Geist", ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  -webkit-font-smoothing: antialiased;
}
a { color: inherit; text-decoration: none; }
button, input { font: inherit; }
button, a, input { -webkit-tap-highlight-color: transparent; }
button, a { touch-action: manipulation; }
button { cursor: pointer; }
button:disabled, a[aria-disabled="true"] { opacity: .6; cursor: wait; }
[hidden] { display: none !important; }
.shell {
  width: min(720px, calc(100% - 48px));
  margin-inline: auto;
  padding-top: 20px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 4px 24px;
  border-bottom: 1px solid var(--line);
}
.shell-name { min-width: 0; margin: 0; font-size: 14px; font-weight: 600; letter-spacing: -.01em; overflow-wrap: anywhere; }
.shell-nav ul { display: flex; flex-wrap: wrap; gap: 4px; margin: 0; padding: 0; list-style: none; }
.shell-nav a {
  position: relative;
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  padding-inline: 10px;
  color: var(--muted);
  font-size: 13px;
  transition: color .15s;
}
.shell-nav li:last-child a { margin-right: -10px; }
.shell-nav a:hover { color: var(--text); }
.shell-nav a[aria-current="page"] { color: var(--text); font-weight: 500; }
.shell-nav a[aria-current="page"]::after { content: ""; position: absolute; left: 10px; right: 10px; bottom: -1px; height: 2px; border-radius: 2px; background: var(--accent); }
.shell-nav a:focus-visible { outline-offset: -2px; }
main {
  width: min(720px, calc(100% - 48px));
  margin-inline: auto;
  padding-block: 56px 72px;
  outline: none;
}
main[data-width="narrow"] { width: min(560px, calc(100% - 48px)); }
h1, h2, p { margin: 0; }
code { overflow-wrap: anywhere; }
h1 {
  font-size: 32px;
  font-weight: 600;
  line-height: 1.15;
  letter-spacing: -.035em;
  overflow-wrap: anywhere;
}
h2 { font-size: 15px; font-weight: 600; line-height: 1.4; }
.icon { width: 18px; height: 18px; flex-shrink: 0; vertical-align: middle; }
.page-heading {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 24px;
  margin-bottom: 32px;
}
.page-heading > div { min-width: 0; }
.page-heading > .button { flex-shrink: 0; margin-top: -3px; }
.page-metadata { margin-top: 12px; }
.button {
  min-height: 44px;
  padding: 10px 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border: 1px solid transparent;
  border-radius: 9px;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.4;
  white-space: nowrap;
  transition: background-color .15s, border-color .15s;
}
.button .icon { width: 16px; height: 16px; }
.button-primary { background: var(--accent); color: var(--accent-ink); box-shadow: 0 1px 2px rgb(0 0 0/.04); }
.button-primary:hover { background: var(--accent-hover); }
.button-secondary { background: var(--panel); border-color: var(--line); color: var(--text); }
.button-secondary:hover { background: var(--subtle); }
.button-danger { background: transparent; color: var(--danger); }
.button-danger:hover { background: var(--danger-bg); }
.back-link {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
  margin: -20px 0 24px;
  color: var(--muted);
  font-size: 13px;
}
.back-link .icon { width: 15px; height: 15px; }
.back-link:hover { color: var(--text); }
input {
  width: 100%;
  min-width: 0;
  min-height: 46px;
  padding: 11px 12px;
  background: var(--panel);
  color: var(--text);
  border: 1px solid var(--line);
  border-radius: 8px;
  font-size: 16px;
  line-height: 1.4;
  transition: border-color .15s;
}
input::placeholder { color: var(--muted); opacity: .8; }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
.form-panel { max-width: 620px; }
.form-panel form { padding: 28px; }
.field + .field { margin-top: 24px; }
.field label { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; font-size: 13px; font-weight: 500; }
.optional { color: var(--muted); font-size: 11px; font-weight: 400; }
.field-hint { display: block; margin-top: 8px; color: var(--muted); font-size: 12px; font-weight: 400; line-height: 1.5; overflow-wrap: anywhere; }
.form-actions { display: flex; align-items: center; flex-direction: row-reverse; gap: 10px; margin-top: 32px; padding-top: 24px; border-top: 1px solid var(--line); }
#outcome { margin: 0 0 24px; padding: 12px 16px; border: 1px solid var(--line); border-radius: 9px; color: var(--success); background: var(--success-bg); font-size: 13px; overflow-wrap: anywhere; }
#outcome[data-error="true"] { color: var(--danger); background: var(--danger-bg); }
#outcome:empty { display: none; }
.empty-state { display: flex; flex-direction: column; align-items: center; gap: 20px; padding: 72px 24px; text-align: center; border: 1px dashed var(--line); border-radius: 12px; }
.empty-state h2 { font-size: 15px; font-weight: 500; }
.empty-icon { width: 44px; height: 44px; display: grid; place-items: center; border-radius: 12px; background: var(--subtle); color: var(--muted); }
.empty-icon .icon { width: 20px; height: 20px; }
.menu { position: relative; display: inline-block; }
.menu [role="menu"] { position: absolute; right: 0; top: calc(100% + 6px); z-index: 10; min-width: 200px; padding: 6px; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; box-shadow: 0 12px 40px rgb(0 0 0/.14); }
.menu [role="menuitem"] { display: flex; align-items: center; width: 100%; min-height: 44px; padding: 10px 12px; background: transparent; border: 0; border-radius: 8px; color: var(--text); font-size: 13px; text-align: left; }
.menu [role="menuitem"]:hover, .menu [role="menuitem"]:focus-visible { background: var(--subtle); }
.menu [role="menuitem"][data-danger] { color: var(--danger); }
dialog { width: min(420px, calc(100% - 32px)); max-height: calc(100svh - 48px); overflow: auto; overscroll-behavior: contain; background: var(--panel); color: var(--text); border: 1px solid var(--line); border-radius: 16px; padding: 28px; box-shadow: 0 24px 80px rgb(0 0 0/.18); }
dialog::backdrop { background: rgb(0 0 0/.42); backdrop-filter: blur(3px); }
dialog h2 { font-size: 20px; letter-spacing: -.025em; }
dialog p { margin-top: 12px; font-size: 13px; color: var(--muted); line-height: 1.6; overflow-wrap: anywhere; }
.dialog-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 28px; }
.dialog-actions .button-danger { background: var(--danger); color: var(--danger-ink); }
.dialog-actions .button-danger:hover { filter: brightness(.95); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
@media (max-width: 600px) {
  .shell, main, main[data-width="narrow"] { width: calc(100% - 40px); }
  .shell { padding-top: 0; }
  main { padding-block: 16px 36px; }
  h1 { font-size: 28px; }
  .page-heading { gap: 16px; margin-bottom: 28px; }
  .page-heading > .button { padding-inline: 12px; margin-top: -5px; }
  .back-link { margin: -12px 0 20px; }
  .form-panel form { padding: 24px 20px; }
  .field + .field { margin-top: 20px; }
  .form-actions { flex-direction: row-reverse; gap: 8px; }
  .form-actions .button { flex: 1; }
  .empty-state { padding: 56px 20px; }
  dialog { padding: 24px; }
  .dialog-actions .button { flex: 1; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition: none !important; scroll-behavior: auto !important; }
}
`;
