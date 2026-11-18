/** Keep the head and tail of long tool output, with a marker in the middle. */
export function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const marker = (omitted: number) => `\n\n[... ${omitted} characters omitted ...]\n\n`;
  const budget = Math.max(0, max - marker(text.length).length);
  const head = Math.ceil(budget * 0.6);
  const tail = budget - head;
  return text.slice(0, head) + marker(text.length - head - tail) + (tail > 0 ? text.slice(text.length - tail) : "");
}

/**
 * Mark tool output as untrusted data. Any closing tag inside the content is
 * defused so the content can't end the block early and pose as instructions.
 */
export function wrapUntrusted(text: string): string {
  const safe = text.replace(/<\/?\s*tool_output/gi, (m) => m.replace("<", "&lt;"));
  return `<tool_output trust="untrusted">\n${safe}\n</tool_output>`;
}
