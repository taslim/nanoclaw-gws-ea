/** What the host fills into a sign-in field: a saved login's username or password, or an emailed code. */
export type BrowserSecretField = 'username' | 'password' | 'code';

export function httpsOrigin(raw: string): URL | undefined {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password ? url : undefined;
  } catch (_error) {
    return undefined;
  }
}

/** Playwright protocol logging can contain cookies, field reads and native keyboard payloads. */
export function browserDiagnosticsUnsafe(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (environment.PWDEBUG && environment.PWDEBUG !== '0') return true;
  return (environment.DEBUG ?? '').split(/[\s,]+/u).some((pattern) => {
    if (!pattern || pattern.startsWith('-')) return false;
    const wildcard = pattern.indexOf('*');
    if (wildcard === -1) return pattern === 'pw' || pattern.startsWith('pw:');
    const prefix = pattern.slice(0, wildcard);
    return 'pw:'.startsWith(prefix) || prefix.startsWith('pw:');
  });
}

/** Marks a field only the host fills: a site's own credential field, whatever its type shows now. */
export const CREDENTIAL_AUTOCOMPLETE = /(?:^|\s)(?:new|current)-password(?:\s|$)/iu;
/** The longest one-time code: a field limited to this many characters holds no password worth choosing. */
export const CODE_MAX_LENGTH = 10;
/** A one-time code: up to ten letters and digits, no spaces. */
export const CODE_SHAPED = new RegExp(`^[a-z\\d]{0,${CODE_MAX_LENGTH}}$`, 'iu');
/** A code of digits alone, which no model-chosen password is. */
export const DIGIT_CODE = new RegExp(`^\\d{4,${CODE_MAX_LENGTH}}$`, 'u');
/** A site's own marking of a one-time code field. */
export const ONE_TIME_CODE_AUTOCOMPLETE = /(?:^|\s)one-time-code(?:\s|$)/iu;
/** The numeric keypad a code or PIN field asks for. */
export const NUMERIC_INPUT_MODE = /^numeric$/iu;

/** What the host reads of a field before the agent enters anything into it. */
interface EntryFieldFacts {
  /** A field for payment details. */
  readonly card: boolean;
  /** Marked `new-password` or `current-password`. */
  readonly credential: boolean;
  /** A masked input: `type=password` when read. */
  readonly masked: boolean;
  /** Marked `one-time-code`. */
  readonly oneTimeCode: boolean;
  /** Its `inputmode`, as the element reflects it. */
  readonly inputMode: string;
  /** Its `maxlength`; negative where it sets none. */
  readonly maxLength: number;
}

/** A field that reads as a code's: marked one-time-code, asking for a numeric keypad, or too short for a password. */
function codeField(field: EntryFieldFacts): boolean {
  return (
    field.oneTimeCode ||
    NUMERIC_INPUT_MODE.test(field.inputMode) ||
    (field.maxLength > 0 && field.maxLength <= CODE_MAX_LENGTH)
  );
}

/**
 * Whether the agent may enter `value` into a field; `undefined` for a key, which types no text. A code reaches any
 * unmasked field. A masked field takes digits alone, or a letter code where the field reads as a code's: a short
 * mixed value like a model-chosen password would otherwise create an account outside the host's credential fills,
 * which save the password first. Card and credential fields take nothing.
 */
export function entryRefusal(field: EntryFieldFacts, value?: string): 'card_field' | 'secret_field' | undefined {
  if (field.card) return 'card_field';
  if (field.credential) return 'secret_field';
  if (field.masked && value !== undefined && !maskedCode(field, value)) return 'secret_field';
  return undefined;
}

function maskedCode(field: EntryFieldFacts, value: string): boolean {
  return DIGIT_CODE.test(value) || (codeField(field) && CODE_SHAPED.test(value));
}

export type CredentialFormField = 'username' | 'current_password' | 'new_password' | 'confirmation';
export type CredentialKind = 'signup' | 'rotation';
/** An input's type and autocomplete tokens, as the host reads them at binding and again at each write. */
interface FieldTypeFacts {
  readonly type: string;
  readonly autocomplete: string;
}

const tokens = (facts: FieldTypeFacts): string[] => facts.autocomplete.toLowerCase().split(/\s+/u);
const cardMarked = (facts: FieldTypeFacts): boolean => tokens(facts).some((token) => token.startsWith('cc-'));
/** Text-entry inputs that can show an account name. */
export const ACCOUNT_INPUT_TYPES: readonly string[] = ['email', 'text', 'tel'];

/**
 * Whether a field's type fits a role: an account name goes into an editable text, email or tel input, and every
 * password only into a masked one, so a saved or generated password never shows as plain text. The current and the
 * new password are never crossed where the site marks which is which: the old password in a new field would leave
 * the website and the saved login disagreeing.
 */
export function credentialFieldFits(role: CredentialFormField, facts: FieldTypeFacts, kind: CredentialKind): boolean {
  if (cardMarked(facts)) return false;
  const marks = tokens(facts);
  if (role === 'username')
    return ACCOUNT_INPUT_TYPES.includes(facts.type) && !CREDENTIAL_AUTOCOMPLETE.test(facts.autocomplete);
  if (facts.type !== 'password') return false;
  if (role === 'current_password') return kind === 'rotation' && !marks.includes('new-password');
  return !marks.includes('current-password');
}

/** Input types no code can be typed into: those that take no text, and pickers whose text is a date or time. */
const NON_CODE_INPUT_TYPES =
  /^(?:hidden|submit|button|reset|image|checkbox|radio|file|range|color|date|datetime-local|month|week|time)$/u;

/** A field the host may enter an emailed code into: any text field, a masked one included, but no card or credential field. */
export function codeFieldFits(facts: FieldTypeFacts): boolean {
  return (
    !NON_CODE_INPUT_TYPES.test(facts.type) && !cardMarked(facts) && !CREDENTIAL_AUTOCOMPLETE.test(facts.autocomplete)
  );
}
