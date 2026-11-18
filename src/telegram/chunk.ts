/**
 * Split a Markdown reply into Telegram-sized messages.
 *
 * Breaks on paragraph boundaries first, then lines, then words. A code block is
 * never broken without closing its fence in one chunk and reopening it (with the
 * same language) in the next.
 */

export const TELEGRAM_LIMIT = 4096;

interface Unit {
  /** Separator before this unit when joined to the previous one ("\n", "\n\n", ...). */
  sep: string;
  text: string;
  code?: { open: string; close: string; inner: string[] };
}

const FENCE_OPEN = /^\s*(`{3,}|~{3,})(.*)$/;

function toUnits(text: string): Unit[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const units: Unit[] = [];
  let sep = "";
  let para: string[] = [];
  let code: { marker: string; open: string; inner: string[] } | null = null;

  const flushPara = () => {
    if (para.length > 0) {
      units.push({ sep, text: para.join("\n") });
      sep = "\n";
      para = [];
    }
  };

  for (const line of lines) {
    if (code) {
      const m = line.match(/^\s*(`{3,}|~{3,})\s*$/);
      if (m && m[1]![0] === code.marker[0] && m[1]!.length >= code.marker.length) {
        units.push({
          sep,
          text: [code.open, ...code.inner, line].join("\n"),
          code: { open: code.open, close: line.trim(), inner: code.inner },
        });
        sep = "\n";
        code = null;
      } else {
        code.inner.push(line);
      }
      continue;
    }
    const open = line.match(FENCE_OPEN);
    if (open) {
      flushPara();
      code = { marker: open[1]!, open: line.trim(), inner: [] };
      continue;
    }
    if (line.trim() === "") {
      flushPara();
      if (units.length > 0) sep += "\n";
      continue;
    }
    para.push(line);
  }
  flushPara();
  if (code) {
    // Unclosed fence: close it so every chunk renders as code.
    const close = code.marker[0] === "~" ? "~~~" : "```";
    units.push({ sep, text: [code.open, ...code.inner, close].join("\n"), code: { open: code.open, close, inner: code.inner } });
  }
  return units;
}

function hardSplit(line: string, budget: number): string[] {
  const out: string[] = [];
  let rest = line;
  while (rest.length > budget) {
    let cut = rest.lastIndexOf(" ", budget);
    if (cut < budget / 2) cut = budget;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^ /, "");
  }
  out.push(rest);
  return out;
}

function packLines(lines: string[], budget: number): string[] {
  const pieces: string[] = [];
  let cur = "";
  for (const raw of lines) {
    for (const line of raw.length > budget ? hardSplit(raw, budget) : [raw]) {
      const candidate = cur === "" ? line : `${cur}\n${line}`;
      if (candidate.length <= budget) {
        cur = candidate;
      } else {
        if (cur !== "") pieces.push(cur);
        cur = line;
      }
    }
  }
  if (cur !== "") pieces.push(cur);
  return pieces;
}

function splitUnit(unit: Unit, limit: number): string[] {
  if (unit.code) {
    const { open, close, inner } = unit.code;
    const budget = limit - open.length - close.length - 2;
    return packLines(inner, budget).map((body) => `${open}\n${body}\n${close}`);
  }
  return packLines(unit.text.split("\n"), limit);
}

export function chunkMessage(text: string, limit = TELEGRAM_LIMIT): string[] {
  const chunks: string[] = [];
  let cur = "";
  for (const unit of toUnits(text)) {
    const candidate = cur === "" ? unit.text : `${cur}${unit.sep}${unit.text}`;
    if (candidate.length <= limit) {
      cur = candidate;
      continue;
    }
    if (cur !== "") chunks.push(cur);
    cur = "";
    if (unit.text.length <= limit) {
      cur = unit.text;
    } else {
      const pieces = splitUnit(unit, limit);
      chunks.push(...pieces.slice(0, -1));
      cur = pieces[pieces.length - 1] ?? "";
    }
  }
  if (cur !== "") chunks.push(cur);
  return chunks.map((c) => c.trimEnd()).filter((c) => c.trim() !== "");
}
