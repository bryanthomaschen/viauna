// vCard in and out (server/vcard.ts): the formats people export, kept whole.
import { describe, expect, it } from "vitest";
import {
  applyFields,
  cardIndex,
  displayName,
  escapeText,
  newCard,
  parseCardDate,
  parseVCards,
  readFields,
  serializeVCard,
  unescapeText,
} from "../server/vcard.ts";

// As Google Contacts exports them.
const GOOGLE = [
  "BEGIN:VCARD",
  "VERSION:3.0",
  "FN:Ann Lee",
  "N:Lee;Ann;;;",
  "EMAIL;TYPE=INTERNET;TYPE=HOME:ann@example.com",
  "EMAIL;TYPE=INTERNET;TYPE=WORK:ann.lee@work.example",
  "TEL;TYPE=CELL:+65 9123 4567",
  "item1.EMAIL;TYPE=INTERNET:ann@club.example",
  "item1.X-ABLabel:Club",
  "ORG:Example Pte Ltd;Research",
  "TITLE:Engineer",
  "BDAY:1990-04-01",
  "NOTE:Met at the conference\\, 2024\\nLikes tea",
  "ADR;TYPE=HOME:;;1 Orchard Rd;Singapore;;238823;SG",
  "PHOTO:https://lh3.googleusercontent.com/contacts/AG6tpzG_photo_that_is_long_enough_to_be_fo",
  " lded_across_two_lines",
  "CATEGORIES:myContacts",
  "END:VCARD",
  "",
].join("\r\n");

// Apple Contacts: lower-case types, PREF as a type, custom labels in groups.
const APPLE = [
  "BEGIN:VCARD",
  "VERSION:3.0",
  "PRODID:-//Apple Inc.//macOS 15.0//EN",
  "N:Tan;Bob;;;",
  "FN:Bob Tan",
  "item1.TEL;type=pref:+65 6123 4567",
  "item1.X-ABLabel:_$!<Mobile>!$_",
  "EMAIL;type=INTERNET;type=WORK;type=pref:bob@work.example",
  "X-ABUID:5A1B-ABPerson",
  "UID:5a1b2c3d-apple",
  "END:VCARD",
].join("\n");

// Outlook and old phones: 2.1, bare types, quoted-printable with a soft line break.
const V21 = [
  "BEGIN:VCARD",
  "VERSION:2.1",
  "N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:M=C3=BCller;J=C3=BCrgen;;;",
  "FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:J=C3=BCrgen M=C3=BCller",
  "TEL;HOME;VOICE:+49 30 1234",
  "EMAIL;PREF;INTERNET:juergen@example.de",
  "NOTE;ENCODING=QUOTED-PRINTABLE;CHARSET=ISO-8859-1:Gr=FC=DFe, eine lange Notiz die =",
  "umbricht",
  "END:VCARD",
].join("\r\n");

const V40 = [
  "BEGIN:VCARD",
  "VERSION:4.0",
  "FN:Chen Wei",
  "N:Chen;Wei;;;",
  'TEL;VALUE=uri;TYPE="voice,cell":tel:+65-8000-0000',
  "EMAIL;PREF=1:wei@example.sg",
  "EMAIL:wei@other.example",
  "UID:urn:uuid:4fbe8971-0bc3-424c-9c26-36c3e1eff6b1",
  "END:VCARD",
].join("\r\n");

