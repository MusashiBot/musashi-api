// Shared text-processing helpers used across the analysis pipeline.
// Extracted so keyword-matcher.ts and entity-extractor.ts can both use the
// same word-boundary check (needed by Fix D to stop "fed" matching inside
// "fedex", "sec" inside "second", etc.).

/** Returns true if a character is a word character (letter, digit, apostrophe). */
export function isWordChar(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return (
    (code >= 97 && code <= 122) || // a-z
    (code >= 65 && code <= 90)  || // A-Z
    (code >= 48 && code <= 57)  || // 0-9
    code === 39                    // apostrophe
  );
}

/**
 * Checks whether `term` appears in `text` as a whole word (respects word
 * boundaries). "fed" matches "fed up" and "the fed cut" but NOT "fedex",
 * "fedora", or "federation".
 *
 * Inlined char-code check (not regex) because this is called thousands of
 * times per tweet in the hot scoring path.
 */
export function hasWordBoundaryMatch(text: string, term: string): boolean {
  const termLower = term.toLowerCase();
  const textLower = text.toLowerCase();
  let idx = textLower.indexOf(termLower);
  while (idx !== -1) {
    const before = idx === 0 || !isWordChar(textLower[idx - 1]);
    const after  =
      idx + termLower.length >= textLower.length ||
      !isWordChar(textLower[idx + termLower.length]);
    if (before && after) return true;
    idx = textLower.indexOf(termLower, idx + 1);
  }
  return false;
}
