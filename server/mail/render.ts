// Turning an untrusted message into something safe to show. Three layers, each enough
// on its own to stop script execution:
//
//   1. sanitize-html removes scripts, event handlers, forms, frames and dangerous URLs;
//   2. the result is shown in an <iframe sandbox> WITHOUT allow-scripts;
//   3. the iframe document carries its own CSP: no scripts, no remote loads unless
//      the user has allowed images — which also defeats tracking pixels, CSS
//      background beacons and @import, even if layer 1 missed something.
import { type ParsedMail, simpleParser } from "mailparser";
import sanitizeHtml from "sanitize-html";
import { parseHTML } from "linkedom";

export interface RenderedAttachment {
  index: number;
  filename: string;
  contentType: string;
  size: number;
  /** An inline image shown in the body rather than listed as an attachment. */
  inline: boolean;
}

export interface Rendered {
  /** A full HTML document for the iframe's srcdoc. */
  html: string;
  plain: boolean;
  remoteContent: boolean;
  attachments: RenderedAttachment[];
  unsubscribe: { url?: string; mailto?: string; oneClick: boolean } | null;
}

export function parseMessage(raw: Buffer): Promise<ParsedMail> {
  return simpleParser(raw, {
    keepCidLinks: true,
    skipTextToHtml: true,
    skipTextLinks: true,
    skipHtmlToText: false,
    maxHtmlLengthToParse: 10 * 1024 * 1024,
  });
}

const ALLOWED_TAGS = [
  "a", "abbr", "address", "article", "aside", "b", "bdi", "bdo", "big", "blockquote", "br", "caption", "center",
  "cite", "code", "col", "colgroup", "dd", "del", "details", "dfn", "div", "dl", "dt", "em", "figcaption", "figure",
  "font", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "i", "img", "ins", "kbd", "li", "main",
  "mark", "nav", "ol", "p", "picture", "pre", "q", "s", "samp", "section", "small", "span", "strike", "strong",
  "style", "sub", "summary", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "time", "tr", "tt", "u", "ul",
  "var", "wbr",
];

const COMMON_ATTRS = [
  "style", "class", "id", "dir", "lang", "title", "role", "align", "valign", "width", "height", "bgcolor", "border",
  "cellpadding", "cellspacing", "colspan", "rowspan", "nowrap", "color", "face", "size", "type", "start", "summary",
  "abbr", "headers", "scope", "span", "datetime", "cite", "open", "aria-label", "aria-hidden", "name",
];

const SANITIZE: sanitizeHtml.IOptions = {
  allowedTags: ALLOWED_TAGS,
  allowedAttributes: {
    "*": COMMON_ATTRS,
    a: [...COMMON_ATTRS, "href"],
    img: [...COMMON_ATTRS, "src", "alt"],
  },
  allowedSchemes: ["http", "https", "mailto", "tel"],
  allowedSchemesByTag: { img: ["http", "https", "cid", "data"] },
  allowedSchemesAppliedToAttributes: ["href", "src", "cite"],
  allowProtocolRelative: false,
  // <style> is needed by nearly every HTML email. It can't run code, and the iframe
  // CSP stops it from loading anything remote.
  allowVulnerableTags: true,
  disallowedTagsMode: "discard",
  nonTextTags: ["script", "textarea", "option", "noscript", "title", "template", "iframe", "object", "svg", "math"],
  parseStyleAttributes: false,
};

/** Sanitized HTML with nothing rewritten, for quoting an original in an outgoing reply. */
export function sanitizeForQuote(html: string): string {
  return sanitizeHtml(html, SANITIZE);
}

const MAX_EMBEDDED_IMAGE = 2 * 1024 * 1024;

/**
 * A saved draft's HTML, made safe to load into the composer on the main page (where
 * images load directly): sanitized, remote images dropped so tracking pixels in a
 * quoted newsletter don't fire, and the draft's own inline images embedded as data:
 * URLs, which survive the next save (the composer turns them back into cid parts).
 */
export function editorHtml(parsed: ParsedMail): string {
  const source = typeof parsed.html === "string" && parsed.html.trim() ? parsed.html : escapeText(parsed.text ?? "");
  const { document } = parseHTML(`<!doctype html><html><body>${sanitizeHtml(source, SANITIZE)}</body></html>`);
  for (const el of document.querySelectorAll("style")) el.remove();
  for (const img of document.querySelectorAll("img")) {
    const src = img.getAttribute("src") ?? "";
    if (/^cid:/i.test(src)) {
      const cid = src.slice(4).replace(/^<|>$/g, "");
      const att = parsed.attachments.find((a) => a.cid?.replace(/^<|>$/g, "") === cid);
      if (att && /^image\/(png|jpe?g|gif|webp)$/i.test(att.contentType) && att.content.length <= MAX_EMBEDDED_IMAGE) {
        img.setAttribute("src", `data:${att.contentType};base64,${att.content.toString("base64")}`);
        continue;
      }
    } else if (/^data:image\/(png|jpe?g|gif|webp);/i.test(src)) {
      continue;
    }
    img.remove();
  }
  return document.body.innerHTML;
}

