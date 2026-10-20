// vCard (RFC 6350 for 4.0, RFC 2426 for 3.0, and 2.1 as Outlook and old phones still
// write it), read and written without losing anything. A card is its list of
// properties, kept as they came; Viauna edits only the fields it shows (names,
// addresses, phones, organisation, title, birthday, notes) and leaves the rest (photos,
// postal addresses, other apps' own fields) for whichever app wrote them. 2.1 cards are
// brought up to 3.0 on the way in, since nothing reads 2.1's quoted-printable well.

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
  emails: { address: string; label: string }[];
  phones: { number: string; label: string }[];
  organization: string;
  title: string;
  birthday: string;
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

export function readFields(card: VCard): ContactFields {
  const n = card.props.find((p) => p.name === "N");
  const [family = "", given = ""] = n ? components(n.value) : [];
  const ordered = (name: string) => card.props.filter((p) => p.name === name).sort((a, b) => Number(isPreferred(b)) - Number(isPreferred(a)));
  let firstName = given.trim();
  const lastName = family.trim();
  if (!firstName && !lastName) firstName = text(card, "FN");
  return {
    firstName,
    lastName,
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
    birthday: text(card, "BDAY"),
    notes: text(card, "NOTE"),
  };
}

/** The name to show and sort by: FN, else the names, organisation or first address. */
export function displayName(card: VCard): string {
  const fn = text(card, "FN");
  if (fn) return fn;
  const f = readFields(card);
  return [f.firstName, f.lastName].filter(Boolean).join(" ") || f.organization || f.emails[0]?.address || "";
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
function fold(line: string): string {
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
  return lines.map(fold).join("\r\n") + "\r\n";
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

/**
 * The card with Viauna's fields set to these, everything else as it was. Properties
 * keep their order; replaced kinds take the place of the first of their kind.
 */
export function applyFields(card: VCard, fields: ContactFields): VCard {
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

  const replacements: Record<string, Prop[]> = {
    FN: [{ group: null, name: "FN", params: [], value: escapeText(name) }],
    N: [{ group: oldN?.group ?? null, name: "N", params: oldN?.params ?? [], value: nParts.join(";") }],
    EMAIL: replaceList(card, "EMAIL", fields.emails.map((e) => ({ value: e.address.trim(), label: e.label })), card.version === "3.0" ? ["INTERNET"] : []),
    TEL: replaceList(card, "TEL", fields.phones.map((t) => ({ value: t.number.trim(), label: t.label })), []),
    ORG: fields.organization.trim() || orgParts.slice(1).some(Boolean) ? single("ORG", orgParts.join(";"), oldOrg) : [],
    TITLE: single("TITLE", fields.title, card.props.find((p) => p.name === "TITLE")),
    BDAY: single("BDAY", fields.birthday, card.props.find((p) => p.name === "BDAY")),
    NOTE: single("NOTE", fields.notes, card.props.find((p) => p.name === "NOTE")),
    REV: [{ group: null, name: "REV", params: [], value: revision() }],
  };
  const props: Prop[] = [];
  const placed = new Set<string>();
  for (const p of card.props) {
    const r = replacements[p.name];
    if (!r) props.push(p);
    else if (!placed.has(p.name)) {
      props.push(...r);
      placed.add(p.name);
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
  if (!displayName(card)) return "A contact needs a name, an organisation or an email address.";
  return null;
}
