// Shows sanitized message HTML in a sandboxed iframe: no scripts (no allow-scripts),
// same-origin only so this page can size it to its content and route mailto: links
// to our own composer. Links open in a new tab.
import { useEffect, useRef, useState } from "react";

/** Message documents whose clicks and keys are already handled. */
const listened = new WeakSet<Document>();

export function EmailFrame({ html, plain, onMailto }: { html: string; plain: boolean; onMailto: (href: string) => void }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(48);
  const mailto = useRef(onMailto);
  mailto.current = onMailto;

  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    let observer: ResizeObserver | null = null;
    const setup = () => {
      const doc = frame.contentDocument;
      if (!doc?.documentElement) return;
      if (document.documentElement.dataset.theme === "dark") doc.documentElement.classList.add(plain ? "dark" : "dark-card");
      const measure = () => {
        const h = Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight ?? 0);
        setHeight(Math.min(h + 2, 200_000));
      };
      measure();
      observer?.disconnect();
      observer = new ResizeObserver(measure);
      observer.observe(doc.documentElement);
      if (doc.body) observer.observe(doc.body);
      for (const img of Array.from(doc.images)) if (!img.complete) img.addEventListener("load", measure, { once: true });
      // Setup can run again on the same document (the effect re-runs without a reload):
      // the listeners below go on once.
      if (listened.has(doc)) return;
      listened.add(doc);
      doc.addEventListener("click", (e) => {
        const a = (e.target as Element)?.closest?.("a");
        const href = a?.getAttribute("href") ?? "";
        if (/^mailto:/i.test(href)) {
          e.preventDefault();
          mailto.current(href);
        }
      });
      // Keys pressed after clicking into the message reach this page's shortcuts and
      // command menu, as if the frame weren't there.
      doc.addEventListener("keydown", (e) => {
        const copy = new KeyboardEvent("keydown", {
          key: e.key, code: e.code, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, repeat: e.repeat,
          bubbles: true, cancelable: true,
        });
        frame.dispatchEvent(copy);
        if (copy.defaultPrevented) e.preventDefault();
      });
      // <details> toggles ("•••") change the height without resizing the body in some engines.
      doc.addEventListener("toggle", measure, true);
    };
    frame.addEventListener("load", setup);
    if (frame.contentDocument?.readyState === "complete") setup();
    return () => {
      frame.removeEventListener("load", setup);
      observer?.disconnect();
    };
  }, [html, plain]);

  return (
    <iframe
      ref={ref}
      className="msg-frame"
      title="Message body"
      srcDoc={html}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      style={{ height }}
    />
  );
}
