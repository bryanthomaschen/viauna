import * as Tooltip from "@radix-ui/react-tooltip";
import { useQueryClient } from "@tanstack/react-query";
import { Pencil } from "lucide-react";
import { Suspense, lazy, useCallback, useEffect } from "react";
import { AccountProvider, ui, useAccount } from "../lib/account";
import { composes, openCompose } from "../lib/compose";
import { useLiveUpdates } from "../lib/live";
import { type Route, navigate } from "../lib/router";
import { prefs } from "../lib/store";
import type { SessionAccount } from "../lib/types";
import { ConversationView } from "./Conversation";
import { Dialogs, Toasts } from "./common";
import { Header } from "./Header";
import { useShortcuts } from "./shortcuts";
import { Sidebar } from "./Sidebar";
import { ThreadList } from "./ThreadList";

// The rich-text editor is most of the bundle; load it with the first compose window.
const ComposeDock = lazy(() => import("./Compose").then((m) => ({ default: m.ComposeDock })));
const SettingsView = lazy(() => import("./Settings").then((m) => ({ default: m.SettingsView })));

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
    else if (f.kind === "label") name = acct.labelByKeyword.get(f.keyword)?.name ?? f.keyword;
    else if (f.kind === "folder") name = acct.mailboxById.get(f.id)?.name ?? "Folder";
    else if (f.kind === "search") name = "Search results";
    else name = FOLDER_TITLES[f.kind];
    const count = f.kind === "inbox" && unread ? ` (${unread})` : "";
    document.title = `${name}${count} - ${acct.email} - ${appName}`;
  }, [route, acct, unread, appName]);
}

/** The floating Compose button on phones, where the sidebar is a drawer. */
function ComposeFab() {
  const acct = useAccount();
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
  useShortcuts(route);
  useDocumentTitle(route, appName);
  return (
    <div className="app">
      <Header route={route} appName={appName} />
      <div className="app-body">
        <Sidebar route={route} collapsed={collapsed} open={sidebarOpen} />
        {sidebarOpen && <div className="sidebar-scrim" onClick={() => ui.set((s) => ({ ...s, sidebarOpen: false }))} />}
        <main className="main">
          {route.name === "settings" ? (
            <Suspense fallback={<div className="empty"><div className="spinner lg" /></div>}>
              <SettingsView />
            </Suspense>
          ) : route.thread !== null ? (
            <ConversationView key={`${route.account}:${route.thread}`} route={route} />
          ) : (
            <ThreadList route={route} />
          )}
        </main>
      </div>
      <ComposeFab />
      {composing && (
        <Suspense fallback={null}>
          <ComposeDock />
        </Suspense>
      )}
      <Toasts />
      <Dialogs />
    </div>
  );
}
