// vCard (RFC 6350 for 4.0, RFC 2426 for 3.0, and 2.1 as Outlook and old phones still
// write it), read and written without losing anything. A card is its list of
// properties, kept as they came; Viauna edits only the fields it shows (names, nickname,
// addresses, phones, organisation, title, birthday and other dates, labels, notes) and
// leaves the rest (photos, postal addresses, other apps' own fields) for whichever app
// wrote them. 2.1 cards are brought up to 3.0 on the way in, since nothing reads 2.1's
// quoted-printable well.
import { fold } from "./text.ts";

export interface Param {
  name: string;
  values: string[];
}

export interface Prop {
  /** Apple's "item1." prefix, which ties a property to its custom label. */
  group: string | null;
  name: string;
  params: Param[];
  /** As written in the card: still escaped. */
  value: string;
}

export interface VCard {
  version: string;
  props: Prop[];
}

/** The fields Viauna shows and edits. */
export interface ContactFields {
  firstName: string;
  lastName: string;
  /** NICKNAME's names, joined with ", ": matched while writing, never sent. */
  nickname: string;
  emails: { address: string; label: string }[];
  phones: { number: string; label: string }[];
  organization: string;
  title: string;
  /** "1990-05-12", or "--05-12" when the year isn't known; another app's own wording, as it wrote it. */
  birthday: string;
  /** Anniversaries and other dates, labelled "anniversary", "other" or in the person's own words. */
  dates: { date: string; label: string }[];
  /** What the person is to you (CATEGORIES): shown only in Viauna, never sent. */
  labels: string[];
  notes: string;
}

const MAX_CARD = 1024 * 1024;

// ------------------------------------------------------------ reading

/** Joins folded lines: a line starting with a space or tab continues the one before. */
function unfold(text: string): string[] {
  const lines: string[] = [];
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    if ((raw.startsWith(" ") || raw.startsWith("\t")) && lines.length) lines[lines.length - 1] += raw.slice(1);
    else lines.push(raw);
  }
  return lines;
}

/** Splits `[group.]NAME;PARAM=a,"b";BARE:value` at the first colon outside quotes. */
function parseLine(line: string): Prop | null {
  let quoted = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (c === ":" && !quoted) {
      colon = i;
      break;
    }
  }
  if (colon < 1) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const parts: string[] = [];
  let current = "";
  quoted = false;
  for (const c of head) {
    if (c === '"') quoted = !quoted;
    if (c === ";" && !quoted) {
      parts.push(current);
      current = "";
    } else current += c;
  }
  parts.push(current);
  const [nameWithGroup, ...rawParams] = parts;
  const dot = nameWithGroup.lastIndexOf(".");
  const group = dot > 0 ? nameWithGroup.slice(0, dot) : null;
  const name = (dot > 0 ? nameWithGroup.slice(dot + 1) : nameWithGroup).toUpperCase();
  if (!/^[A-Z0-9-]+$/.test(name)) return null;
  const params: Param[] = rawParams.map((p) => {
    const eq = p.indexOf("=");
    // vCard 2.1 writes bare parameters (TEL;HOME;VOICE): they are types.
    if (eq < 0) return { name: "TYPE", values: [p] };
    const values: string[] = [];
    let v = "";
    let q = false;
    for (const c of p.slice(eq + 1)) {
      if (c === '"') q = !q;
      else if (c === "," && !q) {
        values.push(v);
        v = "";
      } else v += c;
    }
    values.push(v);
    return { name: p.slice(0, eq).toUpperCase(), values };
  });
  return { group, name, params, value };
}

function param(prop: Prop, name: string): string[] {
  return prop.params.filter((p) => p.name === name).flatMap((p) => p.values);
}

function decodeQuotedPrintable(value: string, charset: string): string {
  const bytes: number[] = [];
  const s = value.replace(/=\r?\n/g, "");
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "=" && /^[0-9A-F]{2}$/i.test(s.slice(i + 1, i + 3))) {
      bytes.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(s.charCodeAt(i) & 0xff);
  }
  try {
    return new TextDecoder(charset || "utf-8").decode(new Uint8Array(bytes));
  } catch {
    return new TextDecoder("utf-8").decode(new Uint8Array(bytes));
  }
}

/** 2.1 escapes only semicolons, in structured values; 3.0 escapes commas and newlines too. */
function escape21to30(value: string, structured: boolean): string {
  const parts = structured ? value.split(/(?<!\\);/) : [value];
  return parts.map((p) => escapeText(p.replace(/\\;/g, ";"))).join(";");
}

