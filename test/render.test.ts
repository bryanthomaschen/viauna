import { describe, expect, it } from "vitest";
import { cleanHtml, textToHtml, wrapDocument } from "../server/mail/render.ts";

const opts = { allowRemote: false, cidUrl: (cid: string) => `/cid/${cid}` };
const clean = (html: string, o = opts) => cleanHtml(html, o).body;

describe("cleanHtml: script execution is impossible", () => {
  const vectors = [
    "<script>alert(1)</script>",
    '<img src=x onerror="alert(1)">',
    '<a href="javascript:alert(1)">x</a>',
    '<a href="JaVaScRiPt:alert(1)">x</a>',
    '<a href="&#106;avascript:alert(1)">x</a>',
    '<a href=" javascript:alert(1)">x</a>',
    '<iframe src="https://evil.example"></iframe>',
    '<object data="x.swf"></object><embed src="x.swf">',
    '<svg onload="alert(1)"><circle r=10 /></svg>',
    '<math><mi xlink:href="javascript:alert(1)">x</mi></math>',
    '<form action="https://evil.example"><input name=p><button>go</button></form>',
    '<div onclick="alert(1)" onmouseover="alert(1)">hover</div>',
    '<meta http-equiv="refresh" content="0;url=https://evil.example">',
    '<base href="https://evil.example/">',
    '<link rel="stylesheet" href="https://evil.example/x.css">',
    '<img src="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">',
    "<body onload=alert(1)>",
    '<details open ontoggle="alert(1)">x</details>',
    "<noscript><p title=\"</noscript><img src=x onerror=alert(1)>\"></noscript>",
    '<template><script>alert(1)</script></template>',
  ];
  for (const v of vectors) {
    it(`neutralises ${v.slice(0, 50)}`, () => {
      const out = clean(v).toLowerCase();
      expect(out).not.toMatch(/<script|<iframe|<object|<embed|<svg|<math|<form|<input|<meta|<base|<link/);
      expect(out).not.toMatch(/\son[a-z]+\s*=/);
      expect(out).not.toMatch(/javascript:/);
      expect(out).not.toMatch(/data:text\/html/);
    });
  }

  it("keeps ordinary email formatting", () => {
    const out = clean('<table width="600" bgcolor="#fff"><tr><td style="color:red" align="center"><b>Hi</b> <a href="https://example.com">link</a></td></tr></table>');
    expect(out).toContain('<table width="600" bgcolor="#fff">');
    expect(out).toContain('style="color:red"');
    expect(out).toContain('href="https://example.com"');
  });

  it("opens links in a new tab without a referrer", () => {
    expect(clean('<a href="https://example.com">x</a>')).toContain('rel="noopener noreferrer nofollow"');
    expect(clean('<a href="https://example.com">x</a>')).toContain('target="_blank"');
  });
});

describe("cleanHtml: remote content", () => {
  it("blocks remote images until allowed, and says it did", () => {
    const r = cleanHtml('<img src="https://tracker.example/p.gif">', opts);
    expect(r.remoteContent).toBe(true);
    expect(r.body).not.toContain("tracker.example");
    const allowed = cleanHtml('<img src="https://tracker.example/p.gif">', { ...opts, allowRemote: true });
    expect(allowed.body).toContain("https://tracker.example/p.gif");
  });

  it("notices CSS-loaded remote content", () => {
    expect(cleanHtml('<div style="background:url(https://t.example/a.png)">x</div>', opts).remoteContent).toBe(true);
    expect(cleanHtml("<style>@import url(https://t.example/a.css);</style>", opts).remoteContent).toBe(true);
  });

  it("rewrites cid: images to our endpoint", () => {
    expect(clean('<img src="cid:logo@x">')).toContain('src="/cid/logo@x"');
  });

  it("keeps style blocks (most HTML mail needs them)", () => {
    expect(clean("<style>.a{color:red}</style><p class=a>x</p>")).toContain("<style>.a{color:red}</style>");
  });

  it("the iframe CSP forbids scripts and remote loads", () => {
    const doc = wrapDocument("<p>x</p>", { allowRemote: false, plain: false, origin: "'self'" });
    expect(doc).toContain("script-src 'none'");
    expect(doc).toMatch(/img-src 'self' data:;/);
    expect(doc).not.toMatch(/img-src[^;]*https:/);
    const open = wrapDocument("<p>x</p>", { allowRemote: true, plain: false, origin: "'self'" });
    expect(open).toMatch(/img-src 'self' data: https: http:/);
    expect(open).toContain("script-src 'none'");
  });
});

describe("quoted replies collapse", () => {
  it("wraps a trailing gmail_quote in <details>", () => {
    const out = clean('<div>New text</div><div class="gmail_quote">On Mon, A wrote:<blockquote>old</blockquote></div>');
    expect(out).toMatch(/<div>New text<\/div><details class="viauna-quote"><summary[^>]*>•••<\/summary><div class="gmail_quote">/);
  });

  it("leaves an inline quote alone when the reply continues after it", () => {
    const out = clean('<blockquote type="cite">question?</blockquote><p>answer</p>');
    expect(out).not.toContain("<details");
  });

  it("collapses the quoted tail of plain text", () => {
    const html = textToHtml("Sounds good.\n\nOn Tue, Bob wrote:\n> Lunch?\n> Noon?\n");
    expect(html).toMatch(/^<div class="viauna-plain">Sounds good\.<\/div><details/);
    expect(html).toContain("&gt; Lunch?");
  });

  it("escapes and linkifies plain text", () => {
    const html = textToHtml("<b>not bold</b> see https://example.com/a?b=1 or mail ann@example.org");
    expect(html).toContain("&lt;b&gt;not bold&lt;/b&gt;");
    expect(html).toContain('<a href="https://example.com/a?b=1">');
    expect(html).toContain('<a href="mailto:ann@example.org">');
  });
});

describe("editorHtml (reopening a draft)", () => {
  it("drops remote images, keeps text, embeds the draft's own inline images", async () => {
    const { parseMessage, editorHtml } = await import("../server/mail/render.ts");
    const raw = Buffer.from(
      [
        "Content-Type: multipart/related; boundary=b",
        "",
        "--b",
        "Content-Type: text/html; charset=utf-8",
        "",
        '<p>Hi</p><img src="https://t.example/pixel.gif"><img src="cid:img1@x"><img src="x" onerror="alert(1)"><style>p{}</style>',
        "--b",
        "Content-Type: image/png",
        "Content-ID: <img1@x>",
        "Content-Transfer-Encoding: base64",
        "",
        "iVBORw0KGgo=",
        "--b--",
        "",
      ].join("\r\n"),
    );
    const html = editorHtml(await parseMessage(raw));
    expect(html).toContain("<p>Hi</p>");
    expect(html).not.toContain("t.example");
    expect(html).toContain('src="data:image/png;base64,');
    expect(html).not.toMatch(/onerror|<style/);
  });
});