export function escapeText(text: string): string {
  return escapeHtml(text).replace(/\r?\n/g, "<br>");
}

const REMOTE_URL = /url\(\s*['"]?\s*(https?:)?\/\//i;

/** Markers after which the rest of the container is the quoted original. */
const SIBLING_RUN = new Set(["#divRplyFwdMsg", "#appendonsend", ".moz-cite-prefix"]);

/** Selectors for the quoted original in replies, by mailer. */
const QUOTE_SELECTORS = [
  ".gmail_quote",
  "blockquote[type=cite]",
  ".moz-cite-prefix",
  "#divRplyFwdMsg",
  "#appendonsend",
  ".yahoo_quoted",
  ".protonmail_quote",
  "div[name=messageReplySection]",
  "#mail-editor-reference-message-container",
  ".zmail_extra",
];

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function linkify(escaped: string): string {
  return escaped.replace(/\b(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]])|\b([\w.+-]+@[\w-]+(\.[\w-]+)+)\b/g, (m, url, email) => {
    const href = url ? url : `mailto:${email}`;
    return `<a href="${href}">${m}</a>`;
  });
}

function quoteBlock(inner: string): string {
  return `<details class="viauna-quote"><summary title="Show trimmed content" aria-label="Show trimmed content">•••</summary>${inner}</details>`;
}

/** Plain text → HTML, collapsing the trailing quoted reply. */
export function textToHtml(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  // Find where a trailing run of quoted lines starts (with its "On … wrote:" header).
  let cut = lines.length;
  let i = lines.length - 1;
  while (i >= 0 && (lines[i].trim() === "" || lines[i].startsWith(">"))) i--;
  const quotedTail = lines.slice(i + 1).some((l) => l.startsWith(">"));
  if (quotedTail) {
    cut = i + 1;
    if (i >= 0 && /wrote:\s*$|schrieb:\s*$|a écrit\s*:\s*$|escribió:\s*$/i.test(lines[i])) cut = i;
    else if (i >= 1 && /wrote:\s*$/i.test(lines[i - 1] + " " + lines[i])) cut = i - 1;
  } else {
    const fwd = lines.findIndex((l) => /^-{3,}\s*(original message|forwarded message)/i.test(l.trim()));
    if (fwd > 0) cut = fwd;
  }
  const body = linkify(escapeHtml(lines.slice(0, cut).join("\n").replace(/\n+$/, "")));
  const tail = cut < lines.length ? quoteBlock(`<div class="viauna-plain">${linkify(escapeHtml(lines.slice(cut).join("\n")))}</div>`) : "";
  return `<div class="viauna-plain">${body}</div>${tail}`;
}

interface HtmlOptions {
  allowRemote: boolean;
  cidUrl: (cid: string) => string;
}

export function cleanHtml(html: string, opts: HtmlOptions): { body: string; remoteContent: boolean } {
  const clean = sanitizeHtml(html, SANITIZE);
  const { document } = parseHTML(`<!doctype html><html><head></head><body>${clean}</body></html>`);
  let remote = false;

  for (const a of document.querySelectorAll("a")) {
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener noreferrer nofollow");
  }

  for (const img of document.querySelectorAll("img")) {
    const src = img.getAttribute("src") ?? "";
    if (/^cid:/i.test(src)) {
      img.setAttribute("src", opts.cidUrl(src.slice(4).replace(/^<|>$/g, "")));
    } else if (/^https?:/i.test(src)) {
      remote = true;
      if (!opts.allowRemote) {
        img.removeAttribute("src");
        img.setAttribute("data-viauna-blocked", "");
      }
    } else if (!/^data:image\/(png|jpe?g|gif|webp|bmp);/i.test(src)) {
      img.removeAttribute("src");
    }
  }

  for (const el of document.querySelectorAll("[style]")) {
    if (REMOTE_URL.test(el.getAttribute("style") ?? "")) remote = true;
  }
  for (const style of document.querySelectorAll("style")) {
    const css = style.textContent ?? "";
    if (REMOTE_URL.test(css) || /@import/i.test(css)) remote = true;
  }

  collapseQuote(document);
  return { body: document.body.innerHTML, remoteContent: remote };
}

function hasContentAfter(node: Element): boolean {
  let el: Node | null = node;
  while (el && el.parentNode && el.nodeName !== "BODY") {
    let sib = el.nextSibling;
    while (sib) {
      if ((sib.textContent ?? "").trim() || (sib as Element).querySelector?.("img")) return true;
      sib = sib.nextSibling;
    }
    el = el.parentNode;
  }
  return false;
}

