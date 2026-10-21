import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink, Pencil, Plus, Trash2 } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { ui, useAccount } from "../lib/account";
import { api } from "../lib/api";
import { browserZone, zoneOffset } from "../lib/calendar";
import { useConfig } from "../lib/config";
import { navigate, usePath } from "../lib/router";
import { type Density, type Theme, prefs, toast } from "../lib/store";
import type { Identity, Settings } from "../lib/types";
import { IconButton, Modal, confirmDeleteFolder, confirmRemoveLabel } from "./common";
import { EditorArea, FormatBar, useMailEditor } from "./Editor";
import { MOD_KEY } from "./CommandMenu";
import { FiltersTab, VacationSetting } from "./Filters";

type Tab = "general" | "accounts" | "labels" | "folders" | "filters" | "calendar";

export function SettingsView() {
  const acct = useAccount();
  const config = useConfig().data;
  const tabs: Tab[] = [
    "general", "accounts", "labels", "folders",
    ...(config?.filters ? (["filters"] as Tab[]) : []),
    ...(config?.calendar ? (["calendar"] as Tab[]) : []),
  ];
  // The tab is in the address (?tab=filters), so a reload, Back or the command menu lands on it.
  const asked = new URLSearchParams(usePath().split("?")[1] ?? "").get("tab") as Tab | null;
  const tab: Tab = asked && tabs.includes(asked) ? asked : "general";
  const setTab = (t: Tab) => navigate(`/u/${acct.index}/settings${t === "general" ? "" : `?tab=${t}`}`, { replace: true });
  return (
    <>
      <div className="toolbar">
        <IconButton label="Back to inbox" onClick={() => navigate(`/u/${acct.index}/inbox`)}><ArrowLeft size={20} /></IconButton>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 400 }}>Settings</h2>
      </div>
      <div className="settings-tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
            {{ general: "General", accounts: "Accounts", labels: "Labels", folders: "Folders", filters: "Filters", calendar: "Calendar" }[t]}
          </button>
        ))}
      </div>
      <div className="settings">
        {tab === "general" && <General />}
        {tab === "accounts" && <Accounts />}
        {tab === "labels" && <Labels />}
        {tab === "folders" && <Folders />}
        {tab === "filters" && <FiltersTab />}
        {tab === "calendar" && <CalendarSettings />}
      </div>
    </>
  );
}

function useSave() {
  const acct = useAccount();
  const client = useQueryClient();
  return async (patch: Partial<Settings>) => {
    try {
      await api.saveSettings(acct.index, patch);
      await client.invalidateQueries({ queryKey: ["settings", acct.index] });
      void client.invalidateQueries({ queryKey: ["session"] });
      // The server pages lists and renders messages by these settings, so what's cached
      // was made with the old ones: drop it, or going back shows the old page size.
      if ("pageSize" in patch) client.removeQueries({ queryKey: ["threads", acct.index] });
      if ("images" in patch) client.removeQueries({ queryKey: ["message", acct.index] });
      toast("Settings saved.");
    } catch (err) {
      toast((err as Error).message, { error: true });
    }
  };
}

