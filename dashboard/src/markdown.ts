/**
 * A tiny, safe Markdown subset for chat messages. It produces data (blocks and
 * inline tokens) that React renders as elements, so there is no HTML injection:
 * agent output and tool results can never become markup.
 */

export type Inline =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "bold"; text: string }
  | { type: "italic"; text: string }
  | { type: "link"; text: string; href: string };

export type Block =
  | { type: "code"; lang: string; text: string }
  | { type: "heading"; inline: Inline[] }
  | { type: "bullet"; inline: Inline[] }
  | { type: "paragraph"; inline: Inline[] };

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+?\*\*)|(\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))|((?<![\w*])\*[^*\s][^*\n]*?\*(?![\w*]))/g;

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const i = m.index ?? 0;
    if (i > last) out.push({ type: "text", text: text.slice(last, i) });
    const tok = m[0];
    if (m[1]) out.push({ type: "code", text: tok.slice(1, -1) });
    else if (m[2]) out.push({ type: "bold", text: tok.slice(2, -2) });
    else if (m[3]) {
      const split = tok.indexOf("](");
      out.push({ type: "link", text: tok.slice(1, split), href: tok.slice(split + 2, -1) });
    } else out.push({ type: "italic", text: tok.slice(1, -1) });
    last = i + tok.length;
  }
  if (last < text.length) out.push({ type: "text", text: text.slice(last) });
  return out;
}

export function parseBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let code: { marker: string; lang: string; lines: string[] } | null = null;
  let para: string[] = [];

  const flush = () => {
    if (para.length) blocks.push({ type: "paragraph", inline: parseInline(para.join("\n")) });
    para = [];
  };

  for (const line of lines) {
    if (code) {
      const close = line.match(/^\s*(`{3,}|~{3,})\s*$/);
      if (close && close[1]![0] === code.marker[0] && close[1]!.length >= code.marker.length) {
        blocks.push({ type: "code", lang: code.lang, text: code.lines.join("\n") });
        code = null;
      } else code.lines.push(line);
      continue;
    }
    const open = line.match(/^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/);
    if (open) {
      flush();
      code = { marker: open[1]!, lang: open[2] ?? "", lines: [] };
      continue;
    }
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.*)$/);
    if (heading) {
      flush();
      blocks.push({ type: "heading", inline: parseInline(heading[1]!) });
      continue;
    }
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    if (bullet) {
      flush();
      blocks.push({ type: "bullet", inline: parseInline(bullet[1]!) });
      continue;
    }
    if (line.trim() === "") flush();
    else para.push(line);
  }
  if (code) blocks.push({ type: "code", lang: code.lang, text: code.lines.join("\n") });
  flush();
  return blocks;
}