/** Wraps the trailing quoted original in a <details> — "•••" that works without script. */
function collapseQuote(document: Document) {
  for (const selector of QUOTE_SELECTORS) {
    const found = document.querySelector(selector);
    if (!found || found.closest("details")) continue;
    const start: Element = found;
    const nodes: Node[] = [];
    if (SIBLING_RUN.has(selector)) {
      // These mark where the quote starts (Outlook's header block, Thunderbird's
      // "On … wrote:" line): the original is everything after them.
      if (selector === "#divRplyFwdMsg" && start.previousElementSibling?.nodeName === "HR") nodes.push(start.previousElementSibling);
      for (let n: Node | null = start; n; n = n.nextSibling) nodes.push(n);
    } else {
      nodes.push(start);
    }
    const last = nodes[nodes.length - 1] as Element;
    if (hasContentAfter(last)) continue;
    const details = document.createElement("details");
    details.setAttribute("class", "viauna-quote");
    const summary = document.createElement("summary");
    summary.setAttribute("title", "Show trimmed content");
    summary.textContent = "•••";
    details.appendChild(summary);
    start.parentNode!.insertBefore(details, nodes[0]);
    for (const node of nodes) details.appendChild(node);
    return;
  }
}

const BASE_CSS = `
html,body{margin:0;padding:0;background:transparent}
body{font-family:Roboto,"Helvetica Neue",Arial,sans-serif;font-size:14px;line-height:1.5;color:#1f1f1f;overflow-wrap:break-word;word-wrap:break-word}
html.dark body.viauna-text{color:#e3e3e3}
html.dark-card body{padding:12px 16px}
html.dark body.viauna-text a{color:#a8c7fa}
img{max-width:100%;height:auto}
img[data-viauna-blocked]{display:none}
pre{white-space:pre-wrap}
a{color:#0b57d0}
.viauna-plain{white-space:pre-wrap;font-family:inherit}
blockquote{margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex}
details.viauna-quote{margin:8px 0}
details.viauna-quote>summary{list-style:none;display:inline-block;cursor:pointer;user-select:none;line-height:8px;height:10px;padding:0 6px 4px;border-radius:6px;background:#e8eaed;color:#444;font-size:13px;letter-spacing:1px;outline:none}
details.viauna-quote>summary::-webkit-details-marker{display:none}
details.viauna-quote>summary:hover{background:#dadce0}
details.viauna-quote[open]>summary{margin-bottom:8px}
html.dark details.viauna-quote>summary{background:#3c4043;color:#e3e3e3}
`;

export function wrapDocument(body: string, opts: { allowRemote: boolean; plain: boolean; origin: string }): string {
  const remote = opts.allowRemote ? " https: http:" : "";
  const csp = [
    "default-src 'none'",
    `img-src ${opts.origin} data:${remote}`,
    `style-src 'unsafe-inline'${remote}`,
    `font-src data:${remote}`,
    "media-src 'none'",
    "script-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"><base target="_blank"><style>${BASE_CSS}</style></head><body class="${opts.plain ? "viauna-text" : "viauna-html"}">${body}</body></html>`;
}

function unsubscribeInfo(parsed: ParsedMail): Rendered["unsubscribe"] {
  // mailparser folds List-* headers into one structured "list" header.
  const list = parsed.headers.get("list") as
    | { unsubscribe?: { url?: string; mail?: string }; "unsubscribe-post"?: { name?: string } }
    | undefined;
  const entry = list?.unsubscribe;
  if (!entry) return null;
  const url = entry.url && /^https:\/\//i.test(entry.url) ? entry.url : undefined;
  const mailto = entry.mail ? `mailto:${entry.mail}` : undefined;
  if (!url && !mailto) return null;
  return { url, mailto, oneClick: !!url && /one-click/i.test(list?.["unsubscribe-post"]?.name ?? "") };
}

export interface RenderOptions {
  allowRemote: boolean;
  origin: string;
  cidUrl: (cid: string) => string;
}

export function attachmentList(parsed: ParsedMail, html: string | null): RenderedAttachment[] {
  return parsed.attachments.map((a, index) => {
    const cid = a.cid?.replace(/^<|>$/g, "");
    const referenced = !!cid && !!html && html.includes(cid);
    return {
      index,
      filename: a.filename || (a.contentType === "message/rfc822" ? "message.eml" : `attachment-${index + 1}`),
      contentType: a.contentType,
      size: a.size,
      inline: referenced && a.contentType.startsWith("image/"),
    };
  });
}

export function render(parsed: ParsedMail, opts: RenderOptions): Rendered {
  const html = typeof parsed.html === "string" && parsed.html.trim() ? parsed.html : null;
  let body: string;
  let remote = false;
  if (html) {
    const cleaned = cleanHtml(html, opts);
    body = cleaned.body;
    remote = cleaned.remoteContent;
  } else {
    body = textToHtml(parsed.text ?? "");
  }
  return {
    html: wrapDocument(body, { allowRemote: opts.allowRemote, plain: !html, origin: opts.origin }),
    plain: !html,
    remoteContent: remote,
    attachments: attachmentList(parsed, html),
    unsubscribe: unsubscribeInfo(parsed),
  };
}
