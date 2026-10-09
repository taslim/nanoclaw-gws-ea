/**
 * Private-value matching (KTD7): exact and explainable.
 *
 * A text and a value are read the same way, so a value matches however it is
 * formatted:
 *
 *   - percent-encoding is decoded, twice-encoded text included, so a value in
 *     a link's address is read as its reader's browser reads it;
 *   - Unicode is folded by compatibility (NFKC's mapping, so full-width and
 *     mathematical letters read as plain ones), diacritics are stripped,
 *     zero-width and other invisible characters are removed, and Latin
 *     letters that do not decompose (ø, ł, ß, æ) read as their plain
 *     spellings;
 *   - every script's decimal digits read as 0-9;
 *   - case and punctuation are ignored, and the text is read as its words:
 *     runs of letters or of digits;
 *   - common street-suffix and direction words are equated (Street and St,
 *     North and N), and unit words (Apt, Suite) are dropped.
 *
 * An address, an email address, or another value matches where its words
 * appear whole and in order, so "Theo" is found in "Theo's recital" but not
 * in "the other day", and "12 Elm Rd" not in "112 Elm Rd". A phone number
 * matches on its trailing seven digits within one phone-like run of digits
 * and phone punctuation, so a country code, trunk prefix, or grouping changes
 * nothing, and the digits of a date, a time, or a price never complete it.
 *
 * A value spelled out in words, written in another script's lookalike
 * letters, or deliberately encoded some other way is a known residual: only
 * an agent holding the value can encode it, and the one that does (main) has
 * other ways to the web; external-email never holds one.
 */
import { EMAIL_PATTERN } from '../../gws-ea/validation.js';

export const PRIVATE_VALUE_KINDS = ['address', 'phone', 'email', 'other'] as const;
export type PrivateValueKind = (typeof PRIVATE_VALUE_KINDS)[number];

/** Raw value length the store accepts. */
const MAX_VALUE_LENGTH = 200;
/** Shorter canonical text is too common to check reliably. */
const MIN_PATTERN_LENGTH = 4;
/** The longest canonical text a value may reduce to. */
const MAX_PATTERN_LENGTH = 256;
/** An address's first line is matched on its own only when it says this much. */
const MIN_STREET_LINE_LENGTH = 6;
const PHONE_MIN_DIGITS = 7;
const PHONE_MAX_DIGITS = 15;
/** A phone number matches on its trailing digits: the subscriber number survives every national and international form. */
const PHONE_MATCH_DIGITS = 7;
const MAX_DECODE_ROUNDS = 3;

/** A text reduced for matching. */
export interface TextStream {
  /** Its canonical words, in order, each followed by a space. */
  readonly words: string;
  /** The digits of each phone-like run in it. */
  readonly phoneRuns: readonly string[];
}

/** What a stored value matches. */
export interface CompiledPrivateValue {
  readonly kind: PrivateValueKind;
  /** Canonical word sequences, in the form of `TextStream.words`; any one found whole in a text matches. */
  readonly words: readonly string[];
  /** For a phone number, the trailing digits found within one phone-like run. */
  readonly digits: string | null;
}

// ---------------------------------------------------------------------------
// Character folding
// ---------------------------------------------------------------------------

const IGNORABLE = /[\p{Default_Ignorable_Code_Point}\p{Cf}]/gu;
const MARK = /\p{M}/gu;
const PERCENT_RUN = /(?:%[0-9a-f]{2})+/giu;
const DECIMAL_DIGIT = /\p{Nd}/u;
const NON_ASCII_DIGIT = /(?![0-9])\p{Nd}/gu;
const NON_DIGIT = /[^0-9]/gu;
const NOT_WORD = /[^\p{L}\p{N}]+/u;
/** Where a run of letters meets a run of digits: "12Elm" reads as "12 Elm", as "5B" as "5 B". */
const LETTER_DIGIT_BOUNDARY = /(?<=\p{N})(?=\p{L})|(?<=\p{L})(?=\p{N})/u;
const ADDRESS_PART_SEPARATOR = /[,;]/u;
/**
 * A run of digits joined only by phone punctuation (dashes, dots, slashes,
 * brackets, a plus) or by spaces before more digits: one written number,
 * however it is grouped. A line break, a letter, or a colon ends it.
 */