describe("reading vCards", () => {
  it("reads Google's export, labels and all", () => {
    const [card] = parseVCards(GOOGLE);
    expect(readFields(card)).toEqual({
      firstName: "Ann",
      lastName: "Lee",
      nickname: "",
      emails: [
        { address: "ann@example.com", label: "home" },
        { address: "ann.lee@work.example", label: "work" },
        { address: "ann@club.example", label: "club" },
      ],
      phones: [{ number: "+65 9123 4567", label: "mobile" }],
      organization: "Example Pte Ltd",
      title: "Engineer",
      birthday: "1990-04-01",
      dates: [],
      labels: [],
      notes: "Met at the conference, 2024\nLikes tea",
    });
    expect(card.props.find((p) => p.name === "PHOTO")?.value).toBe("https://lh3.googleusercontent.com/contacts/AG6tpzG_photo_that_is_long_enough_to_be_folded_across_two_lines");
  });

  it("reads Apple's custom labels and preferred values first", () => {
    const [card] = parseVCards(APPLE);
    const f = readFields(card);
    expect(f.phones).toEqual([{ number: "+65 6123 4567", label: "mobile" }]);
    expect(f.emails).toEqual([{ address: "bob@work.example", label: "work" }]);
  });

  it("brings 2.1 up to 3.0: quoted-printable, charsets and bare types", () => {
    const [card] = parseVCards(V21);
    expect(card.version).toBe("3.0");
    expect(displayName(card)).toBe("Jürgen Müller");
    const f = readFields(card);
    expect(f).toMatchObject({ firstName: "Jürgen", lastName: "Müller", notes: "Grüße, eine lange Notiz die umbricht" });
    expect(f.phones).toEqual([{ number: "+49 30 1234", label: "home" }]);
    expect(f.emails).toEqual([{ address: "juergen@example.de", label: "" }]);
    expect(serializeVCard(card)).not.toMatch(/QUOTED-PRINTABLE|CHARSET/);
  });

  it("reads 4.0's tel: addresses and PREF parameters", () => {
    const [card] = parseVCards(V40);
    expect(card.version).toBe("4.0");
    const f = readFields(card);
    expect(f.phones).toEqual([{ number: "+65-8000-0000", label: "mobile" }]);
    expect(f.emails.map((e) => e.address)).toEqual(["wei@example.sg", "wei@other.example"]);
  });

  it("reads several cards from one file, and skips what isn't one", () => {
    const cards = parseVCards(`${GOOGLE}\r\nnot a card\r\n${APPLE}\r\nBEGIN:VCARD\r\nVERSION:3.0\r\nFN:Unfinished`);
    expect(cards.map(displayName)).toEqual(["Ann Lee", "Bob Tan"]);
  });

  it("escapes and unescapes text", () => {
    for (const s of ["a,b;c\\d\ne", "plain", "trailing\\"]) expect(unescapeText(escapeText(s))).toBe(s);
    expect(unescapeText("a\\Nb")).toBe("a\nb");
  });
});

describe("writing vCards", () => {
  it("round-trips a card unchanged", () => {
    for (const source of [GOOGLE, APPLE, V40]) {
      const [card] = parseVCards(source);
      expect(parseVCards(serializeVCard(card))).toEqual([card]);
    }
  });

  it("folds long lines at 75 octets without splitting a character", () => {
    const [card] = parseVCards(GOOGLE);
    const edited = applyFields(card, { ...readFields(card), notes: "日本語のメモ".repeat(20) });
    const out = serializeVCard(edited);
    for (const line of out.split("\r\n")) expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
    expect(readFields(parseVCards(out)[0]).notes).toBe("日本語のメモ".repeat(20));
  });

  it("changes only what it edits, and keeps photos, addresses and other apps' fields", () => {
    const [card] = parseVCards(GOOGLE);
    const f = readFields(card);
    const edited = applyFields(card, {
      ...f,
      firstName: "Annie",
      emails: [f.emails[2], { address: "annie@new.example", label: "work" }],
      phones: [],
    });
    const back = readFields(edited);
    expect(back.firstName).toBe("Annie");
    expect(displayName(edited)).toBe("Annie Lee");
    expect(back.emails).toEqual([
      { address: "ann@club.example", label: "club" },
      { address: "annie@new.example", label: "work" },
    ]);
    expect(back.phones).toEqual([]);
    for (const kept of ["PHOTO", "ADR", "CATEGORIES"]) {
      expect(edited.props.find((p) => p.name === kept)).toEqual(card.props.find((p) => p.name === kept));
    }
    // The department after the organisation, and N's other parts, stay.
    expect(edited.props.find((p) => p.name === "ORG")?.value).toBe("Example Pte Ltd;Research");
    expect(edited.props.find((p) => p.name === "REV")?.value).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  });

  it("drops a custom label once nothing carries it", () => {
    const [card] = parseVCards(APPLE);
    const edited = applyFields(card, { ...readFields(card), phones: [] });
    expect(edited.props.some((p) => p.name === "X-ABLABEL")).toBe(false);
    expect(edited.props.find((p) => p.name === "X-ABUID")).toBeTruthy();
  });

  it("makes a new 3.0 card", () => {
    const card = newCard(
      {
        firstName: "Dee", lastName: "Ng", nickname: "", emails: [{ address: "dee@example.com", label: "home" }], phones: [{ number: "123", label: "mobile" }],
        organization: "", title: "", birthday: "", dates: [], labels: [], notes: "",
      },
      "urn:uuid:1234",
      "-//Viauna//Viauna 0.4//EN",
    );
    const out = serializeVCard(card);
    expect(out).toMatch(/^BEGIN:VCARD\r\nVERSION:3\.0\r\nPRODID:-\/\/Viauna\/\/Viauna 0\.4\/\/EN\r\nUID:urn:uuid:1234\r\n/);
    expect(out).toContain("FN:Dee Ng\r\nN:Ng;Dee;;;\r\n");
    expect(out).toContain("EMAIL;TYPE=INTERNET,HOME:dee@example.com\r\n");
    expect(out).toContain("TEL;TYPE=CELL:123\r\n");
    expect(out).not.toMatch(/\r\n(ORG|TITLE|BDAY|NOTE|NICKNAME|CATEGORIES|X-ABDATE)[:;]/);
  });
});

