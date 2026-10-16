// Minimal external stores (no state library needed for this little shared state).
import { useCallback, useRef, useSyncExternalStore } from "react";

function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    return ka.length === kb.length && ka.every((k) => Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

export function createStore<T>(initial: T) {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(next: T | ((prev: T) => T)) {
      state = typeof next === "function" ? (next as (p: T) => T)(state) : next;
      for (const l of listeners) l();
    },
    subscribe(cb: () => void) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    /**
     * Subscribes to a slice. Selectors may build a new array/object every time: the
     * result is compared shallowly, so an unchanged slice keeps its identity.
     */
    use<S = T>(select: (s: T) => S = (s) => s as unknown as S): S {
      const latest = useRef(select);
      latest.current = select;
      const cache = useRef<{ state: T; select: unknown; value: S } | null>(null);
      const getSnapshot = useCallback(() => {
        const c = cache.current;
        if (c && c.state === state && c.select === latest.current) return c.value;
        const value = latest.current(state);
        const keep = c && shallowEqual(c.value, value) ? c.value : value;
        cache.current = { state, select: latest.current, value: keep };
        return keep;
      }, []);
      return useSyncExternalStore(this.subscribe, getSnapshot);
    },
  };
}

export function readLocal<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function writeLocal(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // private mode, or storage blocked: the preference just isn't remembered
  }
}

// ---------------------------------------------------------------- preferences

export type Theme = "system" | "light" | "dark";
export type Density = "default" | "comfortable" | "compact";

export interface Prefs {
  theme: Theme;
  density: Density;
  shortcuts: boolean;
  notifications: boolean;
  sidebarCollapsed: boolean;
}

export const prefs = createStore<Prefs>({
  theme: "system",
  density: "default",
  shortcuts: true,
  notifications: false,
  sidebarCollapsed: false,
  ...readLocal<Partial<Prefs>>("viauna.prefs", {}),
});
prefs.subscribe(() => writeLocal("viauna.prefs", prefs.get()));

// ---------------------------------------------------------------- toasts

export interface Toast {
  id: number;
  text: string;
  action?: { label: string; run: () => void };
  error?: boolean;
}

let toastId = 0;
export const toasts = createStore<Toast[]>([]);

export function toast(text: string, opts: { action?: Toast["action"]; error?: boolean; ms?: number } = {}) {
  const id = ++toastId;
  toasts.set((list) => [...list.slice(-2), { id, text, action: opts.action, error: opts.error }]);
  setTimeout(() => dismissToast(id), opts.ms ?? (opts.action ? 8000 : 5000));
  return id;
}

export function dismissToast(id: number) {
  toasts.set((list) => list.filter((t) => t.id !== id));
}
