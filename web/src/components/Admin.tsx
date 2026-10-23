// The admin page: settings for the whole server, changed without a restart. It acts as
// the account in its address (/u/1/admin), and the server checks on every request that
// that account is an admin. A setting given in the
// environment shows here but can only be changed there; each says where its value
// comes from, and the page ends with what changed recently and who changed it.
import * as Tooltip from "@radix-ui/react-tooltip";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Lock, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { ui } from "../lib/account";
import { ApiError, api } from "../lib/api";
import { refreshSettings } from "../lib/config";
import { useLiveUpdates } from "../lib/live";
import { longDate } from "../lib/format";
import { navigate } from "../lib/router";
import { toast } from "../lib/store";
import type { AdminData, AdminSetting, Link, ServerFacts, SessionAccount, SettingValue } from "../lib/types";
import { Dialogs, IconButton, Toasts } from "./common";

type Save = (patch: Record<string, SettingValue | null>) => Promise<boolean>;

const noThread = () => {};

export function AdminPage({ account, accounts, appName }: { account: number; accounts: SessionAccount[]; appName: string }) {
  const query = useQuery({ queryKey: ["admin", account], queryFn: () => api.admin(account), retry: false });
  // Changes made elsewhere (another admin, the command line) show up here too.
  useLiveUpdates(useQueryClient(), accounts.length, noThread);
  useEffect(() => {
    document.title = `Admin - ${appName}`;
  }, [appName]);
  const err = query.error instanceof ApiError ? query.error : null;
  return (
    <Tooltip.Provider>
      <div className="admin-page">
        <header className="admin-bar">
          <IconButton label="Back to mail" onClick={() => navigate(`/u/${account}/inbox`)}><ArrowLeft size={22} /></IconButton>
          <div className="brand">
            <img src="/favicon.svg" alt="" />
            <span>{appName} <b>Admin</b></span>
          </div>
          {query.data && <div className="who">Signed in as {query.data.you}</div>}
        </header>
        <main className="admin-main">
          {query.isPending ? (
            <div className="empty"><div className="spinner lg" /></div>
          ) : err?.status === 403 ? (
            <NotAdmin account={account} email={accounts[account]?.email ?? "you@example.com"} />
          ) : query.error ? (
            <div className="empty">
              <h3>The admin page didn't load</h3>
              <p>{query.error.message}</p>
              {err?.reauth ? (
                <button type="button" className="btn btn-primary" onClick={() => (location.href = "/login")}>Sign in again</button>
              ) : (
                <button type="button" className="btn btn-outline" onClick={() => void query.refetch()}>Try again</button>
              )}
            </div>
          ) : (
            <AdminSettings account={account} data={query.data} />
          )}
        </main>
        <Toasts />
        <Dialogs />
      </div>
    </Tooltip.Provider>
  );
}

function NotAdmin({ account, email }: { account: number; email: string }) {
  return (
    <div className="empty">
      <ShieldCheck size={48} />
      <h3>This page is for admins</h3>
      <p style={{ maxWidth: 520 }}>
        An admin can add <b>{email}</b> here, or someone with access to the server can run <code>viauna admin add {email}</code>.
      </p>
      <button type="button" className="btn btn-outline" onClick={() => navigate(`/u/${account}/inbox`)}>Back to mail</button>
    </div>
  );
}

function useSave(account: number): Save {
  const client = useQueryClient();
  return async (patch) => {
    try {
      const r = await api.saveAdmin(account, patch);
      client.setQueryData<AdminData>(["admin", account], (d) => d && { ...d, settings: r.settings, changes: r.changes });
      // Everything else the page shows from settings, in this tab too.
      refreshSettings(client);
      toast(r.changed.length ? "Saved. It applies now." : "That's already the setting.");
      return true;
    } catch (err) {
      toast((err as Error).message, { error: true });
      return false;
    }
  };
}

/** A value as the command line and the record of changes show it. */
export function show(value: SettingValue | null, unit?: string): string {
  if (value === null) return "the default";
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (typeof value === "number") return unit ? `${value.toLocaleString()} ${unit}` : value.toLocaleString();
  if (Array.isArray(value)) {
    if (!value.length) return "None";
    return value.map((v) => (typeof v === "string" ? v : `${v.label}${v.for === "admins" ? " (admins)" : ""}`)).join(", ");
  }
  return value === "" ? "None" : value;
}

