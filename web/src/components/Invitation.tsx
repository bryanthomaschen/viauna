// The card an invitation (or an event file) shows in its message: what, when, where, who,
// what it clashes with, and what to do: answer it, add it, bring your calendar up to date
// with it, remove it once cancelled, or, as its organiser, count a guest's answer. What it
// says comes from the server, which reads the message itself.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, ChevronDown, ChevronUp, MapPin, Repeat, TriangleAlert, Users, Video } from "lucide-react";
import { useState } from "react";
import { ui, useAccount } from "../lib/account";
import { api } from "../lib/api";
import { calendarsQuery, formatWhen, instantToWall, repeatText, useCalendarZone } from "../lib/calendar";
import { calendarPath, navigate } from "../lib/router";
import { toast } from "../lib/store";
import type { Answer, Invitation, InvitationAction, MessageRef, Person } from "../lib/types";

const ANSWERS: { value: "accepted" | "tentative" | "declined"; label: string }[] = [
  { value: "accepted", label: "Yes" },
  { value: "tentative", label: "Maybe" },
  { value: "declined", label: "No" },
];

const SAID: Record<Answer, string> = {
  accepted: "said yes",
  tentative: "said maybe",
  declined: "said no",
  "needs-action": "hasn't answered",
  delegated: "passed it on",
};

/** "Ann Lee", or the address when there's no name. */
const who = (p: Person) => p.name || p.address;

/** The event's times as the calendar shows them, in its zone. */
function useWhen(inv: Pick<Invitation, "allDay" | "start" | "end">) {
  const zone = useCalendarZone();
  if (!inv.start) return "";
  return formatWhen(inv.allDay ? inv : { allDay: false, start: instantToWall(inv.start, zone), end: instantToWall(inv.end, zone) });
}

