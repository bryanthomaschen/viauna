// This browser's notifications with Viauna closed: the service worker (/sw.js), and the
// browser's push subscription, given to the server for each mailbox that turns them on
// (server/push.ts). A browser has one subscription, shared by its mailboxes. Which
// mailboxes are on here is noted in this browser, so a page leaves showing their
// reminders to the worker rather than showing them twice.
import { api } from "./api";

const ON = "viauna.push";

export const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

function onHere(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(ON) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

function note(email: string, on: boolean) {
  const set = onHere();
  if (on) set.add(email.toLowerCase());
  else set.delete(email.toLowerCase());
  try {
    localStorage.setItem(ON, JSON.stringify([...set]));
  } catch {
    // Private browsing without storage: a page may then show a reminder the worker shows too.
  }
}

/** Whether this mailbox's reminders come to this browser through its push service. */
export const pushOn = (email: string) => onHere().has(email.toLowerCase());

const keyBytes = (key: string) => Uint8Array.from(atob(key.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

function sameKey(given: ArrayBuffer | null | undefined, key: string): boolean {
  if (!given) return false;
  const a = new Uint8Array(given);
  const b = keyBytes(key);
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

async function subscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.getRegistration("/");
  return (await reg?.pushManager.getSubscription()) ?? null;
}

/** Turns them on for a mailbox: asks the browser, starts the worker, subscribes, tells the server. */
export async function enablePush(index: number, email: string, key: string): Promise<void> {
  if (Notification.permission !== "granted" && (await Notification.requestPermission()) !== "granted") {
    throw new Error("Notifications are blocked for this site in your browser. Allow them in its site settings, then try again.");
  }
  await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  // One made with another key (the server's secret changed since) can't be used.
  if (sub && !sameKey(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe();
    sub = null;
  }
  try {
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
  } catch (err) {
    throw new Error(`This browser couldn't sign up with its push service (${(err as Error).message}).`);
  }
  await api.addPush(index, sub.toJSON());
  note(email, true);
}

/** Turns them off for a mailbox; the browser unsubscribes when no mailbox here has them on. */
export async function disablePush(index: number, email: string): Promise<void> {
  const sub = await subscription();
  if (sub) await api.removePush(index, sub.endpoint);
  note(email, false);
  if (sub && !onHere().size) await sub.unsubscribe();
}

/** Asks the server to push a test to this browser. */
export async function testPush(index: number): Promise<void> {
  const sub = await subscription();
  if (!sub) throw new Error("This browser isn't subscribed. Turn notifications off and on again.");
  await api.testPush(index, sub.endpoint);
}
