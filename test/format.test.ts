import { describe, expect, it } from "vitest";
import { markdownToTelegramHtml } from "../src/telegram/format.ts";

describe("markdownToTelegramHtml", () => {
  it("escapes HTML", () => {
    expect(markdownToTelegramHtml("a < b && c > d")).toBe("a &lt; b &amp;&amp; c &gt; d");
  });

  it("formats inline styles", () => {
    expect(markdownToTelegramHtml("**bold** and *it* and `x<y`")).toBe("<b>bold</b> and <i>it</i> and <code>x&lt;y</code>");
  });

  it("leaves snake_case alone", () => {
    expect(markdownToTelegramHtml("use my_var_name here")).toBe("use my_var_name here");
  });

  it("does not format inside inline code", () => {
    expect(markdownToTelegramHtml("`**not bold**`")).toBe("<code>**not bold**</code>");
  });

  it("renders code blocks with language", () => {
    expect(markdownToTelegramHtml("```py\nif a < b:\n    pass\n```")).toBe(
      '<pre><code class="language-py">if a &lt; b:\n    pass</code></pre>',
    );
  });

  it("renders links, headings and bullets", () => {
    expect(markdownToTelegramHtml("# Title\n- [docs](https://x.y/?a=1&b=2)")).toBe(
      '<b>Title</b>\n• <a href="https://x.y/?a=1&amp;b=2">docs</a>',
    );
  });

  it("ignores non-http links", () => {
    expect(markdownToTelegramHtml("[x](javascript:alert(1))")).toBe("[x](javascript:alert(1))");
  });
});
