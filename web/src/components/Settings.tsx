import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { ui, useAccount } from "../lib/account";
import { api } from "../lib/api";
import { navigate } from "../lib/router";
import { type Density, type Theme, prefs, toast } from "../lib/store";
import type { Identity, Settings } from "../lib/types";
import { IconButton } from "./common";
import { EditorArea, FormatBar, useMailEditor } from "./Editor";

type Tab = "general" | "accounts" | "labels" | "folders";

export function SettingsView() {
  const [tab, setTab] = useState<Tab>("general");
  const acct = useAccount();
  return (
    <>
      <div className="toolbar">
        <IconButton label="Back to inbox" onClick={() => navigate(`/u/${acct.index}/inbox`)}><ArrowLeft size={20} /></IconButton>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 400 }}>Settings</h2>
      </div>
      <div className="settings-tabs" role="tablist">
        {(["general", "accounts", "labels", "folders"] as Tab[]).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
            {{ general: "General", accounts: "Accounts", labels: "Labels", folders: "Folders" }[t]}
          </button>
        ))}
      </div>
      <div className="settings">
        {tab === "general" && <General />}
        {tab === "accounts" && <Accounts />}
        {tab === "labels" && <Labels />}
        {tab === "folders" && <Folders />}
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
      toast("Settings saved.");
    } catch (err) {
      toast((err as Error).message, { error: true });
    }
  };
}

function General() {
  const acct = useAccount();
  const save = useSave();
  const p = prefs.use();
  const s = acct.settings;
  const [signature, setSignature] = useState(s?.signature ?? "");
  const editor = useMailEditor(s?.signature ?? "", "", setSignature, false);
  useEffect(() => {
    if (s && editor && !editor.isFocused && editor.getHTML() !== s.signature) editor.commands.setContent(s.signature);
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
        <div className="name">Keyboard shortcuts</div>
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
    </>
  );
}

function Accounts() {
  const acct = useAccount();
  const save = useSave();
  const s = acct.settings;
  const [name, setName] = useState(s?.name ?? "");
  const [aliases, setAliases] = useState<Identity[]>(s?.aliases ?? []);
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
                <IconButton label={`Remove ${l.name}`} onClick={async () => {
                  if (!confirm(`Remove the label "${l.name}" from every conversation?`)) return;
                  try {
                    await api.deleteLabel(acct.index, l.keyword);
                    void client.invalidateQueries({ queryKey: ["mailboxes", acct.index] });
                    void client.invalidateQueries({ queryKey: ["threads", acct.index] });
                  } catch (err) {
                    toast((err as Error).message, { error: true });
                  }
                }}><Trash2 size={18} /></IconButton>
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
                <IconButton label={`Delete ${m.name}`} onClick={async () => {
                  if (!confirm(`Delete the folder "${m.path}" and all ${m.total} messages in it? This can't be undone.`)) return;
                  try {
                    await api.deleteMailbox(acct.index, m.id);
                    void client.invalidateQueries({ queryKey: ["mailboxes", acct.index] });
                  } catch (err) {
                    toast((err as Error).message, { error: true });
                  }
                }}><Trash2 size={18} /></IconButton>
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
