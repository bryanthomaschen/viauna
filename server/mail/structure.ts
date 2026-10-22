// What the list view needs from a message without downloading it: whether it has real
// attachments (the paperclip), and which body part to read a snippet from.
import type { MessageStructureObject } from "imapflow";

export interface TextPart {
  part: string;
  type: string;
  charset?: string;
  encoding?: string;
}

const SIGNATURE_TYPES = new Set([
  "application/pgp-signature",
  "application/pkcs7-signature",
  "application/x-pkcs7-signature",
  "application/pgp-keys",
]);

function filename(node: MessageStructureObject): string | undefined {
  return node.dispositionParameters?.filename || node.parameters?.name;
}

/** A leaf the user would call an attachment (not an inline image of an HTML body). */
export function isAttachment(node: MessageStructureObject, insideRelated: boolean): boolean {
  const type = node.type.toLowerCase();
  if (type.startsWith("multipart/")) return false;
  if (SIGNATURE_TYPES.has(type)) return false;
  const disposition = node.disposition?.toLowerCase();
  if (disposition === "attachment") return true;
  if (type === "message/rfc822") return true;
  if ((type === "text/plain" || type === "text/html") && !filename(node)) return false;
  // Inline images referenced from the HTML body (multipart/related + Content-ID).
  if (insideRelated && node.id && disposition !== "attachment") return false;
  if (disposition === "inline" && type.startsWith("image/") && node.id) return false;
  return !!filename(node) || (!type.startsWith("text/") && disposition !== "inline");
}

export function countAttachments(root: MessageStructureObject | undefined): number {
  if (!root) return 0;
  let count = 0;
  const walk = (node: MessageStructureObject, insideRelated: boolean) => {
    const type = node.type.toLowerCase();
    if (node.childNodes?.length) {
      // An attached message counts once; don't descend into it.
      if (type === "message/rfc822") {
        count++;
        return;
      }
      const related = insideRelated || type === "multipart/related";
      for (const child of node.childNodes) walk(child, related);
      return;
    }
    if (isAttachment(node, insideRelated)) count++;
  };
  walk(root, false);
  return count;
}

/** The body part to show as the snippet: text/plain if there is one, else text/html. */
export function findTextPart(root: MessageStructureObject | undefined): TextPart | null {
  if (!root) return null;
  let plain: TextPart | null = null;
  let html: TextPart | null = null;
  const walk = (node: MessageStructureObject, insideRelated: boolean) => {
    if (plain) return;
    const type = node.type.toLowerCase();
    if (type === "message/rfc822") return;
    if (node.childNodes?.length) {
      for (const child of node.childNodes) walk(child, insideRelated || type === "multipart/related");
      return;
    }
    if (node.disposition?.toLowerCase() === "attachment") return;
    if (type !== "text/plain" && type !== "text/html") return;
    const entry: TextPart = {
      // A single-part message has no part number; its body is part 1.
      part: node.part || "1",
      type,
      charset: node.parameters?.charset,
      encoding: node.encoding?.toLowerCase(),
    };
    if (type === "text/plain") plain = entry;
    else if (!html) html = entry;
  };
  walk(root, false);
  return plain ?? html;
}