/** The zones the browser knows, for the time-zone list. */
const ZONES: string[] = (() => {
  try {
    return (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    return [];
  }
})();

function CalendarSettings() {
  const acct = useAccount();
  const save = useSave();
  const p = prefs.use();
  const s = acct.settings;
  if (!s) return <div className="empty"><div className="spinner lg" /></div>;
  const device = browserZone();
  const zones = s.timeZone && !ZONES.includes(s.timeZone) ? [s.timeZone, ...ZONES] : ZONES;
  return (
    <>
      <div className="setting">
        <div className="name">Time zone<small>The calendar shows times in it, wherever you open it.</small></div>
        <div className="options">
          <select value={s.timeZone} aria-label="Time zone" onChange={(e) => void save({ timeZone: e.target.value })}>
            <option value="">This device's ({device.replace(/_/g, " ")}, {zoneOffset(device)})</option>
            {zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, " ")} ({zoneOffset(z)})</option>)}
          </select>
        </div>
      </div>
      <div className="setting">
        <div className="name">Second time zone<small>Its times beside yours, in the day and week views.</small></div>
        <div className="options">
          <select value={s.secondTimeZone} aria-label="Second time zone" onChange={(e) => void save({ secondTimeZone: e.target.value })}>
            <option value="">None</option>
            {zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, " ")} ({zoneOffset(z)})</option>)}
          </select>
        </div>
      </div>
      <div className="setting">
        <div className="name">Start of the week</div>
        <div className="options">
          <select value={s.weekStart} aria-label="Start of the week" onChange={(e) => void save({ weekStart: e.target.value as Settings["weekStart"] })}>
            <option value="auto">As usual for your language</option>
            <option value="sunday">Sunday</option>
            <option value="monday">Monday</option>
            <option value="saturday">Saturday</option>
          </select>
        </div>
      </div>
      <div className="setting">
        <div className="name">Default event length<small>For a new event, and a click on the calendar.</small></div>
        <div className="options">
          <select value={s.eventMinutes} aria-label="Default event length" onChange={(e) => void save({ eventMinutes: Number(e.target.value) as Settings["eventMinutes"] })}>
            {[15, 30, 45, 60, 90, 120].map((m) => <option key={m} value={m}>{m < 60 ? `${m} minutes` : m === 60 ? "1 hour" : `${m / 60} hours`}</option>)}
          </select>
        </div>
      </div>
      <div className="setting">
        <div className="name">View<small>In this browser.</small></div>
        <div className="options">
          <label><input type="checkbox" checked={p.calendarWeekends} onChange={(e) => prefs.set((x) => ({ ...x, calendarWeekends: e.target.checked }))} /> Show weekends</label>
          <label><input type="checkbox" checked={p.calendarWeekNumbers} onChange={(e) => prefs.set((x) => ({ ...x, calendarWeekNumbers: e.target.checked }))} /> Show week numbers</label>
        </div>
      </div>
    </>
  );
}

