import { useQuery } from "@tanstack/react-query";
import { Maximize2, Minimize2, Minus, Paperclip, SquareArrowOutUpRight, Trash2, Type, X } from "lucide-react";
import { type DragEvent, useRef, useState } from "react";
import { useAccount } from "../lib/account";
import { api } from "../lib/api";
import { type ComposeState, addFiles, close, composes, discard, popOut, send, update } from "../lib/compose";
import { fileSize } from "../lib/format";
import { navigate } from "../lib/router";
import { IconButton } from "./common";
import { EditorArea, FormatBar, useMailEditor } from "./Editor";
import { EmailFrame } from "./EmailFrame";
import { RecipientField } from "./RecipientField";

export function ComposeDock() {
  const acct = useAccount();
  const list = composes.use((l) => l.filter((c) => c.placement === "dock" && c.account === acct.index));
  const maximized = list.find((c) => c.maximized && !c.minimized);
  return (
    <>
      {maximized && <div className="compose-scrim" onClick={() => update(maximized.id, { maximized: false }, false)} />}
      <div className="compose-dock">
        {list.map((c) => (
          <ComposeWindow key={c.id} c={c} />
        ))}
      </div>
    </>
  );
}

function title(c: ComposeState): string {
  if (c.subject.trim()) return c.subject;
  return c.mode === "forward" ? "Forward" : c.mode === "reply" || c.mode === "replyAll" ? "Reply" : "New Message";
}