describe("nicknames, labels and dates", () => {
  // Apple: a birthday without its year, an anniversary and a date of the person's own.
  const APPLE_DATES = [
    "BEGIN:VCARD", "VERSION:3.0", "N:Lim;Kai;;;", "FN:Kai Lim", "NICKNAME:KL",
    "BDAY;X-APPLE-OMIT-YEAR=1604:1604-02-29",
    "item1.X-ABDATE;type=pref:2015-06-20", "item1.X-ABLabel:_$!<Anniversary>!$_",
    "item2.X-ABDATE:2020-01-06", "item2.X-ABLabel:First day at work",
    "END:VCARD", "",
  ].join("\r\n");
  // vCard 4.0 (Thunderbird): ANNIVERSARY, and dates without hyphens.
  const V4 = ["BEGIN:VCARD", "VERSION:4.0", "FN:Mo Ali", "N:Ali;Mo;;;", "BDAY:--0512", "ANNIVERSARY:20101009", "CATEGORIES:Family,Friends", "END:VCARD", ""].join("\r\n");

  it("reads dates as apps write them, with or without the year", () => {
    expect(parseCardDate("1990-05-12")).toEqual({ year: 1990, month: 5, day: 12 });
    expect(parseCardDate("19900512")).toEqual({ year: 1990, month: 5, day: 12 });
    expect(parseCardDate("1990-05-12T00:00:00Z")).toEqual({ year: 1990, month: 5, day: 12 });
    expect(parseCardDate("--05-12")).toEqual({ year: null, month: 5, day: 12 });
    expect(parseCardDate("--0229")).toEqual({ year: null, month: 2, day: 29 });
    expect(parseCardDate("1604-02-29", "1604")).toEqual({ year: null, month: 2, day: 29 });
    expect(parseCardDate("1990-02-29")).toBeNull();
    expect(parseCardDate("2000-02-29")).toEqual({ year: 2000, month: 2, day: 29 });
    expect(parseCardDate("2023-13-01")).toBeNull();
    expect(parseCardDate("circa 1800")).toBeNull();
  });

  it("reads the nickname, the labels and the dates", () => {
    const apple = readFields(parseVCards(APPLE_DATES)[0]);
    expect(apple).toMatchObject({
      nickname: "KL",
      birthday: "--02-29",
      dates: [{ date: "2015-06-20", label: "anniversary" }, { date: "2020-01-06", label: "First day at work" }],
      labels: [],
    });
    expect(readFields(parseVCards(V4)[0])).toMatchObject({ birthday: "--05-12", dates: [{ date: "2010-10-09", label: "anniversary" }], labels: ["Family", "Friends"] });
    // Google's own groups aren't labels.
    expect(readFields(parseVCards(GOOGLE)[0]).labels).toEqual([]);
    const listed = parseVCards("BEGIN:VCARD\r\nVERSION:3.0\r\nFN:X\r\nNICKNAME:Bobby,Rob\r\nCATEGORIES:Church,church,Work\\, old,myContacts\r\nEND:VCARD\r\n")[0];
    expect(readFields(listed)).toMatchObject({ nickname: "Bobby, Rob", labels: ["Church", "Work, old"] });
    // Wording a date app gave its date is kept as it is.
    expect(readFields(parseVCards("BEGIN:VCARD\r\nVERSION:4.0\r\nFN:X\r\nBDAY;VALUE=text:circa 1800\r\nEND:VCARD\r\n")[0]).birthday).toBe("circa 1800");
  });

  it("leaves dates, nicknames and labels nobody changed exactly as they were written", () => {
    const [card] = parseVCards(APPLE_DATES);
    const edited = applyFields(card, { ...readFields(card), title: "Chef" });
    const lines = serializeVCard(edited).split("\r\n");
    for (const line of ["NICKNAME:KL", "BDAY;X-APPLE-OMIT-YEAR=1604:1604-02-29", "item1.X-ABDATE;TYPE=pref:2015-06-20", "item2.X-ABLABEL:First day at work"]) {
      expect(lines).toContain(line);
    }
  });

  it("writes changed dates in the card's own version", () => {
    const [apple] = parseVCards(APPLE_DATES);
    const f = readFields(apple);
    const edited = applyFields(apple, { ...f, birthday: "--03-04", dates: [f.dates[1], { date: "2001-02-03", label: "Graduated" }, { date: "--07-08", label: "anniversary" }] });
    const out = serializeVCard(edited);
    // A new value takes none of the old one's parameters (Apple's year 1604 would become real).
    expect(out).toContain("\r\nBDAY:--03-04\r\n");
    expect(out).toContain("item2.X-ABDATE:2020-01-06\r\nitem2.X-ABLABEL:First day at work\r\n");
    expect(out).toContain("item3.X-ABDATE:2001-02-03\r\nitem3.X-ABLABEL:Graduated\r\n");
    expect(out).toContain("item4.X-ABDATE:--07-08\r\nitem4.X-ABLABEL:_$!<Anniversary>!$_\r\n");
    // The anniversary taken away goes with its label.
    expect(out).not.toContain("item1.");
    expect(readFields(parseVCards(out)[0]).dates).toEqual([
      { date: "2020-01-06", label: "First day at work" },
      { date: "2001-02-03", label: "Graduated" },
      { date: "--07-08", label: "anniversary" },
    ]);

    const [v4] = parseVCards(V4);
    const out4 = serializeVCard(applyFields(v4, { ...readFields(v4), birthday: "1980-01-02", dates: [{ date: "--10-09", label: "anniversary" }] }));
    expect(out4).toContain("\r\nBDAY:19800102\r\n");
    expect(out4).toContain("\r\nANNIVERSARY:--1009\r\n");
  });

  it("writes labels as categories, keeping Google's own groups, and nicknames as a list", () => {
    const [card] = parseVCards(GOOGLE);
    const out = serializeVCard(applyFields(card, { ...readFields(card), labels: ["Church", "Work, old"], nickname: "Annie, A" }));
    expect(out).toContain("\r\nCATEGORIES:myContacts,Church,Work\\, old\r\n");
    expect(out).toContain("\r\nNICKNAME:Annie,A\r\n");
    const back = readFields(parseVCards(out)[0]);
    expect(back).toMatchObject({ labels: ["Church", "Work, old"], nickname: "Annie, A" });
    const none = serializeVCard(applyFields(card, { ...readFields(card), labels: [] }));
    expect(none).toContain("\r\nCATEGORIES:myContacts\r\n");
  });

  it("indexes the labels and the dates that are dates, and searches nicknames", () => {
    const index = cardIndex(parseVCards(APPLE_DATES)[0]);
    expect(index.dates).toEqual([
      { kind: "birthday", label: "", year: null, month: 2, day: 29 },
      { kind: "anniversary", label: "", year: 2015, month: 6, day: 20 },
      { kind: "other", label: "First day at work", year: 2020, month: 1, day: 6 },
    ]);
    expect(index.search).toContain("kl");
    expect(cardIndex(parseVCards(V4)[0]).labels).toEqual([{ label: "Family", key: "family" }, { label: "Friends", key: "friends" }]);
  });
});
