import { X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { Address } from "../lib/types";
import { Avatar, useDebounced } from "./common";

const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

/** "Ann <ann@x.org>, bob@y.org; Carol Doe <c@z.net>" → addresses. */
export function parseAddresses(text: string): Address[] {
  const out: Address[] = [];
  for (const raw of text.split(/[,;\n]+/)) {
    const part = raw.trim();
    if (!part) continue;
    const m = part.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
    if (m) out.push({ name: m[1].trim() || undefined, address: m[2].trim().toLowerCase() });
    else out.push({ address: part.replace(/^mailto:/i, "").toLowerCase() });
  }
  return out;
}

export function RecipientField({
  label,
  account,
  value,
  onChange,
  autoFocus,
  right,
}: {
  label: string;
  account: number;
  value: Address[];
  onChange: (next: Address[]) => void;
  autoFocus?: boolean;
  right?: ReactNode;
}) {
  const [text, setText] = useState("");
  const [active, setActive] = useState(0);
  const [focused, setFocused] = useState(false);
  const [suggestions, setSuggestions] = useState<{ address: string; name: string | null }[]>([]);
  const q = useDebounced(text.trim(), 120);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    if (!q || q.length < 1) {
      setSuggestions([]);
      return;
    }
    api
      .contacts(account, q)
      .then((r) => {
        if (!cancelled) {
          const taken = new Set(value.map((v) => v.address));
          setSuggestions(r.contacts.filter((c) => !taken.has(c.address)));
          setActive(0);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [q, account, value]);

  const add = (list: Address[]) => {
    if (!list.length) return;
    const seen = new Set(value.map((v) => v.address));
    onChange([...value, ...list.filter((a) => !seen.has(a.address) && seen.add(a.address))]);
    setText("");
    setSuggestions([]);
  };

  const commit = () => {
    if (text.trim()) add(parseAddresses(text));
  };

  const showSuggest = focused && suggestions.length > 0 && text.trim().length > 0;

  return (
    <div className="field" onClick={() => input.current?.focus()}>
      <span className="field-label">{label}</span>
      <div className="recipients">
        {value.map((a, i) => (
          <span key={a.address + i} className={`rcpt-chip ${EMAIL.test(a.address) ? "" : "invalid"}`} title={a.address}>
            <span>{a.name || a.address}</span>
            <button type="button" aria-label={`Remove ${a.address}`} onClick={(e) => { e.stopPropagation(); onChange(value.filter((_, j) => j !== i)); }}>
              <X size={14} />
            </button>
          </span>
        ))}
        <input
          ref={input}
          value={text}
          autoFocus={autoFocus}
          aria-label={label === "To" ? "To recipients" : `${label} recipients`}
          aria-autocomplete="list"
          aria-expanded={showSuggest}
          onChange={(e) => {
            const v = e.target.value;
            if (/[,;]\s*$/.test(v)) {
              add(parseAddresses(v));
            } else setText(v);
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            commit();
          }}
          onPaste={(e) => {
            const pasted = e.clipboardData.getData("text");
            if (/[,;\n]/.test(pasted) || EMAIL.test(pasted.trim())) {
              e.preventDefault();
              add(parseAddresses(text + pasted));
            }
          }}
          onKeyDown={(e) => {
            if (showSuggest && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
              e.preventDefault();
              setActive((i) => (i + (e.key === "ArrowDown" ? 1 : -1) + suggestions.length) % suggestions.length);
            } else if ((e.key === "Enter" || e.key === "Tab") && showSuggest) {
              e.preventDefault();
              const s = suggestions[active];
              add([{ address: s.address, name: s.name ?? undefined }]);
            } else if ((e.key === "Enter" || e.key === "Tab") && text.trim()) {
              if (e.key === "Enter") e.preventDefault();
              commit();
            } else if (e.key === "Backspace" && !text && value.length) {
              onChange(value.slice(0, -1));
            }
          }}
        />
        {showSuggest && (
          <div className="suggest" role="listbox">
            {suggestions.map((s, i) => (
              <div
                key={s.address}
                role="option"
                aria-selected={i === active}
                className={`suggest-item ${i === active ? "active" : ""}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  add([{ address: s.address, name: s.name ?? undefined }]);
                }}
              >
                <Avatar person={{ address: s.address, name: s.name ?? undefined }} size={32} />
                <div>
                  <div className="n">{s.name || s.address}</div>
                  {s.name && <div className="e">{s.address}</div>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {right}
    </div>
  );
}