function General() {
  const acct = useAccount();
  const save = useSave();
  const p = prefs.use();
  const s = acct.settings;
  const [signature, setSignature] = useState(s?.signature ?? "");
  const editor = useMailEditor(s?.signature ?? "", "", setSignature, false);
  useEffect(() => {
    // TipTap destroys an editor whose component took over a millisecond to mount, and
    // renders again with a new one; the destroyed one throws on getHTML().
    if (s && editor && !editor.isDestroyed && !editor.isFocused && editor.getHTML() !== s.signature) editor.commands.setContent(s.signature);
  }, [s, editor]);
  if (!s) return <div className="empty"><div className="spinner lg" /></div>;
  const setPref = <K extends keyof typeof p>(k: K, v: (typeof p)[K]) => prefs.set((x) => ({ ...x, [k]: v }));
  return (
    <>
      <div className="setting">
        <div className="name">Theme</div>
        <div className="options">
          {(["system", "light", "dark"] as Theme[]).map((t) => (
            <label key={t}><input type="radio" name="theme" checked={p.theme === t} onChange={() => setPref("theme", t)} /> {t === "system" ? "Match my device" : t[0].toUpperCase() + t.slice(1)}</label>
          ))}
        </div>
      </div>
      <div className="setting">
        <div className="name">Density</div>
        <div className="options">
          {(["default", "comfortable", "compact"] as Density[]).map((d) => (
            <label key={d}><input type="radio" name="density" checked={p.density === d} onChange={() => setPref("density", d)} /> {d[0].toUpperCase() + d.slice(1)}</label>
          ))}
        </div>
      </div>
      <div className="setting">
        <div className="name">Maximum page size<small>Conversations shown per page.</small></div>
        <div className="options">
          <select value={s.pageSize} onChange={(e) => void save({ pageSize: Number(e.target.value) as Settings["pageSize"] })}>
            {[25, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
      </div>
      <div className="setting">
        <div className="name">Images<small>Remote images can tell senders when, where and that you opened a message.</small></div>
        <div className="options">
          <label><input type="radio" name="images" checked={s.images === "ask"} onChange={() => void save({ images: "ask" })} /> Ask before displaying external images</label>
          <label><input type="radio" name="images" checked={s.images === "always"} onChange={() => void save({ images: "always" })} /> Always display external images</label>
        </div>
      </div>
      <div className="setting">
        <div className="name">Keyboard shortcuts<small>Keys that act on their own, such as c to compose and e to archive. {MOD_KEY}K opens the command menu either way.</small></div>
        <div className="options">
          <label><input type="radio" name="kb" checked={p.shortcuts} onChange={() => setPref("shortcuts", true)} /> Keyboard shortcuts on</label>
          <label><input type="radio" name="kb" checked={!p.shortcuts} onChange={() => setPref("shortcuts", false)} /> Keyboard shortcuts off</label>
          <button type="button" className="btn btn-text" style={{ paddingLeft: 0 }} onClick={() => ui.set((x) => ({ ...x, shortcutsOpen: true }))}>Show all shortcuts</button>
        </div>
      </div>
      <div className="setting">
        <div className="name">Desktop notifications<small>Shown for new mail while this tab is in the background.</small></div>
        <div className="options">
          <label>
            <input type="checkbox" checked={p.notifications} onChange={async (e) => {
              if (e.target.checked && "Notification" in window && Notification.permission !== "granted") {
                const result = await Notification.requestPermission();
                if (result !== "granted") return toast("Notifications are blocked for this site in your browser.", { error: true });
              }
              setPref("notifications", e.target.checked);
            }} /> New mail notifications on
          </label>
        </div>
      </div>
      <div className="setting">
        <div className="name">Signature<small>Added to the end of new messages and replies.</small></div>
        <div className="options" style={{ width: "100%" }}>
          <div className="sig-editor">
            <EditorArea editor={editor} />
            <FormatBar editor={editor} />
          </div>
          <button type="button" className="btn btn-primary" disabled={signature === s.signature} onClick={() => void save({ signature })}>Save signature</button>
        </div>
      </div>
      <VacationAvailable />
    </>
  );
}

/** The vacation responder, where the server has one. */
function VacationAvailable() {
  const config = useConfig().data;
  return config?.vacation ? <VacationSetting /> : null;
}

function Accounts() {
  const acct = useAccount();
  const save = useSave();
  const s = acct.settings;
  const [name, setName] = useState(s?.name ?? "");
  const [aliases, setAliases] = useState<Identity[]>(s?.aliases ?? []);
  const [changingPassword, setChangingPassword] = useState(false);
  useEffect(() => {
    if (s) {
      setName(s.name);
      setAliases(s.aliases);
    }
  }, [s]);
  if (!s) return null;
  return (
    <>
      <div className="setting">
        <div className="name">Your name<small>Shown to people you write to.</small></div>
        <div className="options">
          <input className="text-input" style={{ maxWidth: 400 }} value={name} onChange={(e) => setName(e.target.value)} placeholder={acct.email} />
          <button type="button" className="btn btn-primary" disabled={name === s.name} onClick={() => void save({ name })}>Save</button>
        </div>
      </div>
      <div className="setting">
        <div className="name">Send mail as<small>Other addresses this mailbox may send from — aliases your mail server accepts for this login.</small></div>
        <div className="options" style={{ width: "100%" }}>
          <table>
            <tbody>
              <tr><td>{s.name || "(no name)"}</td><td>{acct.email}</td><td style={{ color: "var(--text-3)" }}>default</td></tr>
              {aliases.map((a, i) => (
                <tr key={i}>
                  <td><input className="text-input" style={{ height: 36, fontSize: 14 }} placeholder="Name" value={a.name}
                    onChange={(e) => setAliases(aliases.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} /></td>
                  <td><input className="text-input" style={{ height: 36, fontSize: 14 }} placeholder="address@example.com" value={a.address}
                    onChange={(e) => setAliases(aliases.map((x, j) => (j === i ? { ...x, address: e.target.value } : x)))} /></td>
                  <td><IconButton label="Remove" onClick={() => setAliases(aliases.filter((_, j) => j !== i))}><Trash2 size={18} /></IconButton></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn btn-outline" onClick={() => setAliases([...aliases, { name: s.name, address: "" }])}><Plus size={16} /> Add another address</button>
            <button type="button" className="btn btn-primary" disabled={JSON.stringify(aliases) === JSON.stringify(s.aliases)} onClick={() => void save({ aliases })}>Save</button>
          </div>
        </div>
      </div>
      {acct.password && (
        <div className="setting">
          <div className="name">Password<small>The password for {acct.email}, here and in your other mail apps.</small></div>
          <div className="options">
            {acct.password.method === "link" ? (
              <a className="btn btn-outline" href={acct.password.url} target="_blank" rel="noopener noreferrer">
                Change password <ExternalLink size={16} />
              </a>
            ) : (
              <button type="button" className="btn btn-outline" onClick={() => setChangingPassword(true)}>Change password</button>
            )}
          </div>
        </div>
      )}
      {changingPassword && <PasswordDialog onClose={() => setChangingPassword(false)} />}
      <div className="setting">
        <div className="name">Signed-in accounts</div>
        <div className="options">
          {acct.accounts.map((a) => <div key={a.index}>{a.email}{a.index === acct.index ? " (this one)" : ""}</div>)}
          <button type="button" className="btn btn-outline" onClick={() => (location.href = "/login?add=1")}><Plus size={16} /> Add another account</button>
        </div>
      </div>
    </>
  );
}

function PasswordDialog({ onClose }: { onClose: () => void }) {
  const acct = useAccount();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== again) return setError("The new passwords don't match.");
    setBusy(true);
    setError("");
    try {
      const r = await api.changePassword(acct.index, current, next);
      toast(r.signedOut ? `Password changed. ${r.signedOut === 1 ? "Another browser was" : `${r.signedOut} other browsers were`} signed out.` : "Password changed.");
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title="Change password">
      <form className="password-form" onSubmit={(e) => void submit(e)}>
        <input type="text" autoComplete="username" value={acct.email} readOnly hidden />
        <input className="text-input" type="password" autoComplete="current-password" aria-label="Current password" placeholder="Current password"
          value={current} autoFocus onChange={(e) => setCurrent(e.target.value)} />
        <input className="text-input" type="password" autoComplete="new-password" aria-label="New password" placeholder="New password" minLength={8}
          value={next} onChange={(e) => setNext(e.target.value)} />
        <input className="text-input" type="password" autoComplete="new-password" aria-label="Confirm new password" placeholder="Confirm new password"
          value={again} onChange={(e) => setAgain(e.target.value)} />
        <p className="dialog-text" style={{ fontSize: 14 }}>
          At least 8 characters. Other browsers signed in to this mailbox will be signed out, and your other mail apps will ask for the new password.
        </p>
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className="buttons">
          <button type="button" className="btn btn-text" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !current || !next || !again}>{busy ? "Changing…" : "Change password"}</button>
        </div>
      </form>
    </Modal>
  );
}

function Labels() {
  const acct = useAccount();
  const client = useQueryClient();
  return (
    <div className="setting" style={{ gridTemplateColumns: "1fr" }}>
      <table>
        <thead><tr><td><b>Label</b></td><td><b>Conversations</b></td><td /></tr></thead>
        <tbody>
          {acct.labels.map((l) => (
            <tr key={l.keyword}>
              <td><span className="chip" style={l.color ? { background: l.color } : undefined}>{l.name}</span></td>
              <td>{l.total.toLocaleString()}</td>
              <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                <IconButton label={`Edit ${l.name}`} onClick={() => ui.set((s) => ({ ...s, labelDialog: { label: l } }))}><Pencil size={18} /></IconButton>
                <IconButton label={`Remove ${l.name}`} onClick={() => confirmRemoveLabel(client, acct.index, l)}><Trash2 size={18} /></IconButton>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div><button type="button" className="btn btn-outline" onClick={() => ui.set((s) => ({ ...s, labelDialog: {} }))}><Plus size={16} /> Create new label</button></div>
      <p style={{ color: "var(--text-3)", maxWidth: 640 }}>
        Labels are stored on your mail server as message keywords, so they follow your mail to other devices. Thunderbird and Apple Mail show them as tags.
      </p>
    </div>
  );
}

function Folders() {
  const acct = useAccount();
  const client = useQueryClient();
  const folders = acct.mailboxes.filter((m) => !m.specialUse);
  return (
    <div className="setting" style={{ gridTemplateColumns: "1fr" }}>
      <table>
        <thead><tr><td><b>Folder</b></td><td><b>Messages</b></td><td /></tr></thead>
        <tbody>
          {folders.map((m) => (
            <tr key={m.id}>
              <td>{m.path}</td>
              <td>{m.total.toLocaleString()}</td>
              <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                <IconButton label={`Rename ${m.name}`} onClick={() => ui.set((s) => ({ ...s, folderDialog: { mailbox: m } }))}><Pencil size={18} /></IconButton>
                <IconButton label={`Delete ${m.name}`} onClick={() => confirmDeleteFolder(client, acct.index, m, acct.mailboxes)}><Trash2 size={18} /></IconButton>
              </td>
            </tr>
          ))}
          {!folders.length && <tr><td colSpan={3} style={{ color: "var(--text-3)" }}>No folders yet.</td></tr>}
        </tbody>
      </table>
      <div><button type="button" className="btn btn-outline" onClick={() => ui.set((s) => ({ ...s, folderDialog: {} }))}><Plus size={16} /> Create new folder</button></div>
    </div>
  );
}
