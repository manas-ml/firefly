import { describe, expect, it } from "vitest";
import { chunkMessage } from "../src/telegram/chunk.ts";

function fencesBalanced(chunk: string): boolean {
  const fences = chunk.split("\n").filter((l) => /^\s*```/.test(l));
  return fences.length % 2 === 0;
}

describe("chunkMessage", () => {
  it("returns short text unchanged", () => {
    expect(chunkMessage("hello\n\nworld")).toEqual(["hello\n\nworld"]);
  });

  it("drops empty input", () => {
    expect(chunkMessage("   \n\n")).toEqual([]);
  });

  it("splits on paragraph boundaries and respects the limit", () => {
    const para = "word ".repeat(150).trim(); // ~750 chars
    const text = Array.from({ length: 12 }, (_, i) => `P${i} ${para}`).join("\n\n");
    const chunks = chunkMessage(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(4096);
    // Every paragraph stays whole.
    for (const c of chunks) for (const p of c.split("\n\n")) expect(p.startsWith("P")).toBe(true);
    expect(chunks.join("\n\n")).toBe(text);
  });

  it("splits a long paragraph on lines, then words", () => {
    const longLine = "abc ".repeat(3000);
    const chunks = chunkMessage(longLine);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(4096);
    expect(chunks.join(" ").replace(/\s+/g, " ").trim()).toBe(longLine.trim());
  });

  it("never breaks inside a code block without closing and reopening it", () => {
    const code = Array.from({ length: 400 }, (_, i) => `print("line ${i} of a long program")`).join("\n");
    const text = `Here is the script:\n\n\`\`\`python\n${code}\n\`\`\`\n\nDone.`;
    const chunks = chunkMessage(text);
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(4096);
      expect(fencesBalanced(c)).toBe(true);
    }
    const codeChunks = chunks.filter((c) => c.includes("print("));
    for (const c of codeChunks) expect(c.startsWith("```python\n") || c.includes("\n```python\n")).toBe(true);
    // All code lines survive in order.
    const lines = chunks.join("\n").split("\n").filter((l) => l.startsWith("print("));
    expect(lines).toEqual(code.split("\n"));
  });

  it("keeps blank lines inside code blocks", () => {
    const text = "```\na\n\nb\n```";
    expect(chunkMessage(text)).toEqual([text]);
  });

  it("closes an unterminated fence", () => {
    const chunks = chunkMessage("```js\nconsole.log(1)");
    expect(chunks).toEqual(["```js\nconsole.log(1)\n```"]);
  });

  it("hard-splits a single enormous code line", () => {
    const text = "```\n" + "x".repeat(10000) + "\n```";
    const chunks = chunkMessage(text);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(4096);
      expect(fencesBalanced(c)).toBe(true);
    }
  });
});
