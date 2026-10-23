import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink, Pencil, Plus, Trash2 } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { ui, useAccount } from "../lib/account";
import { api } from "../lib/api";
import { browserZone, calendarsQuery, zoneOffset } from "../lib/calendar";
import { useConfig } from "../lib/config";
import { relative } from "../lib/format";
import { disablePush, enablePush, pushOn, pushSupported, testPush } from "../lib/push";
import { navigate, usePath } from "../lib/router";
import { type Density, type Theme, prefs, toast } from "../lib/store";
import type { Reminder, SendAddress, SendAddresses, SendAsPolicy, Settings } from "../lib/types";
import { IconButton, Modal, confirmDeleteFolder, confirmRemoveLabel } from "./common";
import { EditorArea, FormatBar, useMailEditor } from "./Editor";
import { MOD_KEY } from "./CommandMenu";
import { FiltersTab, VacationSetting } from "./Filters";
import { RemindersField } from "./Reminders";

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

/** iOS and iPadOS show web notifications only from an app added to the Home Screen. */
const iosBrowserTab = () =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) && !(navigator as { standalone?: boolean }).standalone && !matchMedia("(display-mode: standalone)").matches;

/** This mailbox's calendar reminders in this browser even with Viauna closed (Web Push). */
function ClosedNotifications() {
  const acct = useAccount();
  const key = useConfig().data?.pushKey ?? null;
  const [on, setOn] = useState(() => pushOn(acct.email));
  const [busy, setBusy] = useState(false);
  if (!key) return null;
  const run = async (action: () => Promise<void>, done: string) => {
    setBusy(true);
    try {
      await action();
      setOn(pushOn(acct.email));
      toast(done);
    } catch (err) {
      toast((err as Error).message, { error: true });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="setting">
      <div className="name">
        Reminders with Viauna closed
        <small>This browser shows this mailbox's calendar reminders even when no Viauna tab is open, sent through its own push service, encrypted.</small>
      </div>
      <div className="options">
        {iosBrowserTab() ? (
          <span>On an iPhone or iPad, add Viauna to your Home Screen first (Share, then Add to Home Screen), open it from there, and turn them on in its Settings.</span>
        ) : !pushSupported() ? (
          <span>This browser can't show notifications with Viauna closed.</span>
        ) : on ? (
          <>
            <span>On in this browser.</span>
            <div className="buttons" style={{ margin: 0 }}>
              <button type="button" className="btn btn-outline" disabled={busy} onClick={() => void run(() => testPush(acct.index), "Test sent. It should appear in a moment.")}>Send a test</button>
              <button type="button" className="btn btn-text" disabled={busy} onClick={() => void run(() => disablePush(acct.index, acct.email), "Turned off in this browser.")}>Turn off</button>
            </div>
          </>
        ) : (
          <button type="button" className="btn btn-outline" disabled={busy} onClick={() => void run(() => enablePush(acct.index, acct.email, key), "Turned on in this browser.")}>Turn on in this browser</button>
        )}
      </div>
    </div>
  );
}

/** Default reminders, saved a moment after the last change rather than at every keystroke. */
function DefaultReminders({ label, saved, allDay, onSave }: { label: string; saved: Reminder[]; allDay: boolean; onSave: (r: Reminder[]) => Promise<void> }) {
  const acct = useAccount();
  const [value, setValue] = useState(saved);
  useEffect(() => {
    if (JSON.stringify(value) === JSON.stringify(saved)) return;
    const t = setTimeout(() => void onSave(value), 800);
    return () => clearTimeout(t);
  }, [value]);
  return <RemindersField label={label} value={value} allDay={allDay} email={!!acct.accounts[acct.index]?.emailReminders} onChange={setValue} />;
}

function CalendarSettings() {
  const acct = useAccount();
  const save = useSave();
  const p = prefs.use();
  const s = acct.settings;
  const calendars = useQuery({ ...calendarsQuery(acct.index), staleTime: 60_000 });
  const own = (calendars.data?.calendars ?? []).filter((c) => !c.readOnly);
  if (!s) return <div className="empty"><div className="spinner lg" /></div>;
  const device = browserZone();
  const zones = s.timeZone && !ZONES.includes(s.timeZone) ? [s.timeZone, ...ZONES] : ZONES;
  return (
    <>
      <div className="setting">
        <div className="name">Time zone<small>The calendar shows times in it, wherever you open it.</small></div>
        <div className="options">
          <select className="text-input" value={s.timeZone} aria-label="Time zone" onChange={(e) => void save({ timeZone: e.target.value })}>
            <option value="">This device's ({device.replace(/_/g, " ")}, {zoneOffset(device)})</option>
            {zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, " ")} ({zoneOffset(z)})</option>)}
          </select>
        </div>
      </div>
      <div className="setting">
        <div className="name">Second time zone<small>Its times beside yours, in the day and week views.</small></div>
        <div className="options">
          <select className="text-input" value={s.secondTimeZone} aria-label="Second time zone" onChange={(e) => void save({ secondTimeZone: e.target.value })}>
            <option value="">None</option>
            {zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, " ")} ({zoneOffset(z)})</option>)}
          </select>
        </div>
      </div>
      <div className="setting">
        <div className="name">Start of the week</div>
        <div className="options">
          <select className="text-input" value={s.weekStart} aria-label="Start of the week" onChange={(e) => void save({ weekStart: e.target.value as Settings["weekStart"] })}>
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
          <select className="text-input" value={s.eventMinutes} aria-label="Default event length" onChange={(e) => void save({ eventMinutes: Number(e.target.value) as Settings["eventMinutes"] })}>
            {[15, 30, 45, 60, 90, 120].map((m) => <option key={m} value={m}>{m < 60 ? `${m} minutes` : m === 60 ? "1 hour" : `${m / 60} hours`}</option>)}
          </select>
        </div>
      </div>
      <div className="setting">
        <div className="name">Notifications<small>The reminders a new event starts with. Each event can have its own.</small></div>
        <div className="options reminder-defaults">
          <span className="muted">For events at a time</span>
          <DefaultReminders label="Notifications for events at a time" saved={s.reminders} allDay={false} onSave={(reminders) => save({ reminders })} />
          <span className="muted">For all-day events</span>
          <DefaultReminders label="Notifications for all-day events" saved={s.allDayReminders} allDay onSave={(allDayReminders) => save({ allDayReminders })} />
        </div>
      </div>
      {own.length > 1 && (
        <div className="setting">
          <div className="name">Invitations<small>The calendar an invitation goes into when you answer it, unless you pick another on it.</small></div>
          <div className="options">
            <select className="text-input" aria-label="Calendar for invitations" value={s.invitationCalendar ?? own.find((c) => c.primary)?.id ?? ""}
              onChange={(e) => void save({ invitationCalendar: Number(e.target.value) })}>
              {own.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        </div>
      )}
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
          <select className="text-input" aria-label="Maximum page size" value={s.pageSize} onChange={(e) => void save({ pageSize: Number(e.target.value) as Settings["pageSize"] })}>
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
        <div className="name">Desktop notifications<small>Shown for new mail and calendar reminders while this tab is in the background.</small></div>
        <div className="options">
          <label>
            <input type="checkbox" checked={p.notifications} onChange={async (e) => {
              if (e.target.checked && "Notification" in window && Notification.permission !== "granted") {
                const result = await Notification.requestPermission();
                if (result !== "granted") return toast("Notifications are blocked for this site in your browser.", { error: true });
              }
              setPref("notifications", e.target.checked);
            }} /> Desktop notifications on
          </label>
        </div>
      </div>
      <ClosedNotifications />
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
  const [changingPassword, setChangingPassword] = useState(false);
  useEffect(() => {
    if (s) setName(s.name);
  }, [s]);
  if (!s) return null;
  return (
    <>
      <div className="setting">
        <div className="name">Your name<small>Shown to people you write to.</small></div>
        <div className="options">
          <input className="text-input" value={name} onChange={(e) => setName(e.target.value)} placeholder={acct.email} />
          <button type="button" className="btn btn-primary" disabled={name === s.name} onClick={() => void save({ name })}>Save</button>
        </div>
      </div>
      <SendMailAs />
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

/** The addresses this mailbox sends as: its own, and others, each confirmed before it's sent from. */
function SendMailAs() {
  const acct = useAccount();
  const client = useQueryClient();
  const q = useQuery({ queryKey: ["identities", acct.index], queryFn: () => api.identities(acct.index) });
  const [adding, setAdding] = useState(false);
  const data = q.data;
  const update = (next: SendAddresses) => client.setQueryData(["identities", acct.index], next);
  const help = !data
    ? ""
    : data.sendAs === "off"
      ? "This server sends only from your mailbox's own address."
      : data.sendAs === "server"
        ? "Other addresses you send from. Your mail server must accept each one as yours."
        : "Other addresses you send from. Each is confirmed once, with a code emailed to it.";
  return (
    <div className="setting">
      <div className="name">Send mail as<small>{help}</small></div>
      <div className="options send-as">
        {q.error ? (
          <p className="form-error">{q.error.message}</p>
        ) : !data ? (
          <div className="spinner" />
        ) : (
          <>
            <ul className="identities">
              {data.identities.map((i) => <IdentityRow key={i.id ?? "own"} identity={i} policy={data.sendAs} onChange={update} />)}
            </ul>
            {data.sendAs !== "off" &&
              (adding ? (
                <AddIdentity servers={data.servers} onDone={(next) => {
                  if (next) update(next);
                  setAdding(false);
                }} />
              ) : (
                <button type="button" className="btn btn-outline" onClick={() => setAdding(true)}><Plus size={16} /> Add another address</button>
              ))}
          </>
        )}
      </div>
    </div>
  );
}

/** One address: who it is, whether it can be sent from, and what it still needs. */
function IdentityRow({ identity: i, policy, onChange }: { identity: SendAddress; policy: SendAsPolicy; onChange: (next: SendAddresses) => void }) {
  const acct = useAccount();
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = i.id ?? "own";
  const run = async (action: () => Promise<SendAddresses>, done?: string) => {
    setBusy(true);
    try {
      onChange(await action());
      if (done) toast(done);
      return true;
    } catch (err) {
      toast((err as Error).message, { error: true });
      return false;
    } finally {
      setBusy(false);
    }
  };
  const name = i.own ? acct.settings?.name : i.name;
  const status = i.own && i.confirmedBy === "login"
    ? "Your mailbox's own address."
    : i.usable
      ? i.own ? "Your mailbox's own address, confirmed." : "Confirmed."
      : i.confirmed
        ? !i.own && policy === "off" ? "This server no longer sends from other addresses." : "This server no longer sends through other providers' mail servers."
        : i.own
          ? "You signed in with a separate username, so this address isn't confirmed yet."
          : policy === "server" && !i.server ? "Your mail server hasn't accepted it as yours." : "Not confirmed yet.";
  const waiting = !i.confirmed && i.codeSentAt !== null;
  // A code where no mail server's yes can confirm it: always but with SEND_AS=server, and then for
  // the mailbox's own address and for one at another provider.
  const canCode = !i.confirmed && (policy !== "off" || i.own) && (policy !== "server" || i.own || !!i.server);
  return (
    <li className="identity">
      <div className="identity-main">
        {renaming !== null ? (
          <form className="identity-act" onSubmit={(e) => {
            e.preventDefault();
            void run(() => api.renameIdentity(acct.index, i.id!, renaming)).then((ok) => ok && setRenaming(null));
          }}>
            <input className="text-input" aria-label={`Name for ${i.address}`} placeholder="Name" value={renaming} autoFocus maxLength={200} onChange={(e) => setRenaming(e.target.value)} />
            <button type="submit" className="btn btn-primary" disabled={busy}>Save</button>
            <button type="button" className="btn btn-text" onClick={() => setRenaming(null)}>Cancel</button>
          </form>
        ) : (
          <div className="identity-who">{name ? <>{name} <span className="muted">&lt;{i.address}&gt;</span></> : i.address}</div>
        )}
        <div className="identity-status">
          {status}
          {waiting && ` A code went to it ${relative(i.codeSentAt!)}.`}
          {i.server && ` Sent through ${i.server.host}:${i.server.port}.`}
        </div>
        {canCode && (
          <form className="identity-act" onSubmit={(e) => {
            e.preventDefault();
            void run(() => api.confirmIdentity(acct.index, ref, code), `You can send as ${i.address} now.`).then((ok) => ok && setCode(""));
          }}>
            {waiting && (
              <>
                <input className="text-input identity-code" aria-label={`Code sent to ${i.address}`} placeholder="Code" inputMode="numeric" autoComplete="one-time-code"
                  value={code} maxLength={12} onChange={(e) => setCode(e.target.value)} />
                <button type="submit" className="btn btn-primary" aria-label={`Confirm ${i.address}`} disabled={busy || !code.trim()}>Confirm</button>
              </>
            )}
            <button type="button" className={`btn ${waiting ? "btn-text" : "btn-outline"}`} disabled={busy} aria-label={`${waiting ? "Send a new code" : "Send a code"} to ${i.address}`}
              onClick={() => void run(() => api.sendIdentityCode(acct.index, ref), `A code went to ${i.address}.`)}>
              {waiting ? "Send a new code" : "Send a code"}
            </button>
          </form>
        )}
        {!i.confirmed && policy === "server" && !i.server && (
          <div className="identity-act">
            <button type="button" className="btn btn-outline" disabled={busy} aria-label={`Ask your mail server again about ${i.address}`}
              onClick={() => void run(async () => {
                const r = await api.checkIdentity(acct.index, ref);
                if (!r.confirmed) toast("Your mail server takes it now. Confirm it with a code.");
                return r;
              })}>Ask your mail server again</button>
          </div>
        )}
        {i.server && !i.password && (
          <form className="identity-act" onSubmit={(e) => {
            e.preventDefault();
            void run(() => api.identityPassword(acct.index, i.id!, password), "Its password is in this browser now.").then((ok) => ok && setPassword(""));
          }}>
            <span className="identity-note">To send from it in this browser, enter its mail server's password. It's kept for this browser only.</span>
            <input className="text-input" type="password" aria-label={`Password for ${i.server.login} at ${i.server.host}`} placeholder="Password"
              autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
            <button type="submit" className="btn btn-primary" aria-label={`Use the password for ${i.address}`} disabled={busy || !password}>Use</button>
          </form>
        )}
      </div>
      {!i.own && i.id !== null && renaming === null && (
        <div className="identity-tools">
          <IconButton label={`Rename ${i.address}`} onClick={() => setRenaming(i.name)}><Pencil size={18} /></IconButton>
          <IconButton label={`Remove ${i.address}`} disabled={busy} onClick={() => void run(() => api.removeIdentity(acct.index, i.id!), `${i.address} removed.`)}>
            <Trash2 size={18} />
          </IconButton>
        </div>
      )}
    </li>
  );
}

/** A new address: its name and address, and, where allowed, its provider's own mail server. */
function AddIdentity({ servers, onDone }: { servers: boolean; onDone: (next: SendAddresses | null) => void }) {
  const acct = useAccount();
  const [name, setName] = useState(acct.settings?.name ?? "");
  const [address, setAddress] = useState("");
  const [own, setOwn] = useState(false);
  const [host, setHost] = useState("");
  const [port, setPort] = useState(465);
  const [security, setSecurity] = useState<"tls" | "starttls">("tls");
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await api.addIdentity(acct.index, {
        name, address,
        ...(own ? { server: { host, port, security, login: login.trim() || address.trim(), password } } : {}),
      });
      if (r.warning) toast(`${r.identity.address} is in the list, but ${r.warning[0].toLowerCase()}${r.warning.slice(1)}`, { error: true });
      else toast(r.identity.confirmed ? `You can send as ${r.identity.address} now.` : `A code went to ${r.identity.address}. Enter it here when it arrives.`);
      onDone(r);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <form className="add-identity" onSubmit={(e) => void submit(e)}>
      <div className="add-identity-pair">
        <input className="text-input" aria-label="Name" placeholder="Name" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
        <input className="text-input" type="email" aria-label="Address" placeholder="address@example.com" value={address} autoFocus required maxLength={320}
          onChange={(e) => setAddress(e.target.value)} />
      </div>
      {servers && (
        <label className="add-identity-check">
          <input type="checkbox" checked={own} onChange={(e) => setOwn(e.target.checked)} />
          Send through its own provider's mail server (for an address at another provider)
        </label>
      )}
      {own && (
        <>
          <div className="add-identity-server">
            <input className="text-input" aria-label="Mail server (SMTP)" placeholder="smtp.example.com" value={host} required onChange={(e) => setHost(e.target.value)} />
            <input className="text-input" type="number" aria-label="Port" min={1} max={65535} value={port} required onChange={(e) => setPort(Number(e.target.value))} />
            <select className="text-input" aria-label="Security" value={security} onChange={(e) => {
              const next = e.target.value as "tls" | "starttls";
              setSecurity(next);
              setPort(next === "tls" ? 465 : 587);
            }}>
              <option value="tls">SSL/TLS</option>
              <option value="starttls">STARTTLS</option>
            </select>
          </div>
          <div className="add-identity-pair">
            <input className="text-input" aria-label="Username" placeholder={address.trim() ? `Username, if not ${address.trim()}` : "Username"} value={login} autoComplete="off" onChange={(e) => setLogin(e.target.value)} />
            <input className="text-input" type="password" aria-label="Password" placeholder="Password" value={password} required autoComplete="off"
              onChange={(e) => setPassword(e.target.value)} />
          </div>
          <p className="identity-note">Its password is kept only in this browser's session, as your mailbox's is: other browsers ask for it again.</p>
        </>
      )}
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="identity-act">
        <button type="submit" className="btn btn-primary" disabled={busy || !address.trim()}>{busy ? "Checking…" : "Add"}</button>
        <button type="button" className="btn btn-text" onClick={() => onDone(null)}>Cancel</button>
      </div>
    </form>
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
