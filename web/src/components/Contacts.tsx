// The address book: this mailbox's contacts, searchable and by label, with vCard import
// and export, tidying names that carry context ("Bryan - church") into labels, and the
// dialog that adds or edits one (also opened from a message's menu).
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ChevronDown, Download, EllipsisVertical, Pencil, Plus, RefreshCw, Sparkles, Tag, Trash2, Upload, X } from "lucide-react";
import { type FormEvent, type KeyboardEvent, useMemo, useRef, useState } from "react";
import { ui, useAccount } from "../lib/account";
import { api } from "../lib/api";
import { longDate, relative } from "../lib/format";
import { contactsPath, navigate } from "../lib/router";
import { toast } from "../lib/store";
import type { ContactFields, ContactSync, TidyProposal } from "../lib/types";
import { Avatar, IconButton, Modal, useDebounced } from "./common";

const EMPTY: ContactFields = {
  firstName: "", lastName: "", nickname: "", emails: [], phones: [], organization: "", title: "", birthday: "", dates: [], labels: [], notes: "",
};
const EMAIL_LABELS = ["", "home", "work", "other"];
const PHONE_LABELS = ["", "mobile", "home", "work", "main", "fax", "other"];

const open = (dialog: { id?: number; initial?: Partial<ContactFields>; birthday?: boolean }) => ui.set((s) => ({ ...s, contactDialog: dialog }));

/** The mailbox's labels, for the filter, and to suggest while labelling. */
export function useContactLabels() {
  const acct = useAccount();
  return useQuery({ queryKey: ["contact-labels", acct.index], queryFn: () => api.contactLabels(acct.index), staleTime: 30_000 });
}

