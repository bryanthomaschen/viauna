// Fills a dev mailbox with realistic, entirely fictional mail: conversations with
// replies filed in Sent, newsletters with remote images, attachments, labels, a
// draft, some spam, and a few hundred older messages to exercise backfill.
//
//   npm run seed                      # alice@example.test
//   npm run seed -- bob@example.test  # another mailbox
//
// Talks to the dev Dovecot from dev/compose.yml (any user, password "pass").
import crypto from "node:crypto";
import zlib from "node:zlib";
import { ImapFlow } from "imapflow";
import MailComposer from "nodemailer/lib/mail-composer";

const user = process.argv[2] || "alice@example.test";
const me = { name: user.split("@")[0].replace(/^./, (c) => c.toUpperCase()) + " Example", address: user };
const domain = user.split("@")[1];

const people = [
  { name: "Priya Raman", address: "priya.raman@example.org" },
  { name: "Tom Okafor", address: "tom@example.net" },
  { name: "Mei Lin Tan", address: "meilin@example.com" },
  { name: "Daniel Ruiz", address: "d.ruiz@example.org" },
  { name: "Hannah Kowalski", address: "hannah.k@example.net" },
  { name: "Arjun Mehta", address: "arjun@example.com" },
  { name: "Sofia Andersson", address: "sofia@example.org" },
  { name: "Kenji Watanabe", address: "kenji.w@example.net" },
];

const DAY = 86_400_000;
const now = Date.now();
let counter = 0;
const msgId = () => `<seed-${++counter}-${crypto.randomBytes(4).toString("hex")}@${domain}>`;

