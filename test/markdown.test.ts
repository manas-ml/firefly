import { describe, expect, it } from "vitest";
import { parseBlocks, parseInline } from "../dashboard/src/markdown.ts";

describe("dashboard markdown", () => {
  it("parses inline code, bold, italic and links", () => {
    expect(parseInline("a `x<y` **b** *i* [d](https://x.y/?a=1)")).toEqual([
      { type: "text", text: "a " },
      { type: "code", text: "x<y" },
      { type: "text", text: " " },
      { type: "bold", text: "b" },
      { type: "text", text: " " },
      { type: "italic", text: "i" },
      { type: "text", text: " " },
      { type: "link", text: "d", href: "https://x.y/?a=1" },
    ]);
  });
  it("only links http(s) URLs; HTML stays plain text", () => {
    expect(parseInline("[x](javascript:alert(1))")).toEqual([{ type: "text", text: "[x](javascript:alert(1))" }]);
    expect(parseInline("<img src=x onerror=alert(1)>")).toEqual([{ type: "text", text: "<img src=x onerror=alert(1)>" }]);
  });
  it("keeps snake_case and math-like asterisks alone", () => {
    expect(parseInline("my_var_name 2*3*4")).toEqual([{ type: "text", text: "my_var_name 2*3*4" }]);
  });
  it("parses code fences, headings, bullets and paragraphs", () => {
    const blocks = parseBlocks("# Title\nhello\nworld\n\n- one\n- two\n\n```py\nprint(1)\n\nprint(2)\n```\nafter");
    expect(blocks.map((b) => b.type)).toEqual(["heading", "paragraph", "bullet", "bullet", "code", "paragraph"]);
    expect(blocks[4]).toEqual({ type: "code", lang: "py", text: "print(1)\n\nprint(2)" });
  });
  it("closes an unterminated fence", () => {
    expect(parseBlocks("```\nx")).toEqual([{ type: "code", lang: "", text: "x" }]);
  });
});
