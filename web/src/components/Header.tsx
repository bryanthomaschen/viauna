import * as Popover from "@radix-ui/react-popover";
import { useQueryClient } from "@tanstack/react-query";
import { BookUser, CalendarDays, CircleHelp, Command, LayoutGrid, LogOut, Mail, Menu, Search, Settings, ShieldCheck, SlidersHorizontal, UserPlus, X } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { ui, useAccount } from "../lib/account";
import { api } from "../lib/api";
import { useConfig } from "../lib/config";
import { type Route, calendarPath, calendarSearchPath, folderPath, navigate } from "../lib/router";
import { prefs } from "../lib/store";
import { MOD_KEY } from "./CommandMenu";
import { Avatar, IconButton } from "./common";

export function Header({ route, appName }: { route: Route; appName: string }) {
  const acct = useAccount();
  const toggleSidebar = () => {
    if (matchMedia("(max-width: 720px)").matches) ui.set((s) => ({ ...s, sidebarOpen: !s.sidebarOpen }));
    else prefs.set((p) => ({ ...p, sidebarCollapsed: !p.sidebarCollapsed }));
  };
  return (
    <header className="header">
      <IconButton label="Main menu" onClick={toggleSidebar}>
        <Menu size={22} />
      </IconButton>
      <button type="button" className="brand" aria-label={route.name === "calendar" ? `${appName} calendar` : `${appName} inbox`}
        onClick={() => navigate(route.name === "calendar" ? calendarPath(acct.index) : `/u/${acct.index}/inbox`)}>
        <img src="/favicon.svg" alt="" />
        <span>{appName}</span>
      </button>
      <SearchBox route={route} />
      <div className="spacer" />
      <div className="header-actions">
        <IconButton label={`Commands (${MOD_KEY}K)`} className="hide-narrow" onClick={() => ui.set((s) => ({ ...s, commandsOpen: true }))}>
          <Command size={22} />
        </IconButton>
        <IconButton label="Keyboard shortcuts" className="hide-narrow" onClick={() => ui.set((s) => ({ ...s, shortcutsOpen: true }))}>
          <CircleHelp size={22} />
        </IconButton>
        <IconButton label="Settings" className="hide-narrow" onClick={() => navigate(`/u/${acct.index}/settings${route.name === "calendar" ? "?tab=calendar" : ""}`)}>
          <Settings size={22} />
        </IconButton>
        <Apps route={route} />
        <AccountMenu />
      </div>
    </header>
  );
}

/** Mail, Calendar and Contacts: the apps of the suite, one click apart. */
function Apps({ route }: { route: Route }) {
  const acct = useAccount();
  const config = useConfig().data;
  const [open, setOpen] = useState(false);
  const apps = [
    { name: "Mail", icon: Mail, to: `/u/${acct.index}/inbox`, on: route.name === "mail" },
    ...(config?.calendar ? [{ name: "Calendar", icon: CalendarDays, to: calendarPath(acct.index), on: route.name === "calendar" }] : []),
    ...(config?.contacts ? [{ name: "Contacts", icon: BookUser, to: `/u/${acct.index}/contacts`, on: route.name === "contacts" }] : []),
  ];
  if (apps.length < 2) return null;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <IconButton label="Apps">
          <LayoutGrid size={22} />
        </IconButton>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="popover apps-pop" align="end" sideOffset={8} aria-label="Apps">
          {apps.map((a) => (
            <a key={a.name} href={a.to} className={`app-link ${a.on ? "on" : ""}`} aria-current={a.on ? "page" : undefined}
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey) return;
                e.preventDefault();
                setOpen(false);
                navigate(a.to);
              }}>
              <a.icon size={28} aria-hidden />
              <span>{a.name}</span>
            </a>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function SearchBox({ route }: { route: Route }) {
  const acct = useAccount();
  // In the calendar, the box searches events.
  const events = route.name === "calendar";
  const current = events ? (route.calendar?.search ?? "") : route.folder.kind === "search" ? route.folder.query : "";
  const [q, setQ] = useState(current);
  const [advanced, setAdvanced] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const focusTick = ui.use((s) => s.searchFocus);

  useEffect(() => setQ(current), [current]);
  useEffect(() => {
    if (focusTick) input.current?.focus();
  }, [focusTick]);

  const submit = (e?: FormEvent, query = q) => {
    e?.preventDefault();
    const trimmed = query.trim();
    setAdvanced(false);
    if (events) navigate(trimmed ? calendarSearchPath(acct.index, trimmed) : calendarPath(acct.index));
    else if (!trimmed) navigate(folderPath(acct.index, { kind: "inbox" }));
    else navigate(folderPath(acct.index, { kind: "search", query: trimmed }));
    input.current?.blur();
  };

  return (
    <div className="search">
      <form className="search-field" role="search" onSubmit={submit}>
        <IconButton label="Search" type="submit">
          <Search size={20} />
        </IconButton>
        <input
          ref={input}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={events ? "Search calendar" : "Search mail"}
          aria-label={events ? "Search calendar" : "Search mail"}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setQ(current);
              input.current?.blur();
            }
          }}
        />
        {q && (
          <IconButton label="Clear search" onClick={() => { setQ(""); if (current) navigate(events ? calendarPath(acct.index) : folderPath(acct.index, { kind: "inbox" })); }}>
            <X size={20} />
          </IconButton>
        )}
        {!events && (
          <IconButton label="Show search options" onClick={() => setAdvanced((a) => !a)}>
            <SlidersHorizontal size={20} />
          </IconButton>
        )}
      </form>
      {advanced && <AdvancedSearch onSearch={(query) => { setQ(query); submit(undefined, query); }} onClose={() => setAdvanced(false)} />}
    </div>
  );
}