/** "3 guests: 2 yes, 1 waiting", opening to the list: an event's organiser and guests, with their answers. */
export function Guests({ inv, me }: { inv: Pick<Invitation, "organizer" | "attendees">; me: string[] }) {
  const [open, setOpen] = useState(false);
  const all = inv.attendees;
  const you = (p: Person) => me.includes(p.address);
  // The organiser is often on the guest list too: once, as the organiser.
  const guests = all.filter((p) => p.address !== inv.organizer?.address);
  if (!all.length) return null;
  const counts = (["accepted", "tentative", "declined", "needs-action"] as const)
    .map((a) => [a, all.filter((p) => p.response === a).length] as const)
    .filter(([, n]) => n)
    .map(([a, n]) => `${n} ${a === "accepted" ? "yes" : a === "tentative" ? "maybe" : a === "declined" ? "no" : "waiting"}`);
  return (
    <div className="invite-row">
      <Users size={18} aria-hidden />
      <div>
        <button type="button" className="invite-guests-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          {all.length === 1 ? "1 guest" : `${all.length} guests`}: {counts.join(", ")} {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
        {open && (
          <ul className="invite-guests">
            {inv.organizer && <li title={inv.organizer.address}>{who(inv.organizer)}{you(inv.organizer) ? " (you)" : ""} <span className="muted">organiser</span></li>}
            {guests.map((p) => (
              <li key={p.address} title={p.address}>
                {you(p) ? `${who(p)} (you)` : who(p)} <span className="muted">{p.response ? (you(p) ? SAID[p.response].replace("hasn't", "haven't") : SAID[p.response]) : ""}{p.optional ? ", optional" : ""}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export function InvitationCard({ refx }: { refx: MessageRef }) {
  const acct = useAccount();
  const client = useQueryClient();
  const zone = useCalendarZone();
  const key = ["invitation", acct.index, refx.mailboxId, refx.uid, zone];
  const query = useQuery({ queryKey: key, queryFn: () => api.invitation(acct.index, refx, zone), staleTime: 0 });
  const calendars = useQuery({ ...calendarsQuery(acct.index), staleTime: 60_000 });
  const own = (calendars.data?.calendars ?? []).filter((c) => !c.readOnly);
  const [calendarId, setCalendarId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const inv = query.data?.invitation;
  const when = useWhen(inv ?? { allDay: false, start: "", end: "" });
  if (!inv) return query.isPending ? <div className="invite-card"><div className="spinner" /></div> : null;

  const chosen = calendarId ?? acct.settings?.invitationCalendar ?? own.find((c) => c.primary)?.id ?? null;
  const act = async (action: InvitationAction, done: (sent: boolean) => string) => {
    setBusy(true);
    try {
      const r = await api.actOnInvitation(acct.index, refx, action, inv.stored ? null : chosen, zone);
      client.setQueryData(key, { invitation: r.invitation });
      void client.invalidateQueries({ queryKey: ["events", acct.index] });
      toast(done(r.sent));
    } catch (err) {
      toast((err as Error).message, { error: true });
    } finally {
      setBusy(false);
    }
  };
  const answer = (a: (typeof ANSWERS)[number]) =>
    void act(a.value, (sent) => `Answered "${a.label.toLowerCase()}".${sent && inv.organizer ? ` ${who(inv.organizer)} has been told.` : ""}`);
  const open = () => {
    if (!inv.stored) return;
    navigate(calendarPath(acct.index, "day", (inv.allDay ? inv.start : instantToWall(inv.start, zone)).slice(0, 10)));
    ui.set((s) => ({ ...s, eventDialog: { id: inv.stored!.id, occurrence: null } }));
  };
  const picker = !inv.stored && own.length > 1 && (
    <label className="invite-calendar">
      <span className="muted">in</span>
      <select className="text-input" aria-label="Into which calendar" value={chosen ?? ""} onChange={(e) => setCalendarId(Number(e.target.value))}>
        {own.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
    </label>
  );
  const inCalendar = inv.stored && (
    <button type="button" className="btn btn-text invite-open" onClick={open}><CalendarDays size={16} /> Open in your calendar</button>
  );
  const replier = inv.method === "REPLY" ? inv.attendees[0] : null;

  return (
    <section className={`invite-card ${inv.method === "CANCEL" ? "cancelled" : ""}`} aria-label={inv.method === "PUBLISH" ? "Event" : "Invitation"}>
      <div className="invite-title">
        <CalendarDays size={20} aria-hidden />
        <h3>{inv.title || "(No title)"}</h3>
      </div>
      <div className="invite-row muted">{when}{inv.occurrence ? " (one occurrence)" : ""}</div>
      {inv.repeat && <div className="invite-row muted"><Repeat size={18} aria-hidden /> {repeatText(inv.repeat, inv.allDay ? inv.start : instantToWall(inv.start, zone))}</div>}
      {inv.location && <div className="invite-row"><MapPin size={18} aria-hidden /> {inv.location}</div>}
      {/* The server gives only http(s) links (videoProperty); checked again here all the same. */}
      {inv.video && /^https?:\/\//i.test(inv.video) && (
        <div className="invite-row"><Video size={18} aria-hidden /> <a href={inv.video} target="_blank" rel="noopener noreferrer">Join video call</a></div>
      )}
      {inv.organizer && !replier && <div className="invite-row muted">From {who(inv.organizer)}{inv.youOrganize ? " (you)" : ""}</div>}
      {!replier && <Guests inv={inv} me={acct.identities.map((i) => i.address)} />}
      {inv.clashes.length > 0 && (
        <div className="invite-row invite-clash" role="note">
          <TriangleAlert size={18} aria-hidden />
          <span>Clashes with {inv.clashes.map((e) => `${e.title || "(No title)"} (${formatWhen({ allDay: false, start: instantToWall(e.start, zone), end: instantToWall(e.end, zone) }).split(" · ").pop()})`).join(", ")}</span>
        </div>
      )}
      {inv.more > 0 && <div className="invite-row muted">And {inv.more === 1 ? "1 more event" : `${inv.more} more events`} in the same file.</div>}

      <div className="invite-actions">
        {inv.outdated ? (
          <span className="muted">Your calendar has a newer version of this event.</span>
        ) : inv.method === "CANCEL" ? (
          <>
            <span><strong>This event has been cancelled.</strong></span>
            {inv.stored ? (
              <button type="button" className="btn btn-outline" disabled={busy} onClick={() => void act("remove", () => "Removed from your calendar.")}>Remove from your calendar</button>
            ) : (
              <span className="muted">It isn't in your calendar.</span>
            )}
          </>
        ) : replier ? (
          <>
            <span>{who(replier)} {replier.response ? SAID[replier.response] : "answered"}.</span>
            {inv.stored && inv.youOrganize && !inv.replyApplied ? (
              <button type="button" className="btn btn-outline" disabled={busy} onClick={() => void act("apply-reply", () => "Counted in your calendar.")}>Count it in your event</button>
            ) : inv.stored ? (
              <span className="muted">Counted in your calendar.</span>
            ) : (
              <span className="muted">The event isn't in your calendar.</span>
            )}
            {inCalendar}
          </>
        ) : inv.method === "REQUEST" && inv.you ? (
          <>
            <span className="invite-going">Going?</span>
            <div className="invite-answers" role="group" aria-label="Going?">
              {ANSWERS.map((a) => (
                <button key={a.value} type="button" className={`btn ${inv.stored?.response === a.value ? "btn-primary" : "btn-outline"}`}
                  aria-pressed={inv.stored?.response === a.value} disabled={busy} onClick={() => answer(a)}>{a.label}</button>
              ))}
            </div>
            {picker}
            {inv.stored && inv.newer && (
              <button type="button" className="btn btn-text" disabled={busy} onClick={() => void act("update", () => "Your calendar has the new version.")}>Update your calendar</button>
            )}
            {inCalendar}
          </>
        ) : (
          <>
            {!inv.stored ? (
              <>
                <button type="button" className="btn btn-outline" disabled={busy} onClick={() => void act("add", () => "Added to your calendar.")}>
                  Add to calendar
                </button>
                {picker}
                {inv.method === "REQUEST" && <span className="muted">You aren't on its guest list, so it can't be answered from here.</span>}
              </>
            ) : inv.newer ? (
              <button type="button" className="btn btn-outline" disabled={busy} onClick={() => void act("update", () => "Your calendar has the new version.")}>Update your calendar</button>
            ) : (
              <span className="muted">It's in your calendar.</span>
            )}
            {inCalendar}
          </>
        )}
      </div>
    </section>
  );
}
