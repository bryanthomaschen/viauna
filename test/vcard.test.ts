// vCard in and out (server/vcard.ts): the formats people export, kept whole.
import { describe, expect, it } from "vitest";
import { applyFields, displayName, escapeText, newCard, parseVCards, readFields, serializeVCard, unescapeText } from "../server/vcard.ts";

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
      emails: [
        { address: "ann@example.com", label: "home" },
        { address: "ann.lee@work.example", label: "work" },
        { address: "ann@club.example", label: "club" },
      ],
      phones: [{ number: "+65 9123 4567", label: "mobile" }],
      organization: "Example Pte Ltd",
      title: "Engineer",
      birthday: "1990-04-01",
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
      { firstName: "Dee", lastName: "Ng", emails: [{ address: "dee@example.com", label: "home" }], phones: [{ number: "123", label: "mobile" }], organization: "", title: "", birthday: "", notes: "" },
      "urn:uuid:1234",
      "-//Viauna//Viauna 0.4//EN",
    );
    const out = serializeVCard(card);
    expect(out).toMatch(/^BEGIN:VCARD\r\nVERSION:3\.0\r\nPRODID:-\/\/Viauna\/\/Viauna 0\.4\/\/EN\r\nUID:urn:uuid:1234\r\n/);
    expect(out).toContain("FN:Dee Ng\r\nN:Ng;Dee;;;\r\n");
    expect(out).toContain("EMAIL;TYPE=INTERNET,HOME:dee@example.com\r\n");
    expect(out).toContain("TEL;TYPE=CELL:123\r\n");
    expect(out).not.toMatch(/\r\n(ORG|TITLE|BDAY|NOTE)[:;]/);
  });
});