function AdminSettings({ account, data }: { account: number; data: AdminData }) {
  const save = useSave(account);
  const sections = [...new Set(data.settings.map((s) => s.section))];
  return (
    <>
      {sections.map((section) => (
        <section key={section}>
          <h2>{section}</h2>
          {data.settings.filter((s) => s.section === section).map((s) => (
            <SettingRow key={s.key} s={s} save={save} data={data} />
          ))}
        </section>
      ))}
      <section>
        <h2>This server</h2>
        <Facts server={data.server} />
      </section>
      <section>
        <h2>Recent changes</h2>
        <Changes data={data} />
      </section>
    </>
  );
}

function SettingRow({ s, save, data }: { s: AdminSetting; save: Save; data: AdminData }) {
  const locked = s.source === "environment";
  return (
    <div className="setting">
      <div className="name">
        {s.label}
        <small>{s.help}</small>
      </div>
      <div className="options">
        {s.type === "list" ? (
          <ListControl s={s} save={save} locked={locked} you={data.you} imap={data.server.imap} />
        ) : s.type === "links" ? (
          <LinksControl s={s} save={save} locked={locked} />
        ) : s.type === "choice" ? (
          <ChoiceControl s={s} save={save} locked={locked} server={data.server} />
        ) : s.type === "boolean" ? (
          <BooleanControl s={s} save={save} locked={locked} />
        ) : (
          <TextControl s={s} save={save} locked={locked} />
        )}
        <Source s={s} save={save} />
      </div>
    </div>
  );
}

function Source({ s, save }: { s: AdminSetting; save: Save }) {
  if (s.source === "environment") {
    return (
      <div className="setting-source">
        <Lock size={14} /> Set by <code>{s.env}</code> in the environment, so it can only be changed there.
      </div>
    );
  }
  if (s.source === "changed") {
    return (
      <div className="setting-source">
        Changed by {s.updatedBy} on {longDate(s.updatedAt!)}.
        {s.key !== "admins" && (
          <button type="button" className="btn btn-text" onClick={() => void save({ [s.key]: null })}>
            Reset to the default ({show(s.default, s.unit)})
          </button>
        )}
      </div>
    );
  }
  return <div className="setting-source">The default. Also settable as <code>{s.env}</code> in the environment.</div>;
}

function TextControl({ s, save, locked }: { s: AdminSetting; save: Save; locked: boolean }) {
  const current = String(s.value);
  const [draft, setDraft] = useState(current);
  useEffect(() => setDraft(current), [current]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void save({ [s.key]: s.type === "integer" ? Number(draft) : draft });
  };
  return (
    <form className="inline-field" onSubmit={submit}>
      <input
        className="text-input"
        type={s.type === "integer" ? "number" : "text"}
        inputMode={s.type === "integer" ? "numeric" : undefined}
        min={s.min}
        max={s.max}
        style={{ maxWidth: s.type === "integer" ? 160 : 480 }}
        value={draft}
        disabled={locked}
        aria-label={s.label}
        onChange={(e) => setDraft(e.target.value)}
      />
      {s.unit && <span>{s.unit}</span>}
      {!locked && <button type="submit" className="btn btn-primary" disabled={draft.trim() === current}>Save</button>}
    </form>
  );
}

/** The value just chosen, shown at once, until the server has answered. */
function usePending<T>(save: Save, key: string) {
  const [pending, setPending] = useState<T | null>(null);
  const choose = (value: T) => {
    setPending(value);
    void save({ [key]: value as SettingValue }).finally(() => setPending(null));
  };
  return [pending, choose] as const;
}

function BooleanControl({ s, save, locked }: { s: AdminSetting; save: Save; locked: boolean }) {
  const [pending, choose] = usePending<boolean>(save, s.key);
  return (
    <label>
      <input type="checkbox" checked={pending ?? (s.value as boolean)} disabled={locked || pending !== null} onChange={(e) => choose(e.target.checked)} /> On
    </label>
  );
}

