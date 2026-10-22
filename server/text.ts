// Text as the state store searches it: folded for comparing, and as a LIKE pattern. The
// engines differ in case and collation, so search columns hold folded text and every
// query folds what it looks for the same way.

/** Lower-cased, and with accents gone, so "Élodie" sorts with "elodie". */
export function fold(text: string): string {
  return text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** A LIKE pattern for `text` anywhere, with "!" as the escape (the same on every engine). */
export function contains(text: string): string {
  return `%${text.replace(/[!%_]/g, (c) => `!${c}`)}%`;
}
