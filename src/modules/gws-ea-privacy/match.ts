/**
 * Private-value matching (KTD7).
 *
 * Every text is reduced to one canonical stream before it is compared, so a
 * private value matches however it is written:
 *
 *   - percent-encoding is decoded, twice-encoded text included;
 *   - Unicode is folded by compatibility (NFKC's mapping, so full-width and
 *     mathematical letters read as plain ones), diacritics are stripped, and
 *     zero-width and other invisible characters are removed;
 *   - lookalike letters from other scripts are folded to the Latin letter
 *     they pass for, and every script's decimal digits to 0-9;
 *   - case, whitespace, and punctuation are ignored: only letters and digits
 *     remain, run together;
 *   - common street-suffix and direction words are equated (Street and St,
 *     North and N), and unit words (Apt, Suite) are dropped;
 *   - a phone number is compared as a digit stream, on its trailing seven
 *     digits, so a country code, trunk prefix, or grouping changes nothing.
 *
 * Matching is a substring test on the canonical stream: a match ignores word
 * boundaries, which errs toward refusing. A value spelled out in words or
 * deliberately encoded some other way remains a known residual.
 */
import { EMAIL_PATTERN } from '../../gws-ea/validation.js';

export const PRIVATE_VALUE_KINDS = ['address', 'phone', 'email', 'other'] as const;
export type PrivateValueKind = (typeof PRIVATE_VALUE_KINDS)[number];

/** Raw value length the store accepts. */
const MAX_VALUE_LENGTH = 200;
/** Shorter canonical text would match inside ordinary words. */
const MIN_PATTERN_LENGTH = 4;
/** The longest canonical text a value may reduce to; bounds the thread history. */
const MAX_PATTERN_LENGTH = 256;
/** An address's first line is matched on its own only when it says this much. */
const MIN_STREET_LINE_LENGTH = 6;
const PHONE_MIN_DIGITS = 7;
const PHONE_MAX_DIGITS = 15;
/** A phone number matches on its trailing digits: the subscriber number survives every national and international form. */
const PHONE_MATCH_DIGITS = 7;
const MAX_DECODE_ROUNDS = 3;

/** Earlier text a send is checked with: enough to complete the longest value. */
export const HISTORY_TEXT_LENGTH = MAX_PATTERN_LENGTH - 1;
/** Earlier digits a send is checked with: enough to complete a phone number. */
export const HISTORY_DIGIT_LENGTH = PHONE_MATCH_DIGITS - 1;

/** A send, or a run of sends, reduced for matching. */
export interface TextStream {
  /** Canonical letters and digits. */
  readonly text: string;
  /** The digits of `text`, in order. */
  readonly digits: string;
}

/** What a stored value matches. */
export interface CompiledPrivateValue {
  readonly kind: PrivateValueKind;
  /** Canonical texts; any one of them found in a send matches. */
  readonly texts: readonly string[];
  /** For a phone number, the trailing digits found in any format. */
  readonly digits: string | null;
}

const EMPTY_STREAM: TextStream = { text: '', digits: '' };

// ---------------------------------------------------------------------------
// Character folding
// ---------------------------------------------------------------------------

const IGNORABLE = /[\p{Default_Ignorable_Code_Point}\p{Cf}]/gu;
const MARK = /\p{M}/gu;
const PERCENT_RUN = /(?:%[0-9a-f]{2})+/giu;
const DECIMAL_DIGIT = /\p{Nd}/u;
const NON_ASCII_DIGIT = /(?![0-9])\p{Nd}/gu;
const NON_DIGIT = /[^0-9]/gu;
const TOKEN_SEPARATOR = /[^\p{L}\p{N}]+/u;
const ADDRESS_PART_SEPARATOR = /[,;]/u;

/** Pair each character of `from` with the character of `to` at the same position. */
function pairs(from: string, to: string): [string, string][] {
  const sources = [...from];
  const targets = [...to];
  if (sources.length !== targets.length) throw new Error('Lookalike table is misaligned');
  return sources.map((source, index) => [source, targets[index]]);
}

/**
 * Letters that pass for Latin ones, each with the text it reads as. Letters
 * with a canonical decomposition (accented forms) need no entry: their marks
 * are stripped first.
 */
