// The address book: this mailbox's contacts, searchable, with vCard import and export,
// and the dialog that adds or edits one (also opened from a message's menu).
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Download, Plus, Trash2, Upload, X } from "lucide-react";
import { type FormEvent, useRef, useState } from "react";
import { ui, useAccount } from "../lib/account";
import { api } from "../lib/api";
import { navigate } from "../lib/router";
import { toast } from "../lib/store";
import type { ContactFields } from "../lib/types";
import { Avatar, IconButton, Modal, useDebounced } from "./common";

const EMPTY: ContactFields = { firstName: "", lastName: "", emails: [], phones: [], organization: "", title: "", birthday: "", notes: "" };
const EMAIL_LABELS = ["", "home", "work", "other"];
const PHONE_LABELS = ["", "mobile", "home", "work", "main", "fax", "other"];

const open = (dialog: { id?: number; initial?: Partial<ContactFields> }) => ui.set((s) => ({ ...s, contactDialog: dialog }));

export function ContactsView() {
  const acct = useAccount();
  const client = useQueryClient();
  const [q, setQ] = useState("");
  const term = useDebounced(q.trim(), 200);
  const fileInput = useRef<HTMLInputElement>(null);
  const list = useInfiniteQuery({
    queryKey: ["contacts", acct.index, term],
    queryFn: ({ pageParam }) => api.contacts(acct.index, term, pageParam),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.contacts.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
  });
  const contacts = list.data?.pages.flatMap((p) => p.contacts) ?? [];
  const total = list.data?.pages[0]?.total ?? 0;

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
      await client.invalidateQueries({ queryKey: ["contacts", acct.index] });
    } catch (err) {
      toast((err as Error).message, { error: true });
    } finally {
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  return (
    <>
      <div className="toolbar contacts-toolbar">
        <IconButton label="Back to inbox" onClick={() => navigate(`/u/${acct.index}/inbox`)}><ArrowLeft size={20} /></IconButton>
        <h2>Contacts</h2>
        {list.data && <span className="range">{total.toLocaleString()}</span>}
        <div className="grow" />
        <input className="text-input contacts-search" type="search" placeholder="Search contacts" aria-label="Search contacts" value={q} onChange={(e) => setQ(e.target.value)} />
        <input ref={fileInput} type="file" accept=".vcf,text/vcard,text/x-vcard" hidden onChange={(e) => void importFile(e.target.files?.[0])} />
        <IconButton label="Import from a vCard file (.vcf)" onClick={() => fileInput.current?.click()}><Upload size={20} /></IconButton>
        <IconButton label="Export all as a vCard file" onClick={() => (location.href = api.exportContactsUrl(acct.index))} disabled={!total}><Download size={20} /></IconButton>
        <button type="button" className="btn btn-primary" onClick={() => open({})}><Plus size={18} /> Create contact</button>
      </div>
      <div className="settings">
        {list.isPending ? (
          <div className="empty"><div className="spinner lg" /></div>
        ) : !contacts.length ? (
          <div className="empty">
            <h3>{term ? "No contacts match" : "No contacts yet"}</h3>
            {!term && (
              <p style={{ maxWidth: 480 }}>
                Create one, add a sender from a message's menu, or import a vCard file (.vcf) exported from Gmail, Apple Contacts, Thunderbird or another webmail.
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
                      {c.name}
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

function LabelSelect({ value, options, onChange, name }: { value: string; options: string[]; onChange: (v: string) => void; name: string }) {
  const all = options.includes(value) ? options : [...options, value];
  return (
    <select className="text-input" aria-label={name} value={value} onChange={(e) => onChange(e.target.value)}>
      {all.map((o) => <option key={o} value={o}>{o ? o[0].toUpperCase() + o.slice(1) : "No label"}</option>)}
    </select>
  );
}

/** Adds a contact (from `initial`) or edits one (`id`). */
export function ContactDialog({ id, initial }: { id?: number; initial?: Partial<ContactFields> }) {
  const acct = useAccount();
  const client = useQueryClient();
  const close = () => ui.set((s) => ({ ...s, contactDialog: null }));
  const existing = useQuery({ queryKey: ["contact", acct.index, id], queryFn: () => api.contact(acct.index, id!), enabled: id !== undefined, staleTime: 0 });
  const [draft, setDraft] = useState<ContactFields | null>(id === undefined ? { ...EMPTY, ...initial } : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const f = draft ?? existing.data?.contact.fields ?? null;
  const set = (patch: Partial<ContactFields>) => setDraft({ ...(f ?? EMPTY), ...patch });

  const refresh = async () => {
    await client.invalidateQueries({ queryKey: ["contacts", acct.index] });
    if (id !== undefined) void client.invalidateQueries({ queryKey: ["contact", acct.index, id] });
  };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!f) return;
    setBusy(true);
    setError("");
    const fields = { ...f, emails: f.emails.filter((x) => x.address.trim()), phones: f.phones.filter((x) => x.number.trim()) };
    try {
      if (id === undefined) await api.createContact(acct.index, fields);
      else await api.updateContact(acct.index, id, fields);
      await refresh();
      toast(id === undefined ? "Contact added." : "Contact saved.");
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
          await refresh();
          toast("Contact deleted.");
        },
      },
    }));

  return (
    <Modal open onClose={close} title={id === undefined ? "New contact" : "Edit contact"}>
      {!f ? (
        existing.error ? <p className="form-error">{existing.error.message}</p> : <div className="empty"><div className="spinner" /></div>
      ) : (
        <form className="contact-form" onSubmit={(e) => void save(e)}>
          <div className="pair">
            <input className="text-input" aria-label="First name" placeholder="First name" value={f.firstName} autoFocus onChange={(e) => set({ firstName: e.target.value })} />
            <input className="text-input" aria-label="Last name" placeholder="Last name" value={f.lastName} onChange={(e) => set({ lastName: e.target.value })} />
          </div>
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
          <input className="text-input" aria-label="Birthday" placeholder="Birthday (YYYY-MM-DD)" value={f.birthday} onChange={(e) => set({ birthday: e.target.value })} />
          <textarea className="text-input" aria-label="Notes" placeholder="Notes" rows={3} value={f.notes} onChange={(e) => set({ notes: e.target.value })} />
          {error && <div className="form-error" role="alert">{error}</div>}
          <div className="buttons">
            {id !== undefined && (
              <button type="button" className="btn btn-danger" style={{ marginRight: "auto" }} onClick={remove}><Trash2 size={16} /> Delete</button>
            )}
            <button type="button" className="btn btn-text" onClick={close}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
          </div>
        </form>
      )}
    </Modal>
  );
}