function pngPixel(r: number, g: number, b: number): Buffer {
  // A tiny solid-colour 16x16 PNG, built by hand so the seed has no image dependency.
  const width = 16, height = 16;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) raw.set([r, g, b], y * (width * 3 + 1) + 1 + x * 3);
  }
  const crc = (buf: Buffer) => {
    let c = ~0;
    for (const byte of buf) {
      c ^= byte;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

interface Seed {
  folder: string;
  flags: string[];
  date: number;
  raw: Buffer;
}
const seeds: Seed[] = [];

async function add(folder: string, flags: string[], date: number, opts: Record<string, unknown>) {
  const raw = await new MailComposer({ date: new Date(date), ...opts } as never).compile().build();
  seeds.push({ folder, flags, date, raw });
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
function quoteHtml(text: string, from: { name: string; address: string }, date: number, quoted: string) {
  const when = new Date(date).toUTCString().replace(" GMT", "");
  return `<div dir="ltr">${text.split("\n\n").map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("")}</div>
<div class="gmail_quote"><div class="gmail_attr">On ${when}, ${esc(from.name)} &lt;${from.address}&gt; wrote:<br></div>
<blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${quoted}</blockquote></div>`;
}

/** A conversation: alternating messages, mine filed in Sent, theirs in INBOX (or `folder`). */
async function conversation(
  subject: string,
  start: number,
  turns: { from: "me" | number; text: string; gap?: number }[],
  extra: { folder?: string; unreadLast?: boolean; flagged?: number[]; keywords?: string[]; attach?: number } = {},
) {
  let date = start;
  let prevId: string | null = null;
  const refs: string[] = [];
  let quoted = "";
  let prevFrom = me;
  let prevDate = date;
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    date += t.gap ?? (2 + Math.random() * 20) * 3600_000;
    const from = t.from === "me" ? me : people[t.from];
    const to = t.from === "me" ? [people[(turns.find((x) => x.from !== "me")?.from as number) ?? 0]] : [me];
    const id = msgId();
    const html = quoted ? quoteHtml(t.text, prevFrom, prevDate, quoted) : `<div dir="ltr">${t.text.split("\n\n").map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("")}</div>`;
    const isLast = i === turns.length - 1;
    const flags = [];
    if (t.from === "me" || !(isLast && extra.unreadLast)) flags.push("\\Seen");
    if (extra.flagged?.includes(i)) flags.push("\\Flagged");
    if (t.from !== "me" && extra.keywords) flags.push(...extra.keywords);
    const attachments = extra.attach === i
      ? [
          { filename: "itinerary.txt", content: "Day 1: arrive, check in\nDay 2: hike to the ridge\nDay 3: fly home\n" },
          { filename: "map.png", content: pngPixel(60, 140, 90), contentType: "image/png" },
        ]
      : [];
    await add(t.from === "me" ? "Sent" : (extra.folder ?? "INBOX"), flags, date, {
      from,
      to,
      subject: i === 0 ? subject : `Re: ${subject}`,
      messageId: id,
      inReplyTo: prevId ?? undefined,
      references: refs.length ? [...refs] : undefined,
      html,
      text: t.text,
      attachments,
    });
    refs.push(id);
    prevId = id;
    quoted = html;
    prevFrom = from;
    prevDate = date;
  }
  return prevId!;
}

async function main() {
  // --- conversations in the inbox
  await conversation("Weekend hike — Saturday or Sunday?", now - 2 * DAY, [
    { from: 0, text: "Hi!\n\nAre you still up for the ridge trail this weekend? The forecast looks dry on Saturday but Sunday has a 40% chance of rain.\n\nPriya" },
    { from: "me", text: "Saturday works for me. Shall we meet at the trailhead at 7?" },
    { from: 0, text: "7 is perfect. I'll bring snacks and the spare poles. Can you check whether the car park needs a permit?" },
    { from: "me", text: "No permit needed before 9am. See you there!" },
    { from: 0, text: "Great — and I attached the route and a rough itinerary in case we want to make it a longer day.", gap: 3600_000 },
  ], { unreadLast: true, keywords: ["travel"], attach: 4 });

  await conversation("Q3 planning doc — comments by Friday", now - 5 * DAY, [
    { from: 3, text: "Team,\n\nThe Q3 planning doc is ready for review. Please leave comments by Friday so we can finalise priorities in Monday's meeting.\n\nKey questions:\n1. Do we ship the import tool before the redesign?\n2. Who owns the migration runbook?\n\nThanks,\nDaniel" },
    { from: "me", text: "Left a few comments. I'd vote to ship the import tool first — it unblocks two customers." },
    { from: 4, text: "Agree with shipping import first. I can own the runbook if someone pairs with me on the rollback section." },
    { from: 3, text: "Thanks both. Hannah owns the runbook; I'll pair on rollback. Updated the doc." },
  ], { flagged: [0], keywords: ["work"] });

  const dinnerId = await conversation("Dinner on the 24th?", now - 1 * DAY, [
    { from: 2, text: "We're hosting a small dinner on the 24th — would love for you to come. Nothing fancy, just pasta and too much dessert." },
  ], { unreadLast: true });

  await conversation("Your package is on its way", now - 3 * 3600_000, [
    { from: 7, text: "Good news: your order #48213 has shipped and should arrive Thursday.\n\nTrack it any time from your account page." },
  ], { unreadLast: true });

  await conversation("Photos from the reunion", now - 9 * DAY, [
    { from: 5, text: "Finally got around to uploading everything. There are about 200 photos, so grab a coffee first." },
    { from: "me", text: "These are wonderful — thank you for doing this! The one by the lake is going on my wall." },
    { from: 6, text: "Adding a few of mine from the second day. The sunset ones came out better than I expected." },
  ], { flagged: [2] });

  await conversation("Invoice 2026-118", now - 12 * DAY, [
    { from: 1, text: "Hi,\n\nPlease find invoice 2026-118 for September attached. Payment terms are 30 days as usual.\n\nBest regards,\nTom" },
    { from: "me", text: "Thanks Tom, forwarded to accounts. You should see payment next week." },
  ], { keywords: ["work"] });

  await conversation("Book club: next pick", now - 20 * DAY, [
    { from: 4, text: "Votes are in: we're reading the lighthouse novel next. Meeting at mine on the 3rd." },
    { from: 2, text: "Yay! I've already started it. No spoilers, but chapter 4 is wild." },
    { from: 0, text: "Can someone lend me a copy? The library has a three-week wait." },
    { from: "me", text: "I can drop mine off on Tuesday." },
    { from: 0, text: "You're a star, thank you!" },
    { from: 4, text: "Reminder: Thursday 7pm. Bring a snack if you can!" },
  ]);

  // --- a newsletter with remote images and a classic table layout
  for (let n = 0; n < 6; n++) {
    await add("INBOX", n > 1 ? ["\\Seen"] : [], now - (n * 7 + 1) * DAY, {
      from: { name: "The Weekly Field Notes", address: "newsletter@fieldnotes.example.com" },
      to: [me],
      subject: [`Field Notes #${120 - n}: autumn migrations`, `Field Notes #${120 - n}: the quiet season`, `Field Notes #${120 - n}: night skies`][n % 3],
      messageId: msgId(),
      headers: {
        "List-Unsubscribe": "<https://fieldnotes.example.com/unsubscribe?u=123>, <mailto:unsubscribe@fieldnotes.example.com>",
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
      html: `<html><head><style>.wrap{max-width:600px;margin:0 auto;font-family:Georgia,serif}.hero{width:100%;border-radius:8px}h1{color:#2d4a3e}.btn{background:#2d4a3e;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none}</style></head>
<body><table class="wrap" role="presentation" cellpadding="0" cellspacing="0"><tr><td>
<img class="hero" src="https://images.fieldnotes.example.com/hero-${n}.jpg" alt="Birds over a lake at dawn" width="600" height="240">
<h1>This week in the field</h1>
<p>Flocks are moving south early this year. Here is what our readers spotted, and where to look this weekend.</p>
<p><img src="https://track.fieldnotes.example.com/open.gif?id=${n}" width="1" height="1" alt=""></p>
<p><a class="btn" href="https://fieldnotes.example.com/issues/${120 - n}">Read the full issue</a></p>
<p style="color:#888;font-size:12px">You're receiving this because you subscribed at fieldnotes.example.com.</p>
</td></tr></table></body></html>`,
    });
  }

  // --- a message with an inline (cid) image
  await add("INBOX", ["\\Seen"], now - 6 * DAY, {
    from: people[6],
    to: [me],
    subject: "New logo sketch",
    messageId: msgId(),
    html: `<p>Here's the colour we talked about:</p><p><img src="cid:swatch@seed" alt="swatch" width="64" height="64"></p><p>Thoughts?</p>`,
    attachments: [{ filename: "swatch.png", content: pngPixel(230, 120, 40), contentType: "image/png", cid: "swatch@seed" }],
  });

  // --- archived and other folders
  await conversation("Apartment lease renewal", now - 40 * DAY, [
    { from: 1, text: "Your lease is up for renewal at the end of next month. The new terms are attached for your review." },
    { from: "me", text: "Thanks — signed and returned." },
  ], { folder: "Archive" });

  await add("Junk", [], now - 2 * DAY, {
    from: { name: "Prize Department", address: "winner@lottery.example.net" },
    to: [me],
    subject: "You have WON a luxury cruise!!!",
    messageId: msgId(),
    text: "Claim your prize now by replying with your bank details.",
  });

  await add("Drafts", ["\\Draft", "\\Seen"], now - 4 * 3600_000, {
    from: me,
    to: [people[2]],
    subject: "Re: Dinner on the 24th?",
    messageId: msgId(),
    inReplyTo: dinnerId,
    references: [dinnerId],
    html: "<p>We'd love to come! Can I bring anything?</p>",
  });

  // --- older mail, enough to need backfill
  const subjects = ["Monthly statement", "Weekly digest", "Meeting notes", "Quick question", "Follow-up", "Reminder", "Receipt", "Hello again"];
  for (let i = 0; i < 360; i++) {
    const p = people[i % people.length];
    await add("INBOX", ["\\Seen"], now - (60 + i) * DAY, {
      from: p,
      to: [me],
      subject: `${subjects[i % subjects.length]} (${2026 - Math.floor(i / 120)}-${String((i % 12) + 1).padStart(2, "0")})`,
      messageId: msgId(),
      text: `Old message number ${i + 1}. This one is here so that the inbox has more than a first sync's worth of mail, which exercises background backfill.`,
    });
  }

  // Append oldest first, so UIDs grow with time like a real mailbox.
  seeds.sort((a, b) => a.date - b.date);
  const client = new ImapFlow({ host: "127.0.0.1", port: 1143, secure: false, doSTARTTLS: false, auth: { user, pass: "pass" }, logger: false });
  await client.connect();
  for (const s of seeds) await client.append(s.folder, s.raw, s.flags, new Date(s.date));
  await client.logout();
  console.log(`seeded ${seeds.length} messages into ${user}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
