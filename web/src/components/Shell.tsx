import * as Tooltip from "@radix-ui/react-tooltip";
import { useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus } from "lucide-react";
import { Suspense, lazy, useCallback, useEffect } from "react";
import { AccountProvider, ui, useAccount } from "../lib/account";
import { composes, openCompose } from "../lib/compose";
import { useLiveUpdates } from "../lib/live";
import { type Route, navigate } from "../lib/router";
import { prefs } from "../lib/store";
import type { SessionAccount } from "../lib/types";
import { CommandMenu } from "./CommandMenu";
import { ConversationView } from "./Conversation";
import { Dialogs, Toasts } from "./common";
import { Header } from "./Header";
import { useCommandMenuKey, useShortcuts } from "./shortcuts";
import { Sidebar } from "./Sidebar";
import { ThreadList } from "./ThreadList";

// The rich-text editor is most of the bundle; load it with the first compose window.
const ComposeDock = lazy(() => import("./Compose").then((m) => ({ default: m.ComposeDock })));
const SettingsView = lazy(() => import("./Settings").then((m) => ({ default: m.SettingsView })));
const ContactsView = lazy(() => import("./Contacts").then((m) => ({ default: m.ContactsView })));
const ContactDialog = lazy(() => import("./Contacts").then((m) => ({ default: m.ContactDialog })));
const MessageFilterDialog = lazy(() => import("./Filters").then((m) => ({ default: m.MessageFilterDialog })));
// The calendar grid is its own chunk; the event editor another, so mail can open it alone.
const CalendarSidebar = lazy(() => import("./Calendar").then((m) => ({ default: m.CalendarSidebar })));
const CalendarMain = lazy(() => import("./Calendar").then((m) => ({ default: m.CalendarMain })));
const EventDialog = lazy(() => import("./EventDialog").then((m) => ({ default: m.EventDialog })));
const CalendarDialog = lazy(() => import("./EventDialog").then((m) => ({ default: m.CalendarDialog })));
const ScopeDialog = lazy(() => import("./EventDialog").then((m) => ({ default: m.ScopeDialog })));

export function Shell({ route, accounts, appName }: { route: Route; accounts: SessionAccount[]; appName: string }) {
  const client = useQueryClient();
  const openThread = useCallback((index: number, threadId: number) => navigate(`/u/${index}/inbox/${threadId}`), []);
  useLiveUpdates(client, accounts.length, openThread);
  return (
    <Tooltip.Provider>
      <AccountProvider index={route.account} accounts={accounts}>
        <ShellInner route={route} appName={appName} />
      </AccountProvider>
    </Tooltip.Provider>
  );
}

const FOLDER_TITLES: Record<string, string> = {
  inbox: "Inbox", starred: "Starred", sent: "Sent Mail", drafts: "Drafts", all: "All Mail", spam: "Spam", trash: "Trash", archive: "Archive",
};

function useDocumentTitle(route: Route, appName: string) {
  const acct = useAccount();
  const unread = acct.special.inbox?.unread ?? 0;
  useEffect(() => {
    let name: string;
    const f = route.folder;
    if (route.name === "settings") name = "Settings";
    else if (route.name === "contacts") name = "Contacts";
    else if (route.name === "calendar") name = "Calendar";
    else if (f.kind === "label") name = acct.labelByKeyword.get(f.keyword)?.name ?? f.keyword;
    else if (f.kind === "folder") name = acct.mailboxById.get(f.id)?.name ?? "Folder";
    else if (f.kind === "search") name = "Search results";
    else name = FOLDER_TITLES[f.kind];
    const count = f.kind === "inbox" && unread ? ` (${unread})` : "";
    document.title = `${name}${count} - ${acct.email} - ${appName}`;
  }, [route, acct, unread, appName]);
}

/** The floating Compose button on phones, where the sidebar is a drawer; Create in the calendar. */
function ComposeFab({ route }: { route: Route }) {
  const acct = useAccount();
  if (route.name === "calendar") {
    return (
      <button type="button" className="compose-btn compose-fab" onClick={() => ui.set((s) => ({ ...s, eventDialog: { initial: {} } }))}>
        <Plus size={22} />
        <span>Create</span>
      </button>
    );
  }
  return (
    <button type="button" className="compose-btn compose-fab"
      onClick={() => openCompose(acct.index, acct.identities[0], acct.settings?.signature ?? "", {})}>
      <Pencil size={22} />
      <span>Compose</span>
    </button>
  );
}

function ShellInner({ route, appName }: { route: Route; appName: string }) {
  const collapsed = prefs.use((p) => p.sidebarCollapsed);
  const sidebarOpen = ui.use((s) => s.sidebarOpen);
  const composing = composes.use((l) => l.some((c) => c.placement === "dock" && !c.hidden));
  const contactDialog = ui.use((s) => s.contactDialog);
  const filterDialog = ui.use((s) => s.filterDialog);
  const eventDialog = ui.use((s) => s.eventDialog);
  const calendarDialog = ui.use((s) => s.calendarDialog);
  const scopeDialog = ui.use((s) => s.scopeDialog);
  const loading = <div className="empty"><div className="spinner lg" /></div>;
  useShortcuts(route);
  useCommandMenuKey();
  useDocumentTitle(route, appName);
  return (
    <div className="app">
      <Header route={route} appName={appName} />
      <div className="app-body">
        {route.name === "calendar" ? (
          <Suspense fallback={<nav className={`sidebar ${collapsed ? "collapsed" : ""}`} />}>
            <CalendarSidebar route={route} collapsed={collapsed} open={sidebarOpen} />
          </Suspense>
        ) : (
          <Sidebar route={route} collapsed={collapsed} open={sidebarOpen} />
        )}
        {sidebarOpen && <div className="sidebar-scrim" onClick={() => ui.set((s) => ({ ...s, sidebarOpen: false }))} />}
        <main className="main">
          {route.name === "settings" || route.name === "contacts" || route.name === "calendar" ? (
            <Suspense fallback={loading}>
              {route.name === "settings" ? <SettingsView /> : route.name === "contacts" ? <ContactsView /> : <CalendarMain route={route} />}
            </Suspense>
          ) : route.thread !== null ? (
            <ConversationView key={`${route.account}:${route.thread}`} route={route} />
          ) : (
            <ThreadList route={route} />
          )}
        </main>
      </div>
      <ComposeFab route={route} />
      {composing && (
        <Suspense fallback={null}>
          <ComposeDock />
        </Suspense>
      )}
      <Toasts />
      <Dialogs />
      <CommandMenu />
      {contactDialog && (
        <Suspense fallback={null}>
          <ContactDialog key={contactDialog.id ?? "new"} {...contactDialog} />
        </Suspense>
      )}
      {filterDialog && (
        <Suspense fallback={null}>
          <MessageFilterDialog criteria={filterDialog.criteria} />
        </Suspense>
      )}
      {eventDialog && (
        <Suspense fallback={null}>
          <EventDialog key={eventDialog.id === undefined ? "new" : `${eventDialog.id}:${eventDialog.occurrence ?? ""}`} {...eventDialog} />
        </Suspense>
      )}
      {calendarDialog && (
        <Suspense fallback={null}>
          <CalendarDialog key={calendarDialog.calendar?.id ?? "new"} {...calendarDialog} />
        </Suspense>
      )}
      {scopeDialog && (
        <Suspense fallback={null}>
          <ScopeDialog key={`${scopeDialog.action}:${scopeDialog.ruleChanged}`} />
        </Suspense>
      )}
    </div>
  );
}