const STRUCTURED = new Set(["N", "ADR", "ORG", "GENDER", "CLIENTPIDMAP"]);

/** A 2.1 property in 3.0's terms: quoted-printable decoded, CHARSET dropped, BASE64 renamed. */
function upgrade21(prop: Prop): Prop {
  const encoding = param(prop, "ENCODING").map((e) => e.toUpperCase());
  const charset = param(prop, "CHARSET")[0] ?? "utf-8";
  let { value } = prop;
  let params = prop.params.filter((p) => p.name !== "CHARSET");
  if (encoding.includes("QUOTED-PRINTABLE")) {
    value = escape21to30(decodeQuotedPrintable(value, charset), STRUCTURED.has(prop.name));
    params = params.filter((p) => p.name !== "ENCODING");
  } else if (encoding.includes("BASE64")) {
    params = params.map((p) => (p.name === "ENCODING" ? { name: "ENCODING", values: ["b"] } : p));
    value = value.replace(/\s+/g, "");
  } else {
    value = escape21to30(value, STRUCTURED.has(prop.name));
  }
  // TYPE values in 2.1 are bare words; INTERNET and the like stay as they are.
  return { ...prop, params, value };
}

/** Every card in a .vcf file. Lines that aren't valid properties are dropped. */
export function parseVCards(text: string): VCard[] {
  const cards: VCard[] = [];
  let props: Prop[] | null = null;
  const lines = unfold(text);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (!line.trim()) continue;
    // 2.1's quoted-printable soft line breaks end a line with "=".
    if (props && /;ENCODING=QUOTED-PRINTABLE/i.test(line.split(":")[0] ?? "")) {
      while (line.endsWith("=") && i + 1 < lines.length) line = line.slice(0, -1) + lines[++i];
    }
    const prop = parseLine(line);
    if (!prop) continue;
    if (prop.name === "BEGIN" && prop.value.toUpperCase() === "VCARD") {
      props = [];
    } else if (prop.name === "END" && prop.value.toUpperCase() === "VCARD") {
      if (props) {
        const version = props.find((p) => p.name === "VERSION")?.value.trim() ?? "3.0";
        const body = props.filter((p) => p.name !== "VERSION");
        cards.push(version === "2.1" ? { version: "3.0", props: body.map(upgrade21) } : { version: version === "4.0" ? "4.0" : "3.0", props: body });
      }
      props = null;
    } else if (props) {
      props.push(prop);
    }
  }
  return cards;
}

/** Text in a vCard value: \n, \, and \; are escaped; so is the backslash. */
export function unescapeText(value: string): string {
  return value.replace(/\\([\\,;nN])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));
}

export function escapeText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
}

/** A structured value's components (N: family;given;additional;prefix;suffix). */
function components(value: string): string[] {
  return value.split(/(?<!\\);/).map(unescapeText);
}

const NOT_LABELS = new Set(["INTERNET", "PREF", "X400", "VOICE", "TEXT", "OTHER"]);

/** A property's label: a TYPE such as home or work, or Apple's custom one for its group. */
function labelOf(card: VCard, prop: Prop): string {
  if (prop.group) {
    const custom = card.props.find((p) => p.group === prop.group && p.name === "X-ABLABEL");
    if (custom) return unescapeText(custom.value).replace(/^_\$!<(.*)>!\$_$/, "$1").toLowerCase();
  }
  const types = param(prop, "TYPE").flatMap((t) => t.split(",")).map((t) => t.toUpperCase());
  const type = (types.find((t) => !NOT_LABELS.has(t)) ?? "").toLowerCase();
  return type === "cell" ? "mobile" : type;
}

function isPreferred(prop: Prop): boolean {
  return param(prop, "PREF").length > 0 || param(prop, "TYPE").some((t) => t.toUpperCase() === "PREF");
}

const text = (card: VCard, name: string) => {
  const prop = card.props.find((p) => p.name === name);
  return prop ? unescapeText(prop.value).trim() : "";
};

/** A text list's values (NICKNAME, CATEGORIES): split at commas that aren't escaped. */
function listValues(card: VCard, name: string): string[] {
  return card.props
    .filter((p) => p.name === name)
    .flatMap((p) => p.value.split(/(?<!\\),/))
    .map((v) => unescapeText(v).trim())
    .filter(Boolean);
}

