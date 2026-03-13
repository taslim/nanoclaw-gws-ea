# Google Docs Procedure

Read this before creating or editing a Google Doc.

## Workflow

1. **Research and draft** — do all research, outlining, and writing as a `.md` file in `/workspace/group/`. Get the content right before touching Docs
2. **Import to Google Doc** — use `import_to_google_doc` with the markdown file path (`file:///workspace/group/xyz-draft.md`). This converts headings, bold, italic, lists, tables, and links into native Google Docs formatting automatically
3. **Share and link** — share edit access with your principal's email (see profile.md), then send them the link
4. **Clean up** — delete the local markdown file after successful import. If import fails, keep it so nothing is lost

## Editing Existing Docs

For modifications after import, use the Docs tools directly:
- `modify_doc_text` — insert/replace text with formatting (bold, italic, links, colors)
- `update_paragraph_style` — change headings, alignment, spacing
- `insert_doc_elements` / `create_table_with_data` — add tables, lists, page breaks
- Call `inspect_doc_structure` first to get accurate character indices — they shift as you edit

## What NOT to Do

- Don't use `create_doc` with markdown content — it treats everything as literal plain text
- Don't skip the markdown draft — writing directly into Docs with formatting tool calls is slow and error-prone

## Verification

After creating a doc, silently verify:
- [ ] Headings render as headings, not literal `#` characters
- [ ] No raw formatting markers (`**`, `- `, `` ` ``) appear as visible text
- [ ] Tables render as actual tables, not pipe-delimited text
- [ ] Doc is shared with your principal's email with edit access