export function ContactsView({ label }: { label: string | null }) {
  const acct = useAccount();
  const client = useQueryClient();
  const [q, setQ] = useState("");
  const term = useDebounced(q.trim(), 200);
  const fileInput = useRef<HTMLInputElement>(null);
  const [tidying, setTidying] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const labels = useContactLabels().data?.labels ?? [];
  const list = useInfiniteQuery({
    queryKey: ["contacts", acct.index, term, label],
    queryFn: ({ pageParam }) => api.contacts(acct.index, term, pageParam, label ?? ""),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.contacts.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
  });
  const contacts = list.data?.pages.flatMap((p) => p.contacts) ?? [];
  const total = list.data?.pages[0]?.total ?? 0;
  const sync = list.data?.pages[0]?.sync;
  const [syncing, setSyncing] = useState(false);
  const syncNow = async () => {
    setSyncing(true);
    try {
      const r = await api.syncContacts(acct.index);
      if (r.sync.error) toast(r.sync.error, { error: true });
      await client.invalidateQueries({ queryKey: ["contacts", acct.index] });
    } catch (err) {
      toast((err as Error).message, { error: true });
    } finally {
      setSyncing(false);
    }
  };

  const importFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const r = await api.importContacts(acct.index, file);
      const parts = [
        r.added && `${r.added} added`,
        r.updated && `${r.updated} updated`,
        r.unchanged && `${r.unchanged} already here`,
        r.skipped && `${r.skipped} skipped (no name or address)`,
      ].filter(Boolean);
      toast(`Imported: ${parts.join(", ") || "nothing new"}.`);
      await refreshContacts(client, acct.index);
    } catch (err) {
      toast((err as Error).message, { error: true });
    } finally {
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const removeLabel = (name: string) =>
    ui.set((s) => ({
      ...s,
      confirm: {
        title: `Remove the label "${name}"?`,
        body: "It comes off every contact that has it. The contacts stay.",
        action: "Remove",
        run: async () => {
          const r = await api.removeContactLabel(acct.index, name);
          navigate(contactsPath(acct.index));
          await refreshContacts(client, acct.index);
          toast(`Removed from ${r.changed} ${r.changed === 1 ? "contact" : "contacts"}.`);
        },
      },
    }));

  return (
    <>
      <div className="toolbar contacts-toolbar">
        <IconButton label="Back to inbox" onClick={() => navigate(`/u/${acct.index}/inbox`)}><ArrowLeft size={20} /></IconButton>
        <h2>Contacts</h2>
        {(labels.length > 0 || label) && (
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button type="button" className="btn btn-outline view-btn" aria-label={`Showing: ${label ?? "all contacts"}`}>
                {label ? <><Tag size={16} /> {label}</> : "All contacts"} <ChevronDown size={16} />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content className="menu label-menu" align="start" sideOffset={4}>
                <DropdownMenu.Item className="menu-item" onSelect={() => navigate(contactsPath(acct.index))}>All contacts</DropdownMenu.Item>
                <DropdownMenu.Separator className="menu-sep" />
                {labels.map((l) => (
                  <DropdownMenu.Item key={l.label} className="menu-item" onSelect={() => navigate(contactsPath(acct.index, l.label))}>
                    <Tag size={16} /> <span style={{ flex: 1 }}>{l.label}</span> <span className="muted">{l.count.toLocaleString()}</span>
                  </DropdownMenu.Item>
                ))}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        )}
        {list.data && <span className="range">{total.toLocaleString()}</span>}
        <div className="grow" />
        <input className="text-input contacts-search" type="search" placeholder="Search contacts" aria-label="Search contacts" value={q} onChange={(e) => setQ(e.target.value)} />
        <input ref={fileInput} type="file" accept=".vcf,text/vcard,text/x-vcard" hidden onChange={(e) => void importFile(e.target.files?.[0])} />
        <IconButton label="Import from a vCard file (.vcf)" onClick={() => fileInput.current?.click()}><Upload size={20} /></IconButton>
        <IconButton label="Export all as a vCard file" onClick={() => (location.href = api.exportContactsUrl(acct.index))} disabled={!total}><Download size={20} /></IconButton>
        {sync?.server && (
          <IconButton label="Sync now" onClick={() => void syncNow()} disabled={syncing || sync.syncing}>
            <RefreshCw size={20} className={syncing || sync.syncing ? "spin" : ""} />
          </IconButton>
        )}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <IconButton label="More"><EllipsisVertical size={20} /></IconButton>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="menu" align="end" sideOffset={4}>
              <DropdownMenu.Item className="menu-item" onSelect={() => open({ birthday: true })}><Plus size={18} /> Add a birthday</DropdownMenu.Item>
              <DropdownMenu.Item className="menu-item" onSelect={() => setTidying(true)}><Sparkles size={18} /> Tidy up names</DropdownMenu.Item>
              {label && (
                <>
                  <DropdownMenu.Separator className="menu-sep" />
                  <DropdownMenu.Item className="menu-item" onSelect={() => setRenaming(true)}><Pencil size={18} /> Rename label</DropdownMenu.Item>
                  <DropdownMenu.Item className="menu-item" onSelect={() => removeLabel(label)}><Trash2 size={18} /> Remove label</DropdownMenu.Item>
                </>
              )}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
        <button type="button" className="btn btn-primary" onClick={() => open({ initial: label ? { labels: [label] } : {} })}><Plus size={18} /> Create contact</button>
      </div>
      {tidying && <TidyDialog onClose={() => setTidying(false)} />}
      {renaming && label && <RenameLabelDialog label={label} onClose={() => setRenaming(false)} />}
      {sync?.server && <SyncLine sync={sync} />}
      <div className="settings">
        {list.isPending ? (
          <div className="empty"><div className="spinner lg" /></div>
        ) : !contacts.length ? (
          <div className="empty">
            <h3>{term ? "No contacts match" : label ? `No contacts labelled "${label}"` : "No contacts yet"}</h3>
            {!term && !label && (
              <p style={{ maxWidth: 480 }}>
                Create one, add a sender from a message's menu, or import a vCard file (.vcf) exported from another app.
              </p>
            )}
          </div>
        ) : (
          <table className="contacts-table">
            <thead>
              <tr><td>Name</td><td>Email</td><td className="hide-narrow">Phone</td><td className="hide-narrow">Company</td></tr>
            </thead>
            <tbody>
              {contacts.map((c) => (
                <tr key={c.id} tabIndex={0} onClick={() => open({ id: c.id })} onKeyDown={(e) => e.key === "Enter" && open({ id: c.id })}>
                  <td>
                    <span className="contact-name">
                      <Avatar person={{ address: c.emails[0] ?? c.name, name: c.name }} size={32} />
                      <span>{c.name}</span>
                      {c.labels.filter((l) => l.toLowerCase() !== label?.toLowerCase()).map((l) => <span key={l} className="chip">{l}</span>)}
                    </span>
                  </td>
                  <td>{c.emails[0] ?? ""}{c.emails.length > 1 && <span className="more"> +{c.emails.length - 1}</span>}</td>
                  <td className="hide-narrow">{c.phone ?? ""}</td>
                  <td className="hide-narrow">{c.organization}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {list.hasNextPage && (
          <div style={{ padding: 16, textAlign: "center" }}>
            <button type="button" className="btn btn-outline" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>Show more</button>
          </div>
        )}
      </div>
    </>
  );
}

/** After a change to contacts: the list, the labels, and the open contact are fetched again. */
function refreshContacts(client: ReturnType<typeof useQueryClient>, index: number) {
  return Promise.all([
    client.invalidateQueries({ queryKey: ["contacts", index] }),
    client.invalidateQueries({ queryKey: ["contact-labels", index] }),
    client.invalidateQueries({ queryKey: ["contact", index] }),
  ]);
}

function RenameLabelDialog({ label, onClose }: { label: string; onClose: () => void }) {
  const acct = useAccount();
  const client = useQueryClient();
  const [name, setName] = useState(label);
  const [error, setError] = useState("");
  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.renameContactLabel(acct.index, label, name);
      navigate(contactsPath(acct.index, name.trim()), { replace: true });
      await refreshContacts(client, acct.index);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Modal open onClose={onClose} title="Rename label">
      <form className="contact-form" onSubmit={(e) => void save(e)}>
        <input className="text-input" aria-label="Label" value={name} autoFocus maxLength={60} onChange={(e) => setName(e.target.value)} />
        <p className="dialog-text">Every contact with "{label}" gets the new name. If it's the name of another label, the two become one.</p>
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className="buttons">
          <button type="button" className="btn btn-text" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={!name.trim()}>Rename</button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Names with context after them ("Bryan - church", "Mei (work)"), which goes out with their
 * address as their name, shown with what tidying would make of them: the context moved
 * into a label, grouped by label, each group's label editable, each contact optional.
 */
function TidyDialog({ onClose }: { onClose: () => void }) {
  const acct = useAccount();
  const client = useQueryClient();
  const found = useQuery({ queryKey: ["contacts-tidy", acct.index], queryFn: () => api.contactsToTidy(acct.index), staleTime: 0, gcTime: 0 });
  const [skipped, setSkipped] = useState<Set<number>>(new Set());
  const [names, setNames] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const key = (label: string) => label.toLowerCase();
  const groups = useMemo(() => {
    const out = new Map<string, TidyProposal[]>();
    for (const p of found.data?.contacts ?? []) out.set(key(p.label), [...(out.get(key(p.label)) ?? []), p]);
    return [...out.values()];
  }, [found.data]);
  const chosen = (found.data?.contacts ?? []).filter((p) => !skipped.has(p.id));
  const labelFor = (p: TidyProposal) => (names[key(p.label)] ?? p.label).trim();
  const toggle = (id: number) => setSkipped((s) => {
    const next = new Set(s);
    if (!next.delete(id)) next.add(id);
    return next;
  });
  const apply = async () => {
    if (chosen.some((p) => !labelFor(p))) return setError("Give every label a name.");
    setBusy(true);
    setError("");
    try {
      const r = await api.tidyContacts(acct.index, chosen.map((p) => ({ id: p.id, label: labelFor(p) })));
      await refreshContacts(client, acct.index);
      toast(`Tidied ${r.changed} ${r.changed === 1 ? "name" : "names"}.`);
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  const named = (p: TidyProposal) => [p.firstName, p.lastName].filter(Boolean).join(" ");
  return (
    <Modal open onClose={onClose} title="Tidy up names">
      <p className="dialog-text">
        These names have something after them that says who the person is to you. Their name goes out with their address when
        you write to them, so they'd see it too. Tidying moves it into a label, which you still see here and while you write.
      </p>
      {found.isPending ? (
        <div className="empty"><div className="spinner" /></div>
      ) : found.error ? (
        <p className="form-error">{found.error.message}</p>
      ) : !groups.length ? (
        <p className="dialog-text"><strong>Nothing to tidy:</strong> no name has " - " or brackets after it.</p>
      ) : (
        <div className="tidy-list">
          {groups.map((items) => {
            const k = key(items[0].label);
            return (
              <section key={k} className="tidy-group">
                <label className="tidy-label">
                  <Tag size={16} aria-hidden />
                  <input className="text-input" aria-label={`Label for ${items.length === 1 ? items[0].name : `${items.length} contacts`}`} maxLength={60}
                    value={names[k] ?? items[0].label} onChange={(e) => setNames((n) => ({ ...n, [k]: e.target.value }))} />
                </label>
                <ul>
                  {items.map((p) => (
                    <li key={p.id}>
                      <label>
                        <input type="checkbox" checked={!skipped.has(p.id)} onChange={() => toggle(p.id)} />
                        <span className="tidy-old">{p.name}</span>
                        <span aria-hidden>→</span>
                        <span>{named(p) || <span className="muted">(no name)</span>}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="buttons">
        <button type="button" className="btn btn-text" onClick={onClose}>Cancel</button>
        {groups.length > 0 && (
          <button type="button" className="btn btn-primary" disabled={busy || !chosen.length} onClick={() => void apply()}>
            {busy ? "Tidying…" : `Tidy ${chosen.length} ${chosen.length === 1 ? "name" : "names"}`}
          </button>
        )}
      </div>
    </Modal>
  );
}

/** Where the contacts sync, and how the last sync went. */
function SyncLine({ sync }: { sync: ContactSync }) {
  const books = sync.books.length > 1 ? ` · ${sync.books.length} address books` : "";
  if (sync.syncing) return <div className="sync-line">Syncing with {sync.server}…</div>;
  if (sync.error) {
    return (
      <div className="sync-line error" role="status">
        Couldn't sync with {sync.server}: {sync.error}
        {sync.at && <> Last synced {relative(sync.at)}.</>}
      </div>
    );
  }
  return (
    <div className="sync-line" title={sync.at ? longDate(sync.at) : undefined}>
      {sync.at ? `Synced with ${sync.server} ${relative(sync.at)}${books}` : `Syncs with ${sync.server}${books}`}
    </div>
  );
}

function LabelSelect({ value, options, onChange, name }: { value: string; options: string[]; onChange: (v: string) => void; name: string }) {
  const all = options.includes(value) ? options : [...options, value];
  return (
    <select className="text-input" aria-label={name} value={value} onChange={(e) => onChange(e.target.value)}>
      {all.map((o) => <option key={o} value={o}>{o ? o[0].toUpperCase() + o.slice(1) : "No label"}</option>)}
    </select>
  );
}

// ---------------------------------------------------------------- dates

const MONTHS = Array.from({ length: 12 }, (_, i) => new Intl.DateTimeFormat(undefined, { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2000, i, 1))));

/** The order the browser's language writes a day, a month and a year in. */
const DATE_ORDER = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })
  .formatToParts(new Date(Date.UTC(2000, 10, 22)))
  .map((p) => p.type)
  .filter((t): t is "day" | "month" | "year" => t === "day" || t === "month" || t === "year");

/** "1990-05-12" or "--05-12" into its parts; null for another app's wording. Parts not yet chosen are "00". */
function splitDate(value: string): { year: string; month: string; day: string } | null {
  if (!value) return { year: "", month: "", day: "" };
  const m = /^(\d{4}|-)-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const part = (v: string) => (v === "00" ? "" : String(Number(v)));
  return { year: m[1] === "-" ? "" : m[1], month: part(m[2]), day: part(m[3]) };
}

function joinDate(p: { year: string; month: string; day: string }): string {
  if (!p.year && !p.month && !p.day) return "";
  return `${p.year ? p.year.padStart(4, "0") : "-"}-${(p.month || "0").padStart(2, "0")}-${(p.day || "0").padStart(2, "0")}`;
}

/** A date begun but without its day or month. */
const unfinished = (value: string) => /-00(-|$)/.test(value);

/** A day, a month and, if known, a year, in the order the browser's language writes them. */
function DateField({ value, onChange, name }: { value: string; onChange: (v: string) => void; name: string }) {
  const parts = splitDate(value);
  if (!parts) {
    // Another app wrote words Viauna can't read as a date: kept unless replaced.
    return (
      <div className="date-field date-other">
        <span title="Written by another app">{value}</span>
        <button type="button" className="btn btn-text" onClick={() => onChange("")}>Replace</button>
      </div>
    );
  }
  const set = (patch: Partial<typeof parts>) => onChange(joinDate({ ...parts, ...patch }));
  const fields = {
    day: (
      <input key="day" className="text-input date-day" inputMode="numeric" aria-label={`${name}: day`} placeholder="Day" maxLength={2}
        value={parts.day} onChange={(e) => set({ day: e.target.value.replace(/\D/g, "") })} />
    ),
    month: (
      <select key="month" className="text-input date-month" aria-label={`${name}: month`} value={parts.month} onChange={(e) => set({ month: e.target.value })}>
        <option value="">Month</option>
        {MONTHS.map((m, i) => <option key={m} value={String(i + 1)}>{m}</option>)}
      </select>
    ),
    year: (
      <input key="year" className="text-input date-year" inputMode="numeric" aria-label={`${name}: year (if you know it)`} placeholder="Year (optional)" maxLength={4}
        value={parts.year} onChange={(e) => set({ year: e.target.value.replace(/\D/g, "") })} />
    ),
  };
  return <div className="date-field" role="group" aria-label={name}>{DATE_ORDER.map((t) => fields[t])}</div>;
}

const DATE_LABELS = ["anniversary", "other"];
const showLabel = (label: string) => (DATE_LABELS.includes(label) ? label[0].toUpperCase() + label.slice(1) : label);

/** Labels as chips, and a box to add one, which suggests the mailbox's labels. */
function LabelsField({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const known = useContactLabels().data?.labels ?? [];
  const [text, setText] = useState("");
  const add = () => {
    const label = text.replace(/,/g, " ").replace(/\s+/g, " ").trim();
    if (label && !value.some((v) => v.toLowerCase() === label.toLowerCase())) onChange([...value, label]);
    setText("");
  };
  const keyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if ((e.key === "Enter" || e.key === ",") && text.trim()) {
      e.preventDefault();
      add();
    } else if (e.key === "Backspace" && !text && value.length) {
      onChange(value.slice(0, -1));
    }
  };
  return (
    <div className="labels-field">
      <Tag size={18} aria-hidden className="muted" />
      {value.map((l) => (
        <span key={l} className="chip lg">
          {l}
          <button type="button" aria-label={`Remove the label ${l}`} onClick={() => onChange(value.filter((v) => v !== l))}><X size={12} /></button>
        </span>
      ))}
      <input aria-label="Add a label" list="contact-label-list" maxLength={60} value={text}
        placeholder={value.length ? "Add a label" : "Labels: Family, Church, Work…"}
        onChange={(e) => setText(e.target.value)} onKeyDown={keyDown} onBlur={add} />
      <datalist id="contact-label-list">
        {known.filter((k) => !value.some((v) => v.toLowerCase() === k.label.toLowerCase())).map((k) => <option key={k.label} value={k.label} />)}
      </datalist>
    </div>
  );
}

/**
 * Adds a contact (from `initial`) or edits one (`id`). With `birthday`, it asks only for a
 * name and a birthday: for someone whose other details you don't have.
 */
export function ContactDialog({ id, initial, birthday: birthdayOnly }: { id?: number; initial?: Partial<ContactFields>; birthday?: boolean }) {
  const acct = useAccount();
  const client = useQueryClient();
  const close = () => ui.set((s) => ({ ...s, contactDialog: null }));
  const existing = useQuery({ queryKey: ["contact", acct.index, id], queryFn: () => api.contact(acct.index, id!), enabled: id !== undefined, staleTime: 0 });
  const [draft, setDraft] = useState<ContactFields | null>(id === undefined ? { ...EMPTY, ...initial } : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const f = draft ?? existing.data?.contact.fields ?? null;
  const set = (patch: Partial<ContactFields>) => setDraft({ ...(f ?? EMPTY), ...patch });

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!f) return;
    if (birthdayOnly && !f.birthday) return setError("Give the birthday.");
    if ([f.birthday, ...f.dates.map((d) => d.date)].some(unfinished)) return setError("Give each date a day and a month.");
    setBusy(true);
    setError("");
    const fields = {
      ...f,
      emails: f.emails.filter((x) => x.address.trim()),
      phones: f.phones.filter((x) => x.number.trim()),
      dates: f.dates.filter((x) => x.date),
    };
    try {
      if (id === undefined) await api.createContact(acct.index, fields);
      else await api.updateContact(acct.index, id, fields);
      await refreshContacts(client, acct.index);
      void client.invalidateQueries({ queryKey: ["events", acct.index] });
      toast(id === undefined ? (birthdayOnly ? "Birthday added." : "Contact added.") : "Contact saved.");
      close();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  const remove = () =>
    ui.set((s) => ({
      ...s,
      contactDialog: null,
      confirm: {
        title: "Delete this contact?",
        body: `${existing.data?.contact.name ?? "This contact"} will be removed from your contacts. Mail from or to them stays where it is.`,
        action: "Delete",
        run: async () => {
          await api.deleteContact(acct.index, id!);
          await refreshContacts(client, acct.index);
          void client.invalidateQueries({ queryKey: ["events", acct.index] });
          toast("Contact deleted.");
        },
      },
    }));

  const names = f && (
    <div className="pair">
      <input className="text-input" aria-label="First name" placeholder="First name" value={f.firstName} autoFocus onChange={(e) => set({ firstName: e.target.value })} />
      <input className="text-input" aria-label="Last name" placeholder="Last name" value={f.lastName} onChange={(e) => set({ lastName: e.target.value })} />
    </div>
  );
  const buttons = (
    <>
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="buttons">
        {id !== undefined && (
          <button type="button" className="btn btn-danger" style={{ marginRight: "auto" }} onClick={remove}><Trash2 size={16} /> Delete</button>
        )}
        <button type="button" className="btn btn-text" onClick={close}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
      </div>
    </>
  );

  if (birthdayOnly && f) {
    return (
      <Modal open onClose={close} title="Add a birthday">
        <form className="contact-form" onSubmit={(e) => void save(e)}>
          <p className="dialog-text">For someone whose other details you don't have.</p>
          {names}
          <DateField name="Birthday" value={f.birthday} onChange={(birthday) => set({ birthday })} />
          {buttons}
        </form>
      </Modal>
    );
  }

  return (
    <Modal open onClose={close} title={id === undefined ? "New contact" : "Edit contact"}>
      {!f ? (
        existing.error ? <p className="form-error">{existing.error.message}</p> : <div className="empty"><div className="spinner" /></div>
      ) : (
        <form className="contact-form" onSubmit={(e) => void save(e)}>
          {names}
          <input className="text-input" aria-label="Nickname" placeholder="Nickname (matched while you write, never sent)" value={f.nickname}
            onChange={(e) => set({ nickname: e.target.value })} />
          <LabelsField value={f.labels} onChange={(labels) => set({ labels })} />
          <div className="pair">
            <input className="text-input" aria-label="Company" placeholder="Company" value={f.organization} onChange={(e) => set({ organization: e.target.value })} />
            <input className="text-input" aria-label="Job title" placeholder="Job title" value={f.title} onChange={(e) => set({ title: e.target.value })} />
          </div>
          {f.emails.map((em, i) => (
            <div className="row-field" key={`e${i}`}>
              <input className="text-input" type="email" aria-label={`Email ${i + 1}`} placeholder="Email" value={em.address}
                onChange={(e) => set({ emails: f.emails.map((x, j) => (j === i ? { ...x, address: e.target.value } : x)) })} />
              <LabelSelect name={`Label for email ${i + 1}`} value={em.label} options={EMAIL_LABELS}
                onChange={(label) => set({ emails: f.emails.map((x, j) => (j === i ? { ...x, label } : x)) })} />
              <IconButton label={`Remove email ${i + 1}`} onClick={() => set({ emails: f.emails.filter((_, j) => j !== i) })}><X size={18} /></IconButton>
            </div>
          ))}
          <button type="button" className="btn btn-text add-field" onClick={() => set({ emails: [...f.emails, { address: "", label: "" }] })}><Plus size={16} /> Add email</button>
          {f.phones.map((ph, i) => (
            <div className="row-field" key={`p${i}`}>
              <input className="text-input" type="tel" aria-label={`Phone ${i + 1}`} placeholder="Phone" value={ph.number}
                onChange={(e) => set({ phones: f.phones.map((x, j) => (j === i ? { ...x, number: e.target.value } : x)) })} />
              <LabelSelect name={`Label for phone ${i + 1}`} value={ph.label} options={PHONE_LABELS}
                onChange={(label) => set({ phones: f.phones.map((x, j) => (j === i ? { ...x, label } : x)) })} />
              <IconButton label={`Remove phone ${i + 1}`} onClick={() => set({ phones: f.phones.filter((_, j) => j !== i) })}><X size={18} /></IconButton>
            </div>
          ))}
          <button type="button" className="btn btn-text add-field" onClick={() => set({ phones: [...f.phones, { number: "", label: "mobile" }] })}><Plus size={16} /> Add phone</button>
          <div className="date-row">
            <span className="date-row-label">Birthday</span>
            <DateField name="Birthday" value={f.birthday} onChange={(birthday) => set({ birthday })} />
          </div>
          {f.dates.map((d, i) => (
            <div className="date-row" key={`d${i}`}>
              <input className="text-input date-row-label" aria-label={`Label for date ${i + 1}`} list="contact-date-labels" maxLength={60}
                value={showLabel(d.label)} onChange={(e) => set({ dates: f.dates.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
              <DateField name={`Date ${i + 1}`} value={d.date} onChange={(date) => set({ dates: f.dates.map((x, j) => (j === i ? { ...x, date } : x)) })} />
              <IconButton label={`Remove date ${i + 1}`} onClick={() => set({ dates: f.dates.filter((_, j) => j !== i) })}><X size={18} /></IconButton>
            </div>
          ))}
          <datalist id="contact-date-labels">{DATE_LABELS.map((l) => <option key={l} value={showLabel(l)} />)}</datalist>
          <button type="button" className="btn btn-text add-field" onClick={() => set({ dates: [...f.dates, { date: "", label: f.dates.length ? "other" : "anniversary" }] })}>
            <Plus size={16} /> Add a date
          </button>
          <textarea className="text-input" aria-label="Notes" placeholder="Notes" rows={3} value={f.notes} onChange={(e) => set({ notes: e.target.value })} />
          {buttons}
        </form>
      )}
    </Modal>
  );
}