// ------------------------------------------------------------ dates

/** A date in a card, with its year or without (a day that comes round every year). */
export interface CardDate {
  year: number | null;
  month: number;
  day: number;
}

const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const leap = (year: number) => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
export const daysInMonth = (year: number | null, month: number) => (month === 2 && (year === null || leap(year)) ? 29 : DAYS[month - 1]);

/**
 * Reads a date as apps write it: 1990-05-12 or 19900512 (sometimes with a time after it);
 * --05-12 or --0512 without the year (RFC 6350 and Google); or Apple's year 1604 marked
 * X-APPLE-OMIT-YEAR=1604, which means none.
 */
export function parseCardDate(value: string, omitYear?: string): CardDate | null {
  const v = value.trim();
  let m = /^(\d{4})-?(\d{2})-?(\d{2})(T[\d:.]*(Z|[+-]\d{2}(:?\d{2})?)?)?$/.exec(v);
  let date: CardDate;
  if (m) date = { year: m[1] === omitYear ? null : Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  else if ((m = /^--(\d{2})-?(\d{2})$/.exec(v))) date = { year: null, month: Number(m[1]), day: Number(m[2]) };
  else return null;
  if (date.month < 1 || date.month > 12 || date.day < 1 || date.day > daysInMonth(date.year, date.month)) return null;
  return date;
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** How Viauna's page and API say a date: "1990-05-12", or "--05-12" without the year. */
export function cardDateText(d: CardDate): string {
  return `${d.year === null ? "-" : pad(d.year, 4)}-${pad(d.month)}-${pad(d.day)}`;
}

/** As a card of this version writes it: 4.0 has no hyphens in a date (RFC 6350 4.3.1). */
function writeDate(version: string, date: string): string {
  const d = parseCardDate(date);
  if (!d) return escapeText(date);
  if (version !== "4.0") return cardDateText(d);
  return `${d.year === null ? "--" : pad(d.year, 4)}${pad(d.month)}${pad(d.day)}`;
}

/** A date property's value as the page shows it: the date if it is one, else its text. */
function readDate(prop: Prop): string {
  const value = unescapeText(prop.value).trim();
  if (param(prop, "VALUE").some((v) => v.toLowerCase() === "text")) return value;
  const d = parseCardDate(value, param(prop, "X-APPLE-OMIT-YEAR")[0]);
  return d ? cardDateText(d) : value;
}

/** Anniversaries and other dates: vCard 4.0's ANNIVERSARY, KDE's, and Apple's labelled X-ABDATE (which Google writes too). */
const DATE_PROPS = new Set(["ANNIVERSARY", "X-ANNIVERSARY", "X-ABDATE"]);

/** A date's label: "anniversary", "other", or the words its app gave it. */
function dateLabel(card: VCard, prop: Prop): string {
  if (prop.name !== "X-ABDATE") return "anniversary";
  const custom = prop.group ? card.props.find((p) => p.group === prop.group && p.name === "X-ABLABEL") : undefined;
  const words = custom ? unescapeText(custom.value).trim().replace(/^_\$!<(.*)>!\$_$/, "$1") : "";
  return cleanDateLabel(words);
}

/** "Anniversary" and "Other" in any case are the usual two; anything else is the person's own. */
export function cleanDateLabel(label: string): string {
  const lower = label.trim().toLowerCase();
  return lower === "" || lower === "other" ? "other" : lower === "anniversary" ? "anniversary" : label.trim();
}

/** Google's own groups, which its export lists among the categories: kept in the card, not shown as labels. */
const HIDDEN_CATEGORY = /^(\* )?(myContacts|starred)$/;

/** Labels, each once, whatever its case or accents. */
export function uniqueLabels(labels: string[]): string[] {
  const seen = new Set<string>();
  return labels.filter((l) => {
    const key = fold(l);
    return !seen.has(key) && seen.add(key);
  });
}

export function readFields(card: VCard): ContactFields {
  const n = card.props.find((p) => p.name === "N");
  const [family = "", given = ""] = n ? components(n.value) : [];
  const ordered = (name: string) => card.props.filter((p) => p.name === name).sort((a, b) => Number(isPreferred(b)) - Number(isPreferred(a)));
  let firstName = given.trim();
  const lastName = family.trim();
  if (!firstName && !lastName) firstName = text(card, "FN");
  const bday = card.props.find((p) => p.name === "BDAY");
  return {
    firstName,
    lastName,
    nickname: listValues(card, "NICKNAME").join(", "),
    emails: ordered("EMAIL")
      .map((p) => ({ address: unescapeText(p.value).trim().replace(/^mailto:/i, ""), label: labelOf(card, p) }))
      .filter((e) => e.address),
    phones: ordered("TEL")
      .map((p) => ({ number: unescapeText(p.value).trim().replace(/^tel:/i, ""), label: labelOf(card, p) }))
      .filter((t) => t.number),
    organization: (() => {
      const org = card.props.find((p) => p.name === "ORG");
      return org ? (components(org.value)[0] ?? "").trim() : "";
    })(),
    title: text(card, "TITLE"),
    birthday: bday ? readDate(bday) : "",
    dates: card.props
      .filter((p) => DATE_PROPS.has(p.name))
      .map((p) => ({ date: readDate(p), label: dateLabel(card, p) }))
      .filter((d) => d.date),
    labels: uniqueLabels(listValues(card, "CATEGORIES").filter((c) => !HIDDEN_CATEGORY.test(c))),
    notes: text(card, "NOTE"),
  };
}

/** The name to show and sort by: FN, else the names, organisation or first address. */
export function displayName(card: VCard): string {
  const fn = text(card, "FN");
  if (fn) return fn;
  const f = readFields(card);
  return [f.firstName, f.lastName].filter(Boolean).join(" ") || f.organization || f.emails[0]?.address || f.phones[0]?.number || "";
}

export function cardUid(card: VCard): string | null {
  return text(card, "UID") || null;
}

// ------------------------------------------------------------ writing

function quoteParam(value: string): string {
  return /[:;,"]/.test(value) ? `"${value.replace(/"/g, "'")}"` : value;
}

function propLine(prop: Prop): string {
  const head = [`${prop.group ? `${prop.group}.` : ""}${prop.name}`, ...prop.params.map((p) => `${p.name}=${p.values.map(quoteParam).join(",")}`)].join(";");
  return `${head}:${prop.value}`;
}

/** Folds at 75 octets, never inside a UTF-8 character. */
function foldLine(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let start = 0;
  let limit = 75;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    out.push(bytes.subarray(start, end).toString("utf8"));
    start = end;
    limit = 74; // continuation lines start with a space
  }
  return out.join("\r\n ");
}

export function serializeVCard(card: VCard): string {
  const lines = ["BEGIN:VCARD", `VERSION:${card.version}`, ...card.props.map(propLine), "END:VCARD"];
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

const LABEL_TYPES: Record<string, string> = { home: "HOME", work: "WORK", mobile: "CELL", cell: "CELL", fax: "FAX", main: "MAIN", other: "OTHER" };

function typed(name: string, value: string, label: string, extra: string[] = []): Prop {
  const type = LABEL_TYPES[label.toLowerCase()];
  const types = [...extra, ...(type ? [type] : [])];
  const params: Param[] = types.length ? [{ name: "TYPE", values: types }] : [];
  return { group: null, name, params, value: escapeText(value) };
}

/**
 * Replaces one kind of property (EMAIL, TEL) with the list given. A value that was
 * there already keeps its property, group and parameters, so Apple's custom labels and
 * other apps' parameters survive; only its label is updated if it changed.
 */
function replaceList(card: VCard, name: string, wanted: { value: string; label: string }[], extra: string[]): Prop[] {
  const existing = card.props.filter((p) => p.name === name);
  const used = new Set<Prop>();
  const result: Prop[] = [];
  for (const w of wanted) {
    const match = existing.find((p) => !used.has(p) && unescapeText(p.value).trim().replace(/^(mailto|tel):/i, "").toLowerCase() === w.value.toLowerCase());
    if (match) {
      used.add(match);
      result.push(labelOf(card, match) === w.label.toLowerCase() || (match.group && !LABEL_TYPES[w.label.toLowerCase()]) ? match : { ...typed(name, w.value, w.label, extra), group: null });
    } else {
      result.push(typed(name, w.value, w.label, extra));
    }
  }
  return result;
}

function revision(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** A date with the X-ABLABEL its group gives it, so the two move together. */
function withLabel(card: VCard, prop: Prop): Prop[] {
  return [prop, ...(prop.group ? card.props.filter((p) => p.group === prop.group && p.name === "X-ABLABEL") : [])];
}

/** Apple's custom labels tie a property to an X-ABLABEL by a group, "item1": the next free one. */
function nextGroups(card: VCard): () => string {
  let n = Math.max(0, ...card.props.map((p) => Number(/^item(\d+)$/i.exec(p.group ?? "")?.[1] ?? 0)));
  return () => `item${++n}`;
}

/**
 * Replaces the anniversaries and other dates with those given. One that was there already,
 * the same date with the same label, keeps its property as it was; a new one is
 * ANNIVERSARY in a 4.0 card, else Apple's X-ABDATE with its X-ABLABEL, which Apple and
 * Google read.
 */
function replaceDates(card: VCard, wanted: { date: string; label: string }[]): Prop[] {
  const existing = card.props.filter((p) => DATE_PROPS.has(p.name));
  const used = new Set<Prop>();
  const group = nextGroups(card);
  const result: Prop[] = [];
  for (const w of wanted) {
    const label = cleanDateLabel(w.label);
    const match = existing.find((p) => !used.has(p) && readDate(p) === w.date && dateLabel(card, p) === label);
    if (match) {
      used.add(match);
      result.push(...withLabel(card, match));
      continue;
    }
    const value = writeDate(card.version, w.date);
    if (label === "anniversary" && card.version === "4.0") {
      result.push({ group: null, name: "ANNIVERSARY", params: [], value });
    } else {
      const g = group();
      const words = label === "anniversary" ? "_$!<Anniversary>!$_" : label === "other" ? "_$!<Other>!$_" : escapeText(label);
      result.push({ group: g, name: "X-ABDATE", params: [], value }, { group: g, name: "X-ABLABEL", params: [], value: words });
    }
  }
  return result;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The card with Viauna's fields set to these, everything else as it was. Properties
 * keep their order; replaced kinds take the place of the first of their kind. A field
 * that didn't change keeps its properties exactly as they were written.
 */
export function applyFields(card: VCard, fields: ContactFields): VCard {
  const was = readFields(card);
  const name = [fields.firstName, fields.lastName].map((s) => s.trim()).filter(Boolean).join(" ") || fields.organization.trim() || fields.emails[0]?.address || "";
  const oldN = card.props.find((p) => p.name === "N");
  const nParts = oldN ? oldN.value.split(/(?<!\\);/) : [];
  while (nParts.length < 5) nParts.push("");
  nParts[0] = escapeText(fields.lastName.trim());
  nParts[1] = escapeText(fields.firstName.trim());
  const oldOrg = card.props.find((p) => p.name === "ORG");
  const orgParts = oldOrg ? oldOrg.value.split(/(?<!\\);/) : [""];
  orgParts[0] = escapeText(fields.organization.trim());

  const single = (prop: string, value: string, old?: Prop): Prop[] =>
    value.trim() ? [{ ...(old ?? { group: null, params: [] }), name: prop, value: prop === "N" || prop === "ORG" ? value : escapeText(value.trim()) } as Prop] : [];
  const unchanged = (prop: string) => card.props.filter((p) => p.name === prop);
  const textList = (prop: string, values: string[]): Prop[] =>
    values.length ? [{ group: null, name: prop, params: [], value: values.map(escapeText).join(",") }] : [];
  const nicknames = fields.nickname.split(",").map((n) => n.trim()).filter(Boolean);
  // Google's own groups stay among the categories, ahead of the labels.
  const hidden = listValues(card, "CATEGORIES").filter((c) => HIDDEN_CATEGORY.test(c));

  const replacements: Record<string, Prop[]> = {
    FN: [{ group: null, name: "FN", params: [], value: escapeText(name) }],
    N: [{ group: oldN?.group ?? null, name: "N", params: oldN?.params ?? [], value: nParts.join(";") }],
    NICKNAME: nicknames.join(", ") === was.nickname ? unchanged("NICKNAME") : textList("NICKNAME", nicknames),
    EMAIL: replaceList(card, "EMAIL", fields.emails.map((e) => ({ value: e.address.trim(), label: e.label })), card.version === "3.0" ? ["INTERNET"] : []),
    TEL: replaceList(card, "TEL", fields.phones.map((t) => ({ value: t.number.trim(), label: t.label })), []),
    ORG: fields.organization.trim() || orgParts.slice(1).some(Boolean) ? single("ORG", orgParts.join(";"), oldOrg) : [],
    TITLE: single("TITLE", fields.title, card.props.find((p) => p.name === "TITLE")),
    BDAY:
      fields.birthday.trim() === was.birthday
        ? unchanged("BDAY")
        : fields.birthday.trim()
          ? [{ group: null, name: "BDAY", params: [], value: writeDate(card.version, fields.birthday.trim()) }]
          : [],
    DATES: same(fields.dates.map((d) => [d.date, cleanDateLabel(d.label)]), was.dates.map((d) => [d.date, d.label]))
      ? card.props.filter((p) => DATE_PROPS.has(p.name)).flatMap((p) => withLabel(card, p))
      : replaceDates(card, fields.dates),
    CATEGORIES: same(fields.labels, was.labels) ? unchanged("CATEGORIES") : textList("CATEGORIES", [...hidden, ...uniqueLabels(fields.labels)]),
    NOTE: single("NOTE", fields.notes, card.props.find((p) => p.name === "NOTE")),
    REV: [{ group: null, name: "REV", params: [], value: revision() }],
  };
  const kindOf = (prop: string) => (DATE_PROPS.has(prop) ? "DATES" : prop);
  // The dates' labels are placed with them.
  const carried = new Set(replacements.DATES.filter((p) => p.name === "X-ABLABEL"));
  const props: Prop[] = [];
  const placed = new Set<string>();
  for (const p of card.props) {
    if (carried.has(p)) continue;
    const kind = kindOf(p.name);
    const r = replacements[kind];
    if (!r) props.push(p);
    else if (!placed.has(kind)) {
      props.push(...r);
      placed.add(kind);
    }
  }
  for (const [kind, r] of Object.entries(replacements)) if (!placed.has(kind)) props.push(...r);
  // A custom label whose property is gone would label nothing.
  const groups = new Set(props.filter((p) => p.group && p.name !== "X-ABLABEL").map((p) => p.group));
  return { version: card.version, props: props.filter((p) => !(p.name === "X-ABLABEL" && p.group && !groups.has(p.group))) };
}

export function newCard(fields: ContactFields, uid: string, prodid: string): VCard {
  const card: VCard = {
    version: "3.0",
    props: [
      { group: null, name: "PRODID", params: [], value: prodid },
      { group: null, name: "UID", params: [], value: uid },
    ],
  };
  return applyFields(card, fields);
}

/** Checks a card is one Viauna can keep: not too large, and naming someone. */
export function checkCard(card: VCard): string | null {
  if (serializeVCard(card).length > MAX_CARD) return "That contact is too large (over 1 MB).";
  if (!displayName(card)) return "A contact needs a name, a company, an email address or a phone number.";
  return null;
}

// ------------------------------------------------------------ what's kept beside a card

const ADDRESS = /^[^\s@]+@[^\s@]+$/;

export interface CardIndex {
  name: string;
  sortKey: string;
  /** Folded names, nickname, company, addresses and phone digits, to search. */
  search: string;
  /** Lower-cased, for suggestions and "is this a contact". */
  emails: string[];
  /** As written, and folded to group spellings. */
  labels: { label: string; key: string }[];
  /** The dates that are dates (another app's wording isn't), for the Birthdays calendar. */
  dates: { kind: "birthday" | "anniversary" | "other"; label: string; year: number | null; month: number; day: number }[];
}

/** What the state store keeps beside a card, to list, search, filter and suggest without reading it. */
export function cardIndex(card: VCard): CardIndex {
  const name = displayName(card).slice(0, 500);
  const f = readFields(card);
  const emails = [...new Set(f.emails.map((e) => e.address.toLowerCase()).filter((a) => ADDRESS.test(a) && a.length <= 320))];
  const search = fold([name, f.nickname, f.organization, ...emails, ...f.phones.map((p) => p.number.replace(/[^\d+]/g, ""))].join(" "));
  const dates: CardIndex["dates"] = [];
  const birthday = parseCardDate(f.birthday);
  if (birthday) dates.push({ kind: "birthday", label: "", ...birthday });
  for (const d of f.dates) {
    const date = parseCardDate(d.date);
    if (date) dates.push({ kind: d.label === "anniversary" ? "anniversary" : "other", label: d.label === "anniversary" || d.label === "other" ? "" : d.label.slice(0, 100), ...date });
  }
  return {
    name,
    sortKey: fold(name).slice(0, 500),
    search,
    emails,
    labels: f.labels.map((l) => ({ label: l.slice(0, 100), key: fold(l).slice(0, 100) })),
    dates,
  };
}
