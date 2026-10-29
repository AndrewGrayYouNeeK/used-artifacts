/** Case-, accent-, punctuation- and spacing-insensitive comparison form of a person's name. */
export function normalizeLegalName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function legalNamesMatch(signed: string, verified: string): boolean {
  const a = normalizeLegalName(signed);
  return a.length > 0 && a === normalizeLegalName(verified);
}