function ComposeWindow({ c }: { c: ComposeState }) {
  const cls = `compose ${c.minimized ? "minimized" : ""} ${c.maximized && !c.minimized ? "maximized" : ""}`;
  return (
    <section className={cls} aria-label={title(c)}>
      <div className="compose-title" onClick={() => update(c.id, { minimized: !c.minimized }, false)}>
        <span className="t">{title(c)}</span>
        <IconButton label={c.minimized ? "Restore" : "Minimise"} onClick={(e) => { e.stopPropagation(); update(c.id, { minimized: !c.minimized }, false); }}>
          <Minus size={16} />
        </IconButton>
        <IconButton label={c.maximized ? "Exit full screen" : "Full screen"} onClick={(e) => { e.stopPropagation(); update(c.id, { maximized: !c.maximized, minimized: false }, false); }}>
          {c.maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </IconButton>
        <IconButton label="Save & close" onClick={(e) => { e.stopPropagation(); void close(c.id); }}>
          <X size={16} />
        </IconButton>
      </div>
      {!c.minimized && <ComposeBody c={c} inline={false} />}
    </section>
  );
}

export function InlineCompose({ compose }: { compose: ComposeState }) {
  return (
    <section className="inline-compose" aria-label={title(compose)}>
      <ComposeBody c={compose} inline />
    </section>
  );
}

function QuotePreview({ c }: { c: ComposeState }) {
  const acct = useAccount();
  const ref = c.quote!.ref;
  const q = useQuery({
    queryKey: ["message", acct.index, ref.mailboxId, ref.uid, false],
    queryFn: () => api.message(acct.index, ref, false),
    staleTime: Infinity,
  });
  return (
    <div className="quote-preview">
      <div>{c.quote!.header}</div>
      {q.data && <EmailFrame html={q.data.html} plain={q.data.plain} onMailto={() => {}} />}
    </div>
  );
}

function ComposeBody({ c, inline }: { c: ComposeState; inline: boolean }) {
  const acct = useAccount();
  const [showFormat, setShowFormat] = useState(!inline);
  const [showQuote, setShowQuote] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  // Mounted again when an inline reply pops out, so start from what has been typed.
  const editor = useMailEditor(c.html, "", (html) => update(c.id, { html }), inline || c.to.length > 0);

  const onDrop = (e: DragEvent) => {
    setDragging(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length) {
      e.preventDefault();
      void addFiles(c.id, files);
    }
  };
  const doSend = () =>
    void send(c.id, (threadId) => threadId && navigate(`/u/${c.account}/inbox/${threadId}`));

  const fromSelect = acct.identities.length > 1 && (
    <div className="field">
      <span className="field-label">From</span>
      <select value={c.from} onChange={(e) => update(c.id, { from: e.target.value })} aria-label="From">
        {acct.identities.map((i) => (
          <option key={i.address} value={i.address}>{i.name ? `${i.name} <${i.address}>` : i.address}</option>
        ))}
      </select>
    </div>
  );
  const ccLinks = (
    <span className="field-links">
      {!c.showCc && <button type="button" onClick={() => update(c.id, { showCc: true }, false)}>Cc</button>}
      {!c.showBcc && <button type="button" onClick={() => update(c.id, { showBcc: true }, false)}>Bcc</button>}
    </span>
  );

  return (
    <div
      style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, position: "relative" }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={onDrop}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          doSend();
        }
      }}
    >
      {dragging && <div className="drop-overlay" style={inline ? { inset: 0 } : undefined}>Drop files here</div>}
      <div className="compose-fields">
        {fromSelect}
        <RecipientField label="To" account={c.account} value={c.to} onChange={(to) => update(c.id, { to })} autoFocus={!c.to.length} right={ccLinks} />
        {c.showCc && <RecipientField label="Cc" account={c.account} value={c.cc} onChange={(cc) => update(c.id, { cc })} />}
        {c.showBcc && <RecipientField label="Bcc" account={c.account} value={c.bcc} onChange={(bcc) => update(c.id, { bcc })} />}
        {(!inline || c.mode === "forward") && (
          <div className="field">
            <input className="plain" placeholder="Subject" aria-label="Subject" value={c.subject} onChange={(e) => update(c.id, { subject: e.target.value })} />
          </div>
        )}
      </div>
      <EditorArea editor={editor} />
      {c.quote && (
        <div style={{ padding: "0 16px" }}>
          <button type="button" className="quote-toggle" title="Show trimmed content" aria-expanded={showQuote} onClick={() => setShowQuote(!showQuote)}>•••</button>
          {showQuote && <QuotePreview c={c} />}
        </div>
      )}
      {c.attachments.length > 0 && (
        <div className="compose-atts">
          {c.attachments.map((a) => (
            <div key={a.key} className="compose-att">
              {a.uploading && <span className="spinner" />}
              <span className="n">{a.filename}</span>
              <span className="s">({fileSize(a.size)})</span>
              <IconButton label={`Remove ${a.filename}`} size="xs" onClick={() => update(c.id, { attachments: c.attachments.filter((x) => x.key !== a.key) })}>
                <X size={14} />
              </IconButton>
            </div>
          ))}
        </div>
      )}
      {showFormat && <FormatBar editor={editor} />}
      <div className="compose-actions">
        <button type="button" className="btn btn-primary send-btn" onClick={doSend} disabled={c.status === "sending"}>
          {c.status === "sending" ? "Sending…" : "Send"}
        </button>
        <IconButton label="Formatting options" className={showFormat ? "on" : ""} onClick={() => setShowFormat(!showFormat)}>
          <Type size={18} />
        </IconButton>
        <IconButton label="Attach files" onClick={() => fileInput.current?.click()}>
          <Paperclip size={18} />
        </IconButton>
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => { void addFiles(c.id, Array.from(e.target.files ?? [])); e.target.value = ""; }} />
        {inline && (
          <IconButton label="Pop out reply" onClick={() => popOut(c.id)}>
            <SquareArrowOutUpRight size={18} />
          </IconButton>
        )}
        <span className="grow" />
        <span className="status" aria-live="polite">
          {c.status === "saving" ? "Saving…" : c.status === "saved" ? "Draft saved" : c.status === "error" ? <span style={{ color: "var(--danger)" }}>{c.error}</span> : ""}
        </span>
        <IconButton label="Discard draft" onClick={() => void discard(c.id)}>
          <Trash2 size={18} />
        </IconButton>
      </div>
    </div>
  );
}