const PHONE_RUN = /[+(]*\d(?:[\d()./\u2010-\u2015-]|[ \t]+(?=[+(]*\d))*/gu;

/** Latin letters with no decomposition, as people also write them: Søndergade, Łódź, Straße. */
const LATIN_VARIANTS: ReadonlyMap<string, string> = new Map([
  ['ø', 'o'],
  ['đ', 'd'],
  ['ł', 'l'],
  ['ħ', 'h'],
  ['ı', 'i'],
  ['ŧ', 't'],
  ['ß', 'ss'],
  ['æ', 'ae'],
  ['œ', 'oe'],
]);

function plainLatin(text: string): string {
  let plain = '';
  for (const character of text) plain += LATIN_VARIANTS.get(character) ?? character;
  return plain;
}

const utf8 = new TextDecoder('utf-8');

function decodePercentRun(run: string): string {
  const bytes = new Uint8Array(run.length / 3);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(run.slice(index * 3 + 1, index * 3 + 3), 16);
  }
  // Not UTF-8: the invalid bytes become U+FFFD, which reduces to nothing.
  return utf8.decode(bytes);
}

function decodePercentEncoding(text: string): string {
  let current = text;
  for (let round = 0; round < MAX_DECODE_ROUNDS; round++) {
    const next = current.replace(PERCENT_RUN, decodePercentRun);
    if (next === current) break;
    current = next;
  }
  return current;
}

const asciiDigits = new Map<string, string>();

/** Unicode encodes each script's decimal digits as one run from 0 to 9, so a digit's value is its place in the run. */
function asciiDigit(character: string): string {
  const known = asciiDigits.get(character);
  if (known !== undefined) return known;
  let codePoint = character.codePointAt(0) ?? 0;
  let place = 0;
  while (codePoint > 0 && DECIMAL_DIGIT.test(String.fromCodePoint(codePoint - 1))) {
    codePoint -= 1;
    place += 1;
  }
  const digit = String(place % 10);
  asciiDigits.set(character, digit);
  return digit;
}

/** Compatibility-decomposed, with every invisible character removed. */
function visible(text: string): string {
  return text.normalize('NFKD').replace(IGNORABLE, '');
}

function foldText(text: string): string {
  const decoded = visible(decodePercentEncoding(visible(text)));
  return plainLatin(decoded.toLowerCase().normalize('NFKD').replace(MARK, '')).replace(NON_ASCII_DIGIT, asciiDigit);
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/** Each group's first spelling is the one the others become. */
const STREET_WORD_GROUPS: readonly (readonly string[])[] = [
  ['st', 'street', 'str'],
  ['ave', 'avenue', 'av', 'aven'],
  ['rd', 'road'],
  ['blvd', 'boulevard', 'boul'],
  ['dr', 'drive', 'drv'],
  ['ln', 'lane'],
  ['ct', 'court'],
  ['pl', 'place'],
  ['ter', 'terrace', 'terr'],
  ['cir', 'circle'],
  ['hwy', 'highway'],
  ['pkwy', 'parkway'],
  ['sq', 'square'],
  ['cres', 'crescent'],
  ['trl', 'trail'],
  ['plz', 'plaza'],
  ['aly', 'alley'],
  ['ctr', 'center', 'centre'],
  ['n', 'north'],
  ['s', 'south'],
  ['e', 'east'],
  ['w', 'west'],
  ['ne', 'northeast'],
  ['nw', 'northwest'],
  ['se', 'southeast'],
  ['sw', 'southwest'],
];

const STREET_WORDS: ReadonlyMap<string, string> = new Map(
  STREET_WORD_GROUPS.flatMap((group) => group.map((word): [string, string] => [word, group[0]])),
);

/** Unit words: "Apt 5", "Suite 5", and "#5" all read as "5". */
const DROPPED_WORDS: ReadonlySet<string> = new Set(['apartment', 'apt', 'suite', 'ste', 'unit']);

function canonicalWord(word: string): string {
  return DROPPED_WORDS.has(word) ? '' : (STREET_WORDS.get(word) ?? word);
}

/** `text`'s canonical words, in order. */
function canonicalWords(folded: string): string[] {
  return folded
    .split(NOT_WORD)
    .flatMap((word) => word.split(LETTER_DIGIT_BOUNDARY))
    .map(canonicalWord)
    .filter((word) => word !== '');
}

/** `text` reduced to its canonical letters and digits, run together. */
export function canonicalText(text: string): string {
  return canonicalWords(foldText(text)).join('');
}

/** Words in the form `TextStream.words` holds them: each followed by a space, so a match never starts or ends inside one. */
function wordStream(words: readonly string[]): string {
  return words.map((word) => `${word} `).join('');
}

/**
 * The parts of one send (or of one set of fields), read in order as one
 * text: a value split across fields is found, while a phone-like run never
 * continues from one part into the next.
 */
export function streamOf(parts: readonly string[]): TextStream {
  const folded = parts.map(foldText);
  return {
    words: wordStream(folded.flatMap(canonicalWords)),
    phoneRuns: folded.flatMap((part) => [...part.matchAll(PHONE_RUN)].map((run) => run[0].replace(NON_DIGIT, ''))),
  };
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/** Why `value` cannot be checked reliably as a `kind`, or undefined when it can. */
export function uncheckableReason(kind: PrivateValueKind, value: string): string | undefined {
  if (value.length > MAX_VALUE_LENGTH) {
    return `A private value is too long: keep it to ${MAX_VALUE_LENGTH} characters`;
  }
  const canonical = canonicalText(value);
  if (canonical.length > MAX_PATTERN_LENGTH) return 'A private value is too long to check';
  if (kind === 'phone') {
    const count = canonical.replace(NON_DIGIT, '').length;
    return count >= PHONE_MIN_DIGITS && count <= PHONE_MAX_DIGITS
      ? undefined
      : `A phone value needs ${PHONE_MIN_DIGITS} to ${PHONE_MAX_DIGITS} digits`;
  }
  if (kind === 'email' && !EMAIL_PATTERN.test(value.trim())) return 'An email value must be one email address';
  return canonical.length >= MIN_PATTERN_LENGTH
    ? undefined
    : `A private value needs at least ${MIN_PATTERN_LENGTH} letters or digits to be checked reliably`;
}

/** What a stored value matches. Never throws: a stored value is matched however it reads. */
export function compilePrivateValue(kind: PrivateValueKind, value: string): CompiledPrivateValue {
  const words = canonicalWords(foldText(value));
  switch (kind) {
    case 'phone':
      return { kind, words: [], digits: words.join('').replace(NON_DIGIT, '').slice(-PHONE_MATCH_DIGITS) };
    case 'address': {
      // The street line alone gives the address away, so it matches without the town.
      const [firstPart = ''] = value.normalize('NFKD').split(ADDRESS_PART_SEPARATOR);
      const streetLine = canonicalWords(foldText(firstPart));
      const alone = streetLine.join('').length >= MIN_STREET_LINE_LENGTH && streetLine.length < words.length;
      return { kind, words: alone ? [wordStream(words), wordStream(streetLine)] : [wordStream(words)], digits: null };
    }
    case 'email':
    case 'other':
      return { kind, words: [wordStream(words)], digits: null };
    default: {
      const unreachable: never = kind;
      throw new Error(`Unknown private value kind: ${String(unreachable)}`);
    }
  }
}

/** The first value `text` gives away. */
export function findPrivateValue(
  values: readonly CompiledPrivateValue[],
  text: TextStream,
): CompiledPrivateValue | undefined {
  const words = ` ${text.words}`;
  return values.find(({ words: patterns, digits }) => {
    if (patterns.some((pattern) => pattern !== '' && words.includes(` ${pattern}`))) return true;
    return digits !== null && digits !== '' && text.phoneRuns.some((run) => run.includes(digits));
  });
}
