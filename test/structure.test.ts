import { describe, expect, it } from "vitest";
import { countAttachments, findTextPart } from "../server/mail/structure.ts";

const node = (type: string, extra: Record<string, unknown> = {}) => ({ type, ...extra });

describe("body structure", () => {
  const msg = node("multipart/mixed", {
    childNodes: [
      node("multipart/related", {
        childNodes: [
          node("multipart/alternative", { childNodes: [node("text/plain", { part: "1.1.1", parameters: { charset: "utf-8" } }), node("text/html", { part: "1.1.2" })] }),
          node("image/png", { part: "1.2", id: "<logo@x>", disposition: "inline" }),
        ],
      }),
      node("application/pdf", { part: "2", disposition: "attachment", dispositionParameters: { filename: "a.pdf" } }),
      node("application/pgp-signature", { part: "3" }),
    ],
  });

  it("counts real attachments only (not inline images or signatures)", () => {
    expect(countAttachments(msg as never)).toBe(1);
  });

  it("prefers text/plain for the snippet", () => {
    expect(findTextPart(msg as never)).toEqual({ part: "1.1.1", type: "text/plain", charset: "utf-8", encoding: undefined });
  });

  it("treats a single-part body as part 1", () => {
    expect(findTextPart(node("text/html") as never)?.part).toBe("1");
  });
});