function AdvancedSearch({ onSearch, onClose }: { onSearch: (q: string) => void; onClose: () => void }) {
  const [f, setF] = useState({ from: "", to: "", subject: "", words: "", without: "", attachment: false, within: "" });
  const quote = (v: string) => (/\s/.test(v) ? `"${v}"` : v);
  const build = () =>
    [
      f.from && `from:${quote(f.from)}`,
      f.to && `to:${quote(f.to)}`,
      f.subject && `subject:${quote(f.subject)}`,
      f.words,
      ...f.without.split(/\s+/).filter(Boolean).map((w) => `-${w}`),
      f.attachment && "has:attachment",
      f.within && `newer_than:${f.within}`,
    ]
      .filter(Boolean)
      .join(" ");
  const field = (key: keyof typeof f, label: string) => (
    <div className="row">
      <label htmlFor={`adv-${key}`}>{label}</label>
      <input id={`adv-${key}`} type="text" value={f[key] as string} onChange={(e) => setF({ ...f, [key]: e.target.value })}
        onKeyDown={(e) => e.key === "Enter" && onSearch(build())} />
    </div>
  );
  return (
    <div className="search-panel" role="dialog" aria-label="Search options">
      {field("from", "From")}
      {field("to", "To")}
      {field("subject", "Subject")}
      {field("words", "Has the words")}
      {field("without", "Doesn't have")}
      <div className="row">
        <label htmlFor="adv-within">Date within</label>
        <select id="adv-within" value={f.within} onChange={(e) => setF({ ...f, within: e.target.value })}>
          <option value="">Any time</option>
          <option value="1d">1 day</option>
          <option value="7d">1 week</option>
          <option value="1m">1 month</option>
          <option value="6m">6 months</option>
          <option value="1y">1 year</option>
        </select>
      </div>
      <div className="row">
        <span />
        <label style={{ display: "flex", gap: 8, alignItems: "center", color: "var(--text)" }}>
          <input type="checkbox" checked={f.attachment} onChange={(e) => setF({ ...f, attachment: e.target.checked })} /> Has attachment
        </label>
      </div>
      <div className="buttons">
        <button type="button" className="btn btn-text" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" onClick={() => onSearch(build())}>Search</button>
      </div>
    </div>
  );
}

function AccountMenu() {
  const acct = useAccount();
  const client = useQueryClient();
  const me = acct.accounts[acct.index];
  const name = acct.settings?.name || me.name;
  const signOut = async (index?: number) => {
    await api.logout(index);
    client.clear();
    location.href = index === undefined || acct.accounts.length === 1 ? "/login" : "/u/0/inbox";
  };
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button type="button" className="avatar-btn" aria-label={`Account: ${me.email}`}>
          <Avatar person={{ address: me.email, name }} size={32} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="popover account-pop" align="end" sideOffset={8}>
          <div className="current">
            <div className="email">{me.email}</div>
            <Avatar person={{ address: me.email, name }} size={72} />
            <div className="hi">Hi, {(name || me.email).split(/[\s@]/)[0]}!</div>
          </div>
          <div className="list">
            {acct.accounts.map((a) =>
              a.index === acct.index ? null : (
                <button key={a.index} type="button" className="account-row" onClick={() => navigate(`/u/${a.index}/inbox`)}>
                  <Avatar person={{ address: a.email, name: a.name }} size={32} />
                  <span className="t">
                    <div>{a.name || a.email.split("@")[0]}</div>
                    <div>{a.email}</div>
                  </span>
                </button>
              ),
            )}
            <button type="button" className="account-row" onClick={() => (location.href = "/login?add=1")}>
              <span className="icon-btn sm" aria-hidden><UserPlus size={20} /></span>
              <span className="t">Add another account</span>
            </button>
            {acct.accounts.some((a) => a.admin) && (
              <button type="button" className="account-row" onClick={() => navigate("/admin")}>
                <span className="icon-btn sm" aria-hidden><ShieldCheck size={20} /></span>
                <span className="t">Admin settings</span>
              </button>
            )}
            <button type="button" className="account-row" onClick={() => void signOut(acct.index)}>
              <span className="icon-btn sm" aria-hidden><LogOut size={20} /></span>
              <span className="t">Sign out of {me.email}</span>
            </button>
          </div>
          {acct.accounts.length > 1 && (
            <div className="foot">
              <button type="button" className="btn btn-text" onClick={() => void signOut()}>Sign out of all accounts</button>
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
