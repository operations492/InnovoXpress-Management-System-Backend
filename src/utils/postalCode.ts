/**
 * Canadian postal codes, normalized and classified.
 *
 * Two shapes exist here and nothing else: an FSA (`M5V`, the first three
 * characters) and a full code (`M5V3L9`). Ranges are deliberately unsupported —
 * Canadian codes are not ordinal, so `M5V-M5X` describes nothing a dispatcher
 * could point at on a map, and offering it would invite an operator to type a
 * span that silently covers the wrong streets.
 *
 * The letter classes come from Canada Post: D, F, I, O, Q and U never appear,
 * and W and Z never start a code.
 */

/** Three characters: a forward sortation area, e.g. `M5V`. */
const FSA_RE = /^[ABCEGHJ-NPRSTVXY][0-9][ABCEGHJ-NPRSTV-Z]$/;

/** All six, e.g. `M5V3L9`. */
const FULL_RE = /^[ABCEGHJ-NPRSTVXY][0-9][ABCEGHJ-NPRSTV-Z][0-9][ABCEGHJ-NPRSTV-Z][0-9]$/;

export type PostalCodeType = 'FSA' | 'FULL';

/**
 * Upper case, no whitespace of any kind. `" m5v 3l9 "` becomes `M5V3L9`, so the
 * same place typed three different ways is one stored value.
 */
export function normalizePostalCode(raw: string): string {
  return raw.toUpperCase().replace(/\s+/g, '');
}

/** The shape of an already-normalized code, or null if it is neither. */
export function classifyPostalCode(code: string): PostalCodeType | null {
  if (FSA_RE.test(code)) return 'FSA';
  if (FULL_RE.test(code)) return 'FULL';
  return null;
}

/** The FSA a full code sits inside. Returns the code itself when it is an FSA. */
export function fsaOf(code: string): string {
  return code.slice(0, 3);
}

export interface ParsedCode {
  code: string;
  type: PostalCodeType;
}

export interface ParsedList {
  /** Valid, de-duplicated, in the order first seen. */
  valid: ParsedCode[];
  /** Tokens that were not a postal code at all, as the operator typed them. */
  invalid: string[];
  /** Normalized codes that appeared more than once in the same paste. */
  duplicates: string[];
}

/**
 * Split a typed list into codes.
 *
 * Splitting is on commas, semicolons and line breaks ONLY — never on spaces,
 * because `M5V 3L9` is one code with a space in the middle of it and splitting
 * there would turn every full code an operator pastes from a label into two
 * pieces of rubbish.
 */
export function parsePostalList(raw: string): ParsedList {
  const valid: ParsedCode[] = [];
  const invalid: string[] = [];
  const duplicates: string[] = [];
  const seen = new Set<string>();

  for (const token of raw.split(/[,;\r\n]+/)) {
    const trimmed = token.trim();
    if (!trimmed) continue;

    const code = normalizePostalCode(trimmed);
    const type = classifyPostalCode(code);
    if (!type) {
      invalid.push(trimmed);
      continue;
    }
    if (seen.has(code)) {
      if (!duplicates.includes(code)) duplicates.push(code);
      continue;
    }
    seen.add(code);
    valid.push({ code, type });
  }

  return { valid, invalid, duplicates };
}
