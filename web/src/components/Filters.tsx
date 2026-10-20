// Filters (Settings > Filters) and the vacation responder (Settings > General): kept in
// the mailbox's Sieve script on its mail server, which applies them as mail arrives. The
// filter dialog is also opened from a message's menu (Filter messages like these).
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2, TriangleAlert } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { ui, useAccount } from "../lib/account";
import { ApiError, api } from "../lib/api";
import { toast } from "../lib/store";
import type { Filter, FilterActions, FilterCriteria, FiltersState, Vacation } from "../lib/types";
import { IconButton, Modal } from "./common";

const NO_CRITERIA: FilterCriteria = { from: "", to: "", subject: "", hasWords: "", doesntHave: "", hasAttachment: false, largerThan: null, smallerThan: null };
const NO_ACTIONS: FilterActions = { skipInbox: false, markRead: false, star: false, label: null, moveTo: null, delete: false, forwardTo: null };
const UNITS = { MB: 1024 * 1024, KB: 1024, bytes: 1 } as const;

export function useFilters() {
  const acct = useAccount();
  return useQuery({ queryKey: ["filters", acct.index], queryFn: () => api.filters(acct.index), staleTime: 60_000, retry: false });
}

/** "Matches: from:(ann) subject:(invoice)", as Gmail lists filters. */
function describeCriteria(c: FilterCriteria): string {
  const parts: string[] = [];
  if (c.from) parts.push(`from:(${c.from})`);
  if (c.to) parts.push(`to:(${c.to})`);
  if (c.subject) parts.push(`subject:(${c.subject})`);
  if (c.hasWords) parts.push(c.hasWords);
  if (c.doesntHave) parts.push(`-{${c.doesntHave}}`);
  if (c.hasAttachment) parts.push("has:attachment");
  const size = (n: number) => (n >= UNITS.MB && n % UNITS.MB === 0 ? `${n / UNITS.MB}M` : n >= UNITS.KB && n % UNITS.KB === 0 ? `${n / UNITS.KB}K` : String(n));
  if (c.largerThan !== null) parts.push(`larger:${size(c.largerThan)}`);
  if (c.smallerThan !== null) parts.push(`smaller:${size(c.smallerThan)}`);
  return parts.join(" ");
}

function describeActions(a: FilterActions, labelName: (k: string) => string, folderName: (p: string) => string): string {
  const parts: string[] = [];
  if (a.skipInbox) parts.push("Skip Inbox");
  if (a.markRead) parts.push("Mark as read");
  if (a.star) parts.push("Star it");
  if (a.label) parts.push(`Apply label "${labelName(a.label)}"`);
  if (a.moveTo) parts.push(`Move to "${folderName(a.moveTo)}"`);
  if (a.delete) parts.push("Delete it");
  if (a.forwardTo) parts.push(`Forward to ${a.forwardTo}`);
  return parts.join(", ");
}

function useSaveFilters() {
  const acct = useAccount();
  const client = useQueryClient();
  return async (filters: Filter[], done: string) => {
    const state = await api.saveFilters(acct.index, filters);
    client.setQueryData(["filters", acct.index], state);
    // An Archive made for "Skip the Inbox" appears in the menu.
    void client.invalidateQueries({ queryKey: ["mailboxes", acct.index] });
    toast(done);
  };
}