function ChoiceControl({ s, save, locked, server }: { s: AdminSetting; save: Save; locked: boolean; server: ServerFacts }) {
  const [pending, choose] = usePending<string>(save, s.key);
  const current = pending ?? s.value;
  // Where each goes is set only in the environment; until it is, it can't be chosen.
  const needs: Record<string, string | null> = {
    link: server.passwordUrl ? null : "PASSWORD_CHANGE_URL",
    command: server.passwordCommand ? null : "PASSWORD_CHANGE_COMMAND",
    webhook: server.passwordWebhook ? null : "PASSWORD_CHANGE_WEBHOOK",
    ldap: server.passwordLdap ? null : "PASSWORD_CHANGE_LDAP_URL",
  };
  return (
    <>
      {s.choices!.map((c) => {
        const missing = needs[c.value] ?? null;
        return (
          <label key={c.value}>
            <input type="radio" name={s.key} checked={current === c.value} disabled={locked || pending !== null || (!!missing && s.value !== c.value)}
              onChange={() => choose(c.value)} />
            {c.label}
            {missing && <span className="setting-note">needs <code>{missing}</code> in the environment</span>}
          </label>
        );
      })}
    </>
  );
}

/** The apps menu's links: each with its label, its address and who sees it. */
function LinksControl({ s, save, locked }: { s: AdminSetting; save: Save; locked: boolean }) {
  const links = s.value as Link[];
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [audience, setAudience] = useState<Link["for"]>("everyone");
  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (await save({ [s.key]: [...links, { label, url, for: audience }] })) {
      setLabel("");
      setUrl("");
    }
  };
  return (
    <>
      {links.length > 0 ? (
        <table className="links-table">
          <tbody>
            {links.map((l, i) => (
              <tr key={`${i}${l.url}`}>
                <td>{l.label}</td>
                <td className="links-url"><a href={l.url} target="_blank" rel="noopener noreferrer">{l.url}</a></td>
                <td>{l.for === "admins" ? "Admins only" : "Everyone"}</td>
                <td style={{ textAlign: "right", width: 48 }}>
                  {!locked && (
                    <IconButton label={`Remove ${l.label}`} onClick={() => void save({ [s.key]: links.filter((_, j) => j !== i) })}>
                      <Trash2 size={18} />
                    </IconButton>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div style={{ color: "var(--text-3)" }}>None.</div>
      )}
      {!locked && (
        <form className="inline-field links-add" onSubmit={(e) => void add(e)}>
          <input className="text-input" aria-label="Link label" placeholder="Label" maxLength={60} value={label} onChange={(e) => setLabel(e.target.value)} />
          <input className="text-input" type="url" aria-label="Link address" placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} />
          <select className="text-input" aria-label="Shown to" value={audience} onChange={(e) => setAudience(e.target.value as Link["for"])}>
            <option value="everyone">Everyone</option>
            <option value="admins">Admins only</option>
          </select>
          <button type="submit" className="btn btn-outline" disabled={!label.trim() || !url.trim()}><Plus size={16} /> Add</button>
        </form>
      )}
    </>
  );
}

function ListControl({ s, save, locked, you, imap }: { s: AdminSetting; save: Save; locked: boolean; you: string; imap: string | null }) {
  const items = s.value as string[];
  const admins = s.key === "admins";
  const [adding, setAdding] = useState("");
  const remove = (item: string) => {
    const run = async () => {
      if (!(await save({ [s.key]: items.filter((x) => x !== item) }))) throw new Error("Not saved.");
      if (admins && item === you) navigate("/u/0/inbox");
    };
    if (admins && item === you) {
      ui.set((u) => ({
        ...u,
        confirm: { title: "Stop being an admin?", body: "You won't be able to open this page again unless another admin adds you back.", action: "Remove me", run },
      }));
    } else {
      void run().catch(() => {});
    }
  };
  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!adding.trim()) return;
    if (await save({ [s.key]: [...items, adding] })) setAdding("");
  };
  return (
    <>
      {items.length > 0 && (
        <table>
          <tbody>
            {items.map((item) => (
              <tr key={item}>
                <td>{item}{admins && item === you && <span style={{ color: "var(--text-3)" }}> (you)</span>}</td>
                <td style={{ textAlign: "right", width: 48 }}>
                  {!locked && (
                    <IconButton label={`Remove ${item}`} disabled={admins && items.length === 1} onClick={() => remove(item)}>
                      <Trash2 size={18} />
                    </IconButton>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!items.length && <div style={{ color: "var(--text-3)" }}>{admins ? "None." : "None: any address your mail server accepts can sign in."}</div>}
      {!locked && (
        <form className="inline-field" onSubmit={(e) => void add(e)}>
          <input className="text-input" style={{ maxWidth: 360 }} value={adding} onChange={(e) => setAdding(e.target.value)}
            placeholder={admins ? "address@example.com" : "example.com"} aria-label={admins ? "Add an admin" : "Add a domain"} />
          <button type="submit" className="btn btn-outline" disabled={!adding.trim()}><Plus size={16} /> Add</button>
        </form>
      )}
      {admins && (
        <div className="setting-note">
          Only mailboxes on this server's own mail server{imap ? ` (${imap})` : ""} count: a login on a server someone types in at sign-in proves nothing.
          {items.length === 1 && " Keep at least one admin; the command line can remove the last."}
        </div>
      )}
    </>
  );
}

function Facts({ server }: { server: ServerFacts }) {
  const rows: [string, string, string | null][] = [
    ["Version", server.version, null],
    ["Mail server (IMAP)", server.imap ?? "Not set: people must enter their own", "IMAP_HOST"],
    ["Sending (SMTP)", server.smtp ?? "Not set", "SMTP_HOST"],
    ["State store", server.database, "DATABASE_URL"],
    ["Data directory", server.dataDir, "DATA_DIR"],
    ["Public address", server.publicUrl ?? "Not set (recommended: requests are then checked against it)", "PUBLIC_URL"],
    ["Behind a reverse proxy", server.trustProxy ? "Yes" : "No", "TRUST_PROXY"],
    ["Private addresses for other servers", server.allowPrivateServers ? "Allowed" : "Not allowed", "ALLOW_PRIVATE_SERVERS"],
    ["Password page", server.passwordUrl ?? "Not set", "PASSWORD_CHANGE_URL"],
    ["Password change command", server.passwordCommand ? "Set" : "Not set", "PASSWORD_CHANGE_COMMAND"],
    ["Password change webhook", server.passwordWebhook ? "Set" : "Not set", "PASSWORD_CHANGE_WEBHOOK"],
    ["Password change directory", server.passwordLdap ?? "Not set", "PASSWORD_CHANGE_LDAP_URL"],
    ["Contacts server (CardDAV)", server.carddav ?? "Not set: contacts stay in Viauna", "CARDDAV_URL"],
    ["Sender, for reminders by email", server.sender ?? "Not set: reminders aren't emailed", "SENDER_ADDRESS"],
  ];
  return (
    <div className="setting" style={{ gridTemplateColumns: "1fr" }}>
      <p className="setting-note" style={{ margin: 0 }}>
        These are read from the environment when Viauna starts, so they can't be changed here: change them there, then restart Viauna.
      </p>
      <table className="admin-facts">
        <tbody>
          {rows.map(([label, value, env]) => (
            <tr key={label}>
              <td>{label}</td>
              <td>{value}</td>
              <td>{env && <code>{env}</code>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Changes({ data }: { data: AdminData }) {
  const units = new Map(data.settings.map((s) => [s.key, s.unit]));
  if (!data.changes.length) {
    return <div className="setting" style={{ gridTemplateColumns: "1fr", color: "var(--text-3)" }}>No changes yet: every setting is at its default or set in the environment.</div>;
  }
  return (
    <div className="setting" style={{ gridTemplateColumns: "1fr" }}>
      <table className="admin-changes">
        <thead>
          <tr><td>When</td><td>Who</td><td>Setting</td><td>From</td><td>To</td></tr>
        </thead>
        <tbody>
          {data.changes.map((c, i) => (
            <tr key={i}>
              <td>{longDate(c.at)}</td>
              <td>{c.actor}</td>
              <td>{c.label}</td>
              <td>{show(c.oldValue, units.get(c.setting))}</td>
              <td>{show(c.newValue, units.get(c.setting))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
