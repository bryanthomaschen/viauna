import { beforeEach, describe, expect, it } from "vitest";
import { Database } from "../server/db.ts";
import { assignThread, parseMessageIds, subjectKey } from "../server/mail/threading.ts";

describe("subjectKey", () => {
  it("strips reply/forward prefixes in several languages and list tags", () => {
    expect(subjectKey("Re: Re: Lunch")).toBe("lunch");
    expect(subjectKey("RE: Fwd: [team] Lunch")).toBe("lunch");
    expect(subjectKey("AW: WG: Lunch")).toBe("lunch");
    expect(subjectKey("Re[2]: Lunch")).toBe("lunch");
    expect(subjectKey("  Lunch   plans ")).toBe("lunch plans");
    expect(subjectKey(undefined)).toBe("");
  });
});

describe("parseMessageIds", () => {
  it("extracts ids, lowercased", () => {
    expect(parseMessageIds("<A@x> <b@Y>\r\n <c@z>")).toEqual(["<a@x>", "<b@y>", "<c@z>"]);
    expect(parseMessageIds("bare@id")).toEqual(["<bare@id>"]);
    expect(parseMessageIds("")).toEqual([]);
  });
});

describe("assignThread", () => {
  let db: Database;
  const insert = (id: string, parents: string[], subject: string, mailbox = 1, uid = Math.floor(Math.random() * 1e9)) => {
    const thread = assignThread(db, 1, { messageId: id, parents, subject });
    db.run(
      "INSERT INTO messages (mailbox_id, uid, account_id, thread_id, message_id, subject, addresses, date) VALUES (?, ?, 1, ?, ?, ?, '{}', 0)",
      mailbox, uid, thread, id, subject,
    );
    return thread;
  };

  beforeEach(() => {
    db = new Database(":memory:");
    db.run("INSERT INTO accounts (id, login, email, imap, smtp, created_at) VALUES (1, 'a', 'a@x', '{}', '{}', 0)");
    db.run("INSERT INTO mailboxes (id, account_id, path, name) VALUES (1, 1, 'INBOX', 'INBOX'), (2, 1, 'Sent', 'Sent')");
  });

  it("groups a reply with its parent", () => {
    const a = insert("<1@x>", [], "Lunch");
    const b = insert("<2@x>", ["<1@x>"], "Re: Lunch", 2);
    expect(b).toBe(a);
  });

  it("joins a parent that arrives after its reply", () => {
    const reply = insert("<2@x>", ["<1@x>"], "Re: Lunch");
    const parent = insert("<1@x>", [], "Lunch");
    expect(parent).toBe(reply);
  });

  it("merges two branches when a later message references both", () => {
    const a = insert("<a@x>", [], "Plan");
    const b = insert("<b@x>", ["<missing@x>"], "Re: Plan");
    expect(b).not.toBe(a);
    const c = insert("<c@x>", ["<a@x>", "<b@x>"], "Re: Plan");
    expect(c).toBe(Math.min(a, b));
    const rows = db.all<{ thread_id: number }>("SELECT DISTINCT thread_id FROM messages");
    expect(rows).toHaveLength(1);
  });

  it("starts a new conversation when a reply changes the subject (as Gmail does)", () => {
    const a = insert("<1@x>", [], "Lunch");
    const b = insert("<2@x>", ["<1@x>"], "Totally different topic");
    expect(b).not.toBe(a);
  });

  it("puts a copy of the same message (another folder) in the same thread", () => {
    const a = insert("<1@x>", [], "Lunch", 1);
    const b = insert("<1@x>", [], "Lunch", 2);
    expect(b).toBe(a);
  });
});