const LOOKALIKES: ReadonlyMap<string, string> = new Map([
  // Cyrillic: А а В в Е е К к М м Н н О о Р р С с Т т У у Х х Ѕ ѕ І і Ј ј
  // Ԁ ԁ Ԍ ԍ Ԛ ԛ Ԝ ԝ Ӏ ӏ Һ һ Ү ү Ѵ ѵ Ь ь г п
  ...pairs(
    'АаВвЕеКкМмНнОоРр' + 'СсТтУуХхЅѕІіЈј' + 'ԀԁԌԍԚԛԜԝӀӏҺһҮүѴѵ' + 'Ььгп',
    'AaBbEeKkMmHhOoPpCcTtYyXxSsIiJjDdGgQqWwIlHhYyVvbbrn',
  ),
  // Greek: Α α Β β Ε ε Ζ Η η Ι ι Κ κ Μ Ν ν Ο ο Ρ ρ Τ τ Υ υ Χ χ γ ϳ
  ...pairs('ΑαΒβΕεΖΗηΙιΚκΜΝν' + 'ΟοΡρΤτΥυΧχγϳ', 'AaBbEeZHnIiKkMNvOoPpTtYuXxyj'),
  // Latin letters with a stroke or other shape that does not decompose:
  // ø Ø đ Đ ł Ł ħ Ħ ı ŧ Ŧ ɑ ɡ ɩ
  ...pairs('øØđĐłŁħĦıŧŦɑɡɩ', 'oOdDlLhHitTagi'),
  // ß ẞ æ Æ œ Œ
  ['ß', 'ss'],
  ['ẞ', 'ss'],
  ['æ', 'ae'],
  ['Æ', 'ae'],
  ['œ', 'oe'],
  ['Œ', 'oe'],
]);

function foldLookalikes(text: string): string {
  let folded = '';
  for (const character of text) folded += LOOKALIKES.get(character) ?? character;
  return folded;
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
  const folded = foldLookalikes(foldLookalikes(decoded).toLowerCase().normalize('NFKD').replace(MARK, ''));
  return folded.replace(NON_ASCII_DIGIT, asciiDigit);
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

/** `text` reduced to its canonical letters and digits. */
export function canonicalText(text: string): string {
  return foldText(text).split(TOKEN_SEPARATOR).map(canonicalWord).join('');
}

function digitsOf(canonical: string): string {
  return canonical.replace(NON_DIGIT, '');
}

/** The parts of one send (or of one set of fields), read in order as a single stream. */
export function streamOf(parts: readonly string[]): TextStream {
  const text = parts.map(canonicalText).join('');
  return { text, digits: digitsOf(text) };
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
    const count = digitsOf(canonical).length;
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
  const canonical = canonicalText(value);
  switch (kind) {
    case 'phone':
      return { kind, texts: [], digits: digitsOf(canonical).slice(-PHONE_MATCH_DIGITS) };
    case 'address': {
      // The street line alone gives the address away, so it matches without the town.
      const [firstPart = ''] = value.normalize('NFKD').split(ADDRESS_PART_SEPARATOR);
      const streetLine = canonicalText(firstPart);
      const texts =
        streetLine.length >= MIN_STREET_LINE_LENGTH && streetLine !== canonical ? [canonical, streetLine] : [canonical];
      return { kind, texts, digits: null };
    }
    case 'email':
    case 'other':
      return { kind, texts: [canonical], digits: null };
    default: {
      const unreachable: never = kind;
      throw new Error(`Unknown private value kind: ${String(unreachable)}`);
    }
  }
}

/** True when `pattern` occurs in `earlier` followed by `current`, and reaches into `current`. */
function occursIn(pattern: string, earlier: string, current: string): boolean {
  if (pattern === '') return false;
  const carried = earlier.slice(Math.max(0, earlier.length - (pattern.length - 1)));
  return (carried + current).includes(pattern);
}

/**
 * The first value `current` gives away, read after `history` (the thread's
 * earlier outbound text), so a value split across sends is found. A value
 * wholly inside `history` is not `current`'s doing and does not match.
 */
export function findPrivateValue(
  values: readonly CompiledPrivateValue[],
  current: TextStream,
  history: TextStream = EMPTY_STREAM,
): CompiledPrivateValue | undefined {
  return values.find(
    (value) =>
      value.texts.some((pattern) => occursIn(pattern, history.text, current.text)) ||
      (value.digits !== null && occursIn(value.digits, history.digits, current.digits)),
  );
}