export function FiltersTab() {
  const acct = useAccount();
  const client = useQueryClient();
  const query = useFilters();
  const save = useSaveFilters();
  const [editing, setEditing] = useState<{ filter?: Filter } | null>(null);
  if (query.isPending) return <div className="empty"><div className="spinner lg" /></div>;
  if (query.error) {
    return <div className="setting" style={{ gridTemplateColumns: "1fr", color: "var(--text-3)" }}>{(query.error as ApiError).message}</div>;
  }
  const state = query.data;
  const labelName = (k: string) => acct.labelByKeyword.get(k)?.name ?? k;
  const folderName = (p: string) => acct.mailboxes.find((m) => m.path === p)?.name ?? p;
  const remove = (f: Filter) =>
    ui.set((s) => ({
      ...s,
      confirm: {
        title: "Delete this filter?",
        body: "Mail that arrives from now on won't be sorted by it. Mail it sorted already stays where it is.",
        action: "Delete",
        run: () => save(state.filters.filter((x) => x.id !== f.id), "Filter deleted."),
      },
    }));
  return (
    <div className="setting" style={{ gridTemplateColumns: "1fr" }}>
      <p className="setting-note" style={{ margin: 0 }}>
        Filters run on your mail server as mail arrives, so they sort it even when Viauna isn't open, and in every mail app.
      </p>
      {state.changedElsewhere && (
        <div className="filters-warning"><TriangleAlert size={16} /> These filters were changed in another app since they were saved here. Saving here replaces those changes.</div>
      )}
      {state.include.length > 0 && (
        <div className="setting-note">Filters made in another app (<code>{state.include.join(", ")}</code>) keep running after these.</div>
      )}
      {state.filters.length ? (
        <table className="filters-table">
          <tbody>
            {state.filters.map((f) => (
              <tr key={f.id}>
                <td>
                  <div><span className="filters-key">Matches:</span> {describeCriteria(f.criteria)}</div>
                  <div><span className="filters-key">Do this:</span> {describeActions(f.actions, labelName, folderName)}</div>
                </td>
                <td style={{ textAlign: "right", whiteSpace: "nowrap", verticalAlign: "top" }}>
                  <IconButton label="Edit filter" onClick={() => setEditing({ filter: f })}><Pencil size={18} /></IconButton>
                  <IconButton label="Delete filter" onClick={() => remove(f)}><Trash2 size={18} /></IconButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div style={{ color: "var(--text-3)" }}>No filters yet.</div>
      )}
      <div><button type="button" className="btn btn-outline" onClick={() => setEditing({})}><Plus size={16} /> Create a new filter</button></div>
      {editing && (
        <FilterDialog
          filter={editing.filter}
          state={state}
          onClose={() => {
            setEditing(null);
            void client.invalidateQueries({ queryKey: ["filters", acct.index] });
          }}
        />
      )}
    </div>
  );
}

/** Opened from a message's menu: a new filter, filled in from it. */
export function MessageFilterDialog({ criteria }: { criteria: Partial<FilterCriteria> }) {
  const query = useFilters();
  const close = () => ui.set((s) => ({ ...s, filterDialog: null }));
  if (query.error) {
    toast((query.error as Error).message, { error: true });
    close();
    return null;
  }
  if (!query.data) return null;
  return <FilterDialog state={query.data} initial={criteria} onClose={close} />;
}

function FilterDialog({ filter, initial, state, onClose }: { filter?: Filter; initial?: Partial<FilterCriteria>; state: FiltersState; onClose: () => void }) {
  const acct = useAccount();
  const save = useSaveFilters();
  const [c, setC] = useState<FilterCriteria>({ ...NO_CRITERIA, ...filter?.criteria, ...initial });
  const [a, setA] = useState<FilterActions>({ ...NO_ACTIONS, ...filter?.actions });
  const sizeOf = (n: number | null): { value: string; unit: keyof typeof UNITS } => {
    if (n === null) return { value: "", unit: "MB" };
    const unit = n % UNITS.MB === 0 ? "MB" : n % UNITS.KB === 0 ? "KB" : "bytes";
    return { value: String(n / UNITS[unit]), unit };
  };
  const initialSize = c.smallerThan !== null ? { op: "smaller", ...sizeOf(c.smallerThan) } : { op: "larger", ...sizeOf(c.largerThan) };
  const [sizeOp, setSizeOp] = useState(initialSize.op);
  const [sizeValue, setSizeValue] = useState(initialSize.value);
  const [sizeUnit, setSizeUnit] = useState<keyof typeof UNITS>(initialSize.unit);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const folders = acct.mailboxes.filter((m) => m.selectable && !m.specialUse);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const bytes = sizeValue.trim() ? Math.round(Number(sizeValue) * UNITS[sizeUnit]) : null;
    if (sizeValue.trim() && (!Number.isFinite(bytes) || bytes! < 0)) return setError("The size must be a number.");
    const criteria = { ...c, largerThan: sizeOp === "larger" ? bytes : null, smallerThan: sizeOp === "smaller" ? bytes : null };
    const next: Filter = { id: filter?.id ?? crypto.randomUUID(), criteria, actions: a };
    const list = filter ? state.filters.map((f) => (f.id === filter.id ? next : f)) : [...state.filters, next];
    setBusy(true);
    setError("");
    try {
      await save(list, filter ? "Filter saved." : "Filter created. It applies to mail that arrives from now on.");
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  const text = (key: keyof FilterCriteria, label: string, placeholder = "") => (
    <label className="filter-field">
      <span>{label}</span>
      <input className="text-input" value={c[key] as string} placeholder={placeholder} onChange={(e) => setC({ ...c, [key]: e.target.value })} />
    </label>
  );
  // Each action is a row of the same height: its checkbox and words, then whatever it
  // needs (a label, a folder, an address) in one column.
  const check = (key: "skipInbox" | "markRead" | "star" | "delete", label: string) => (
    <>
      <label className="filter-action"><input type="checkbox" checked={a[key]} onChange={(e) => setA({ ...a, [key]: e.target.checked })} /> {label}</label>
      <span />
    </>
  );
  const isAdmin = acct.accounts.some((x) => x.admin);

  return (
    <Modal open onClose={onClose} title={filter ? "Edit filter" : "Create a filter"}>
      <form className="filter-form" onSubmit={(e) => void submit(e)}>
        {text("from", "From", "Name or address; several with commas")}
        {text("to", "To", "To or Cc")}
        {text("subject", "Subject")}
        {text("hasWords", "Has the words", 'Words in the message; "a phrase" in quotes')}
        {text("doesntHave", "Doesn't have")}
        <div className="filter-field">
          <span>Size</span>
          <div className="filter-size">
            <select className="text-input" aria-label="Larger or smaller" value={sizeOp} onChange={(e) => setSizeOp(e.target.value)}>
              <option value="larger">greater than</option>
              <option value="smaller">less than</option>
            </select>
            <input className="text-input" inputMode="decimal" aria-label="Size" value={sizeValue} onChange={(e) => setSizeValue(e.target.value)} />
            <select className="text-input" aria-label="Unit" value={sizeUnit} onChange={(e) => setSizeUnit(e.target.value as keyof typeof UNITS)}>
              {Object.keys(UNITS).map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
          </div>
        </div>
        <label><input type="checkbox" checked={c.hasAttachment} onChange={(e) => setC({ ...c, hasAttachment: e.target.checked })} /> Has attachment</label>

        <div className="filter-then">When a message arrives that matches:</div>
        <div className="filter-actions">
          {check("skipInbox", "Skip the Inbox (Archive it)")}
          {check("markRead", "Mark as read")}
          {check("star", "Star it")}
          <label className={`filter-action ${acct.labels.length ? "" : "off"}`}>
            <input type="checkbox" checked={!!a.label} disabled={!acct.labels.length}
              onChange={(e) => setA({ ...a, label: e.target.checked ? (acct.labels[0]?.keyword ?? null) : null })} />
            Apply the label
          </label>
          {acct.labels.length ? (
            <select className="text-input" aria-label="Label" value={a.label ?? ""} onChange={(e) => setA({ ...a, label: e.target.value || null })}>
              <option value="">Choose a label…</option>
              {acct.labels.map((l) => <option key={l.keyword} value={l.keyword}>{l.name}</option>)}
            </select>
          ) : (
            <span className="filter-note">No labels yet</span>
          )}
          <label className={`filter-action ${folders.length ? "" : "off"}`}>
            <input type="checkbox" checked={!!a.moveTo} disabled={!folders.length}
              onChange={(e) => setA({ ...a, moveTo: e.target.checked ? (folders[0]?.path ?? null) : null })} />
            Move to
          </label>
          {folders.length ? (
            <select className="text-input" aria-label="Folder" value={a.moveTo ?? ""} onChange={(e) => setA({ ...a, moveTo: e.target.value || null })}>
              <option value="">Choose a folder…</option>
              {folders.map((m) => <option key={m.id} value={m.path}>{m.path}</option>)}
            </select>
          ) : (
            <span className="filter-note">No folders yet</span>
          )}
          {check("delete", "Delete it")}
          {state.features.forwarding || a.forwardTo ? (
            <>
              <label className="filter-action">
                <input type="checkbox" checked={a.forwardTo !== null} onChange={(e) => setA({ ...a, forwardTo: e.target.checked ? "" : null })} />
                Forward it to
              </label>
              <input className="text-input" type="email" aria-label="Forward to" placeholder="address@example.com" value={a.forwardTo ?? ""}
                onChange={(e) => setA({ ...a, forwardTo: e.target.value })} />
            </>
          ) : (
            <>
              <label className="filter-action off"><input type="checkbox" disabled /> Forward it to</label>
              <span className="filter-note">{isAdmin ? "Turned off here: allow it on the admin page." : "Turned off on this server."}</span>
            </>
          )}
        </div>
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className="buttons">
          <button type="button" className="btn btn-text" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? "Saving…" : filter ? "Save filter" : "Create filter"}</button>
        </div>
      </form>
    </Modal>
  );
}

const offset = () => {
  const m = -new Date().getTimezoneOffset();
  return `${m < 0 ? "-" : "+"}${String(Math.floor(Math.abs(m) / 60)).padStart(2, "0")}${String(Math.abs(m) % 60).padStart(2, "0")}`;
};

/** Settings > General: the vacation responder, as Gmail lays it out. */
export function VacationSetting() {
  const acct = useAccount();
  const client = useQueryClient();
  const query = useFilters();
  const saved = query.data?.vacation;
  const [v, setVacation] = useState<Vacation | null>(null);
  const [changed, setChanged] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (saved) setVacation({ ...saved, start: saved.start ?? new Date().toISOString().slice(0, 10) });
    setChanged(false);
  }, [saved]);
  const setV = (next: Vacation) => {
    setVacation(next);
    setChanged(true);
  };
  if (query.error || !query.data?.features.vacation) return null;
  if (!v || !saved) return <div className="setting"><div className="name">Vacation responder</div><div className="options"><div className="spinner" /></div></div>;
  const save = async () => {
    setBusy(true);
    try {
      const state = await api.saveVacation(acct.index, { ...v, zone: offset() });
      client.setQueryData(["filters", acct.index], state);
      toast(v.on ? "Vacation responder on." : "Vacation responder off.");
    } catch (err) {
      toast((err as Error).message, { error: true });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="setting">
      <div className="name">
        Vacation responder
        <small>Sends an automatic reply to incoming messages, at most once every 4 days to each sender. Your mail server sends it, so it works with Viauna closed.</small>
      </div>
      <div className="options vacation">
        <label><input type="radio" name="vacation" checked={!v.on} onChange={() => setV({ ...v, on: false })} /> Vacation responder off</label>
        <label><input type="radio" name="vacation" checked={v.on} onChange={() => setV({ ...v, on: true })} /> Vacation responder on</label>
        <div className="vacation-days">
          <label>First day: <input className="text-input" type="date" value={v.start ?? ""} disabled={!v.on} onChange={(e) => setV({ ...v, start: e.target.value || null })} /></label>
          <label>
            <input type="checkbox" checked={v.end !== null} disabled={!v.on} onChange={(e) => setV({ ...v, end: e.target.checked ? (v.start ?? new Date().toISOString().slice(0, 10)) : null })} />
            Last day: <input className="text-input" type="date" value={v.end ?? ""} disabled={!v.on || v.end === null} onChange={(e) => setV({ ...v, end: e.target.value || null })} />
          </label>
        </div>
        <input className="text-input" aria-label="Subject" placeholder="Subject" value={v.subject} disabled={!v.on} onChange={(e) => setV({ ...v, subject: e.target.value })} />
        <textarea className="text-input" aria-label="Message" placeholder="Message" rows={5} value={v.message} disabled={!v.on} onChange={(e) => setV({ ...v, message: e.target.value })} />
        <button type="button" className="btn btn-primary" disabled={busy || !changed} onClick={() => void save()}>
          Save changes
        </button>
      </div>
    </div>
  );
}
