/**
 * Minimal Markdown -> Telegram HTML. Telegram's HTML mode only needs <, > and &
 * escaped, which is far less fragile than MarkdownV2. Anything Telegram still
 * rejects is resent as plain text by the caller.
 */

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

function formatInline(text: string): string {
  // Split out inline code first so nothing inside it is formatted.
  return text
    .split(/(`[^`\n]+`)/)
    .map((seg, i) => {
      if (i % 2 === 1) return `<code>${escapeHtml(seg.slice(1, -1))}</code>`;
      let s = escapeHtml(seg);
      s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label: string, url: string) => {
        return `<a href="${escapeAttr(url.replace(/&amp;/g, "&"))}">${label}</a>`;
      });
      s = s.replace(/\*\*([^*\n]+?)\*\*/g, "<b>$1</b>");
      s = s.replace(/(^|[^\w])__([^_\n]+?)__(?=[^\w]|$)/g, "$1<b>$2</b>");
      s = s.replace(/(^|[^\w*])\*([^*\s][^*\n]*?)\*(?=[^\w*]|$)/g, "$1<i>$2</i>");
      s = s.replace(/(^|[^\w])_([^_\s][^_\n]*?)_(?=[^\w]|$)/g, "$1<i>$2</i>");
      s = s.replace(/~~([^~\n]+?)~~/g, "<s>$1</s>");
      return s;
    })
    .join("");
}

export function markdownToTelegramHtml(md: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let code: { marker: string; lang: string; lines: string[] } | null = null;

  for (const line of lines) {
    if (code) {
      const close = line.match(/^\s*(`{3,}|~{3,})\s*$/);
      if (close && close[1]![0] === code.marker[0] && close[1]!.length >= code.marker.length) {
        out.push(renderCode(code.lang, code.lines));
        code = null;
      } else {
        code.lines.push(line);
      }
      continue;
    }
    const open = line.match(/^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/);
    if (open) {
      code = { marker: open[1]!, lang: open[2] ?? "", lines: [] };
      continue;
    }
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.*)$/);
    if (heading) {
      out.push(`<b>${formatInline(heading[1]!)}</b>`);
      continue;
    }
    const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (bullet) {
      out.push(`${bullet[1]}• ${formatInline(bullet[2]!)}`);
      continue;
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      out.push("──────");
      continue;
    }
    out.push(formatInline(line));
  }
  if (code) out.push(renderCode(code.lang, code.lines));
  return out.join("\n");
}

function renderCode(lang: string, lines: string[]): string {
  const cls = lang ? ` class="language-${escapeAttr(lang)}"` : "";
  return `<pre><code${cls}>${escapeHtml(lines.join("\n"))}</code></pre>`;
}
