import { useQuery } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import { api } from "./api";
import { createStore } from "./store";
import type { Identity, Label, Mailbox, SessionAccount, Settings, SpecialUse } from "./types";

export interface AccountContextValue {
  index: number;
  accounts: SessionAccount[];
  email: string;
  mailboxes: Mailbox[];
  labels: Label[];
  ready: boolean;
  syncError: string | null;
  special: Partial<Record<SpecialUse, Mailbox>>;
  mailboxById: Map<number, Mailbox>;
  labelByKeyword: Map<string, Label>;
  settings: Settings | undefined;
  identities: Identity[];
  me: Set<string>;
}

const Ctx = createContext<AccountContextValue | null>(null);

export function AccountProvider({ index, accounts, children }: { index: number; accounts: SessionAccount[]; children: ReactNode }) {
  const mailboxes = useQuery({
    queryKey: ["mailboxes", index],
    queryFn: () => api.mailboxes(index),
    // Until the first sync lands, poll; afterwards live updates drive refreshes.
    refetchInterval: (q) => (q.state.data?.status.ready ? false : 1500),
  });
  const settings = useQuery({ queryKey: ["settings", index], queryFn: () => api.settings(index), staleTime: 5 * 60_000 });
  const email = accounts[index]?.email ?? "";

  const value = useMemo<AccountContextValue>(() => {
    const boxes = mailboxes.data?.mailboxes ?? [];
    const labels = mailboxes.data?.labels ?? [];
    const special: Partial<Record<SpecialUse, Mailbox>> = {};
    for (const mb of boxes) if (mb.specialUse && !special[mb.specialUse]) special[mb.specialUse] = mb;
    const s = settings.data?.settings;
    const identities: Identity[] = [{ name: s?.name ?? "", address: email }, ...(s?.aliases ?? [])];
    return {
      index,
      accounts,
      email,
      mailboxes: boxes,
      labels,
      ready: !!mailboxes.data?.status.ready,
      syncError: mailboxes.data?.status.error ?? null,
      special,
      mailboxById: new Map(boxes.map((m) => [m.id, m])),
      labelByKeyword: new Map(labels.map((l) => [l.keyword, l])),
      settings: s,
      identities,
      me: new Set(identities.map((i) => i.address.toLowerCase())),
    };
  }, [index, accounts, email, mailboxes.data, settings.data]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAccount(): AccountContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAccount outside AccountProvider");
  return v;
}

// ---------------------------------------------------------------- shared UI state

/** A destructive action waiting for the user to confirm it. */
export interface ConfirmRequest {
  title: string;
  body: string;
  action: string;
  run: () => Promise<void>;
}

export interface UiState {
  shortcutsOpen: boolean;
  labelDialog: null | { label?: Label };
  folderDialog: null | { mailbox?: Mailbox; parentId?: number };
  confirm: null | ConfirmRequest;
  sidebarOpen: boolean;
  searchFocus: number;
}

export const ui = createStore<UiState>({ shortcutsOpen: false, labelDialog: null, folderDialog: null, confirm: null, sidebarOpen: false, searchFocus: 0 });

/** The visible thread list, so j/k inside a conversation can move to its neighbours. */
export const listState = createStore<{ key: string; ids: number[]; cursor: number; selected: Set<number>; total: number; offset: number }>({
  key: "",
  ids: [],
  cursor: 0,
  selected: new Set(),
  total: 0,
  offset: 0,
});
