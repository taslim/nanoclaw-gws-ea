/**
 * `value` as literal text inside a line of an agent's project document, so a
 * display name cannot open emphasis, a heading, a link or a tag in
 * instructions.
 */
export function escapeMarkdownInline(value: string): string {
  const special = new Set(['\\', '`', '*', '_', '{', '}', '[', ']', '<', '>', '#']);
  return [...value].map((character) => (special.has(character) ? `\\${character}` : character)).join('');
}
