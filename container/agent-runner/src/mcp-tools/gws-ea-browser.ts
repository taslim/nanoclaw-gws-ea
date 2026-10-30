/** The sealed browser agent's host requests. */
import { requestTool } from '../action-request.js';
import { registerTools } from './server.js';

export const BROWSER_REQUEST_TIMEOUT_MS = 120_000;

const REF_FIELDS = {
  ref: { type: 'string', pattern: '^(?:f\\d+)?e\\d+$', description: 'The element ref from the latest observation.' },
  generation: { type: 'integer', minimum: 1, description: 'The generation of that observation.' },
} as const;
const REF = {
  type: 'object',
  properties: REF_FIELDS,
  required: ['ref', 'generation'],
  additionalProperties: false,
} as const;
const PARAMETERS = {
  type: 'object',
  additionalProperties: { type: 'string' },
  description: 'Values for the recipe’s named inputs; these are ordinary text, never secrets.',
} as const;
const DATE_TIME = {
  type: 'string',
  format: 'date-time',
  description: 'An ISO date and time with a UTC offset.',
} as const;
/** An ISO date, or a date and time with a UTC offset: the shapes the host reads. */
const DATE_OR_DATE_TIME = '^\\d{4}-\\d{2}-\\d{2}(?:T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2}))?$';
const WINDOW = {
  type: 'object',
  properties: { start: DATE_TIME, end: DATE_TIME },
  required: ['start', 'end'],
  additionalProperties: false,
} as const;
const NO_REPEAT =
  'After a timeout, check request_status before doing anything else; do not repeat this call because the first may still act.';

function action(kind: string, properties: Record<string, object> = {}, required: readonly string[] = []) {
  return {
    type: 'object',
    properties: { kind: { const: kind }, ...properties },
    required: ['kind', ...required],
    additionalProperties: false,
  };
}

export const browser = requestTool({
  name: 'browser',
  description:
    'Run an ordered batch in this errand’s host browser, on any public site. It stops at the first failure or navigation and returns the resulting page observation, with generation-stamped refs. Screenshots arrive as images, linked by each action’s image_index. JavaScript, field-value reads, clipboard access, cookies and storage export are unavailable. Ordinary text input refuses passwords, codes and payment fields; use fill_secret or sign_in_code for sign-in, and credential_form for an authorized signup or password change. ' +
    'The host refuses only commit-class actions: a purchase, booking or order, which goes through purchase; an account-security change; and speaking as the principal. Before each observation it rejects a cookie banner that offers a reject option, and the observation’s cookie_banner says what it did. ' +
    'Outcomes: completed, or stopped with a reason. navigated: the action reached another document; inspect its observation before continuing. challenge and sign_in_wall describe the resulting document even after navigation. navigation_failed: transport failed, with no inferred HTTP status; report the limitation and request id to main. A handler-error is an unexpected host runtime failure; report it with its safe diagnostics and request id, without blindly retrying. stale_ref or not_actionable: observe again; not_actionable also means something covered the control. purchase_control: call purchase with that control. speaks_as_principal: reviews, comments, ratings, tips, contact forms, chats and messages to people stay refused; a note that belongs to a booking or order, such as an allergy, goes in that form’s own field and rides along with it. account_security: changes to an account’s email, phone, password, two-factor, payment methods or existence are refused; report the need to main. consent_control: the host makes every consent, marketing and agreement choice before a form is submitted, so leave those boxes to it. consent_required: the form needs wording only the principal can agree to; call request_consent with the stop_id it returned. secret_field: use fill_secret, sign_in_code or credential_form. card_field: card details are never entered; report to main that the checkout needs a card. personal_data: nothing ran; the batch would have given private details without main’s disclosure, or a principal email only the host may fill from a saved login. Report the site and detail to main; never retype it elsewhere. alias_unavailable: the assistant’s web address is not set up; tell main the operator must finish setup. unapproved_commit: an ordinary press landed on a confirmation showing a charge nobody approved; the host stopped this errand and told main, so report only what the page showed. site_busy: another errand is using this site; the host wakes you when it is free. sign_in_wall: sign in with fill_secret or sign_in_code. timeout, window_closed or interrupted: observe before acting again. challenge, blocked_address or browser_unavailable: report what you could not get past to main. ' +
    NO_REPEAT,
  properties: {
    actions: {
      type: 'array',
      minItems: 1,
      description: 'Actions run in order in this one request; later actions are not executed after a stop.',
      items: {
        oneOf: [
          action(
            'navigate',
            { url: { type: 'string', format: 'uri', description: 'The public HTTP or HTTPS URL to open.' } },
            ['url'],
          ),
          action('observe'),
          action('screenshot'),
          action('click', REF_FIELDS, ['ref', 'generation']),
          action(
            'type',
            { ...REF_FIELDS, text: { type: 'string', description: 'Ordinary text to put in this field.' } },
            ['ref', 'generation', 'text'],
          ),
          action('select', { ...REF_FIELDS, value: { type: 'string', description: 'The option value to choose.' } }, [
            'ref',
            'generation',
            'value',
          ]),
          action(
            'key',
            {
              ...REF_FIELDS,
              key: {
                type: 'string',
                pattern:
                  '^(?:(?:Shift\\+)?(?:Enter|Space|Tab|Escape|Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown)|(?:Control|Meta)\\+[aA])$',
                description: 'One allowed navigation or editing key; copy, cut and paste shortcuts are refused.',
              },
            },
            ['ref', 'generation', 'key'],
          ),
          action(
            'scroll',
            {
              direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
              amount: { type: 'number', exclusiveMinimum: 0, description: 'Distance in pixels; 600 when omitted.' },
            },
            ['direction'],
          ),
          action('wait_for', {
            text: { type: 'string', description: 'Visible text to wait for; without it, wait for document load.' },
            timeout_ms: { type: 'integer', minimum: 1, description: 'Maximum wait within the remaining host budget.' },
          }),
          action(
            'form_input',
            {
              fields: {
                type: 'array',
                minItems: 1,
                items: {
                  type: 'object',
                  properties: { ...REF_FIELDS, value: { type: 'string' } },
                  required: ['ref', 'generation', 'value'],
                  additionalProperties: false,
                },
              },
              submit: REF,
            },
            ['fields'],
          ),
          action(
            'upload',
            {
              ...REF_FIELDS,
              path: {
                type: 'string',
                description: 'A regular file in this errand’s own session inbox; the host stages its own copy.',
              },
            },
            ['ref', 'generation', 'path'],
          ),
          action('download', REF_FIELDS, ['ref', 'generation']),
        ],
      },
    },
    budget_ms: {
      type: 'integer',
      minimum: 1,
      maximum: 100_000,
      default: 90_000,
      description: 'Host budget from acceptance, including queue wait; shorter than this tool’s 120-second timeout.',
    },
  },
  required: ['actions'],
  additionalProperties: false,
  repeatable: false,
  timeoutMs: BROWSER_REQUEST_TIMEOUT_MS,
});

export const fillSecret = requestTool({
  name: 'fill_secret',
  description:
    'Ask the host to fill a 1Password login by handle and submit it. The host validates the complete HTTPS frame origin before resolving and again before insertion; no secret value reaches you. Outcomes: submitted or cleared_after_submit: observe again. no_item_for_site: no saved login exists; tell main so the principal can add it to the assistant’s 1Password vault if their account is needed. origin_mismatch: the origin does not match the login. vault_unavailable: 1Password cannot be used now; rate_limited: its daily request limit was reached. Report these limits to main; never ask for a password. ' +
    NO_REPEAT,
  properties: {
    item_handle: { type: 'string', description: 'The opaque login handle the host listed for this site.' },
    field: {
      type: 'string',
      enum: ['username', 'password', 'otp'],
      description: 'Which login field the host should resolve.',
    },
    target: REF,
    submit: REF,
  },
  required: ['item_handle', 'field', 'target', 'submit'],
  additionalProperties: false,
  repeatable: false,
  timeoutMs: BROWSER_REQUEST_TIMEOUT_MS,
});

const ACCOUNT_FIELDS = ['username', 'current_password', 'new_password', 'confirmation'] as const;
const has = (fields: Record<string, unknown>, ...names: readonly string[]): boolean =>
  names.some((name) => fields[name] !== undefined);

export const credentialForm = requestTool({
  name: 'credential_form',
  description:
    'Fill and submit a signup or password-change form with a password the host generates and saves in 1Password first, under the credential authority main recorded for this job. Give fresh refs for the fields the form has (a signup’s username, new_password and confirmation; a change’s current_password, new_password and confirmation) and the control that submits them. A multi-step signup sends username alone first, then the password step. The host makes the form’s checkbox choices itself: it accepts the site’s own terms and opts out of marketing, and stops with consent_required and a stop_id for request_consent when the form needs any other agreement. The host refuses before revealing anything when the frame, origin, form or control is unexpected, financial or another security change; no value reaches you. ' +
    'Outcomes: continued: observe the next signup step. account_created or password_changed: the site confirmed it, with vault saved or updated (the login holds the new password), left_as_edited (the login was changed or removed in 1Password and left as it is; after a password change, the new password is in its own item, \"New password for\" the site) or pending (the site confirmed it but 1Password has not finished saving: reconcile). account_exists: the site already has an account for that username. password_rejected: the site rejected the new password. current_password_rejected: it rejected the saved current password. not_owned: this is not the assistant’s account, so its password cannot be changed. vault_unavailable: 1Password cannot be used right now. rate_limited: its daily request limit was reached. The authority covers one disclosure. For refused with consent_required before disclosure, call request_consent and retry from a fresh observation after approval. For outcome_unknown with reason consent_required after disclosure, the site may already have submitted: reconcile before trying anything else. A grant never permits refilling an exposed attempt. ' +
    'verification_requested: the account still needs email confirmation. Use verify: the host waits for its email and opens the link or, given code_field and activate, fills the code. nothing_arrived: no email yet, so verify later. not_watched: the host cannot watch that inbox or its wait ended. ambiguous: it could not identify one suitable email. refused with code_field_needed: name the code field and its control. outcome_unknown: the change may or may not have happened. Use reconcile next, with no intervening action except an observation: it only reads the late response or finishes a pending vault save. inconclusive: the host could not establish what happened, so the site stays reserved. Report every outcome but continued in plain words to main, with the host’s facts and what is unknown. Only the principal can release an unresolved attempt; never obtain another authority to try again. ' +
    NO_REPEAT,
  properties: {
    operation: {
      type: 'string',
      enum: ['submit', 'verify', 'reconcile'],
      default: 'submit',
      description:
        'submit fills and activates the form; verify completes the email verification a signup asked for; reconcile only reads the site’s response to an unknown outcome, or finishes saving a pending one in 1Password.',
    },
    authority: { type: 'string', description: 'The credential authority id main gave this job.' },
    username: REF,
    current_password: REF,
    new_password: REF,
    confirmation: REF,
    code_field: { ...REF, description: 'For verify: the field for the emailed verification code.' },
    activate: { ...REF, description: 'The control that submits these fields.' },
  },
  required: ['authority'],
  additionalProperties: false,
  oneOf: [
    {
      properties: { operation: { const: 'submit' } },
      required: ['activate'],
      not: { required: ['code_field'] },
      oneOf: [
        {
          required: ['username'],
          not: {
            anyOf: [{ required: ['new_password'] }, { required: ['confirmation'] }, { required: ['current_password'] }],
          },
        },
        { required: ['new_password'] },
      ],
    },
    {
      properties: { operation: { const: 'verify' } },
      required: ['operation'],
      not: { anyOf: ACCOUNT_FIELDS.map((field) => ({ required: [field] })) },
    },
    {
      properties: { operation: { const: 'reconcile' } },
      required: ['operation'],
      not: {
        anyOf: [...ACCOUNT_FIELDS, 'code_field', 'activate'].map((field) => ({ required: [field] })),
      },
    },
  ],
  prepare(fields) {
    if (fields.operation === 'reconcile')
      return has(fields, ...ACCOUNT_FIELDS, 'code_field', 'activate') ? 'reconcile takes only the authority.' : fields;
    if (fields.operation === 'verify') {
      if (has(fields, ...ACCOUNT_FIELDS)) return 'verify takes only the code field and its control.';
      return has(fields, 'code_field') === has(fields, 'activate')
        ? fields
        : 'Name the verification code field together with the control that submits it, or neither.';
    }
    if (has(fields, 'code_field')) return 'code_field is for verify.';
    if (!has(fields, 'activate')) return 'Name the control that submits these fields.';
    if (!has(fields, 'new_password', 'username'))
      return 'Name the username field, or the new password field with any confirmation and current password.';
    if (!has(fields, 'new_password') && has(fields, 'confirmation', 'current_password'))
      return 'A confirmation or current password goes with the new password field.';
    return fields;
  },
  repeatable: false,
  timeoutMs: BROWSER_REQUEST_TIMEOUT_MS,
});

export const signInCode = requestTool({
  name: 'sign_in_code',
  description:
    'Register a site-bound sign-in wait before the host presses the send control. The target is the code field, or the starting email field of a host-reviewed passwordless flow; the host binds its new code field after the transition. For assistant mail, isolated external-email interprets one qualifying code or magic link; only the host inserts or opens it. from=principal records the wait for a code relayed through main; never supply a raw code here. Outcomes: code_filled, link_opened, nothing_arrived, ambiguous, origin_mismatch, awaiting_code or alias_unavailable (no web address is set up yet). Observe again after completion; tell main the recorded site when awaiting_code, and report ambiguity, origin mismatch or alias_unavailable. ' +
    NO_REPEAT,
  properties: {
    from: {
      type: 'string',
      enum: ['assistant', 'principal'],
      default: 'assistant',
      description: 'Whose mailbox receives the sign-in message.',
    },
    target: REF,
    send: REF,
    submit: REF,
  },
  required: ['target', 'send'],
  additionalProperties: false,
  repeatable: false,
  timeoutMs: BROWSER_REQUEST_TIMEOUT_MS,
});

export const purchase = requestTool({
  name: 'purchase',
  description:
    'Ask the host to commit a purchase, booking or order on any site: target the control browser refused with purchase_control, or the commit point run_recipe reached. The host reads the checkout’s facts and terms itself; your words never verify a purchase. A note in the booking’s or order’s own field rides along and shows on the card. ' +
    'The host presses a free booking at once, with no card, and a purchase the principal already approved. Before any press it may answer: awaiting_principal: a card went to the principal; stay on the checkout and wait for the notice. card_needed: no payment method is saved; never enter card details, and report the site, account, items and total to main. facts_incomplete: no card went out because the host could not read every required checkout fact; report what it names as missing to main. terms_unavailable: the host could not read the site’s terms; report it to main. not_a_purchase: the control commits nothing, so press it with browser. stopped with consent_required: call request_consent with its stop_id, then call purchase again. waiting_on_earlier: an earlier purchase on this site is unconfirmed; browse on, and the host wakes you once main records its outcome. site_purchase_blocked: another errand holds this site; the host wakes you when it is free. Under a watch, outside_bounds, calendar_conflict or calendar_unavailable means the table does not fit it, and watch_spent that this errand’s one booking is used. ' +
    'A press ends, in the answer or a later notice, with placed or booked and the order number; not_placed: the site declined it; unconfirmed: the page proved nothing either way, so report it to main, which settles it from the merchant’s order email or the principal, and never retry it; or stopped with unapproved_commit: a free booking’s confirmation showed a charge, so the host stopped this errand and told main. A checkout that changed ends with changed: a new card went out, so wait again; checkout_lapsed: observe, rebuild the checkout and call purchase again; or checkout_changing: it changed again after three changed cards, so the host stopped this errand: report what changed. A card ends with rejected: the principal declined, so remove what you added to the cart; or expired or withdrawn: report it to main. For a paid attempt, operation=reconcile with its attempt id and a ref on the merchant’s order record reads that record: confirmed_placed or confirmed_not_placed records the result; inconclusive leaves it to main. ' +
    NO_REPEAT,
  properties: {
    operation: {
      type: 'string',
      enum: ['commit', 'reconcile'],
      default: 'commit',
      description: 'commit asks the host to commit; reconcile only reads a paid attempt’s order record.',
    },
    target: REF,
    attempt_id: { type: 'string', description: 'The unresolved attempt’s id; required only for reconcile.' },
    delivery_window: {
      ...WINDOW,
      description:
        'The principal’s explicitly allowed delivery window, when the errand specifies one. Only each bound’s calendar date counts.',
    },
    needed_by: {
      type: 'string',
      pattern: DATE_OR_DATE_TIME,
      description:
        'The principal’s latest acceptable delivery, when the errand names one: a date (YYYY-MM-DD), meaning the end of that day on the principal’s clock, or a date and time with a UTC offset.',
    },
  },
  required: ['target'],
  additionalProperties: false,
  oneOf: [
    { properties: { operation: { const: 'commit' } }, not: { required: ['attempt_id'] } },
    {
      properties: { operation: { const: 'reconcile' } },
      required: ['operation', 'attempt_id'],
      not: { anyOf: [{ required: ['delivery_window'] }, { required: ['needed_by'] }] },
    },
  ],
  repeatable: false,
  timeoutMs: BROWSER_REQUEST_TIMEOUT_MS,
});

export const requestConsent = requestTool({
  name: 'request_consent',
  description:
    'Ask the principal to agree to wording the host stopped on: give the stop_id a consent_required stop returned. The principal sees the site and the exact wording, and decides. Outcomes: awaiting_principal: the decision arrives as a note, approved, rejected, expired or withdrawn. approved at once: the principal already agreed to this wording on this site. withdrawn: the principal could not be asked. refused with unknown_stop (no such stop on this job) or stop_used (it was asked already: wait for its note). After approval, continue from a fresh observation; the host ticks the box itself. If credentials already reached the page, reconcile that attempt before trying again: approval never permits refilling it. Otherwise the box stays unticked: report it to main. ' +
    NO_REPEAT,
  properties: {
    stop_id: { type: 'string', description: 'The stop_id a consent_required stop returned for this job.' },
  },
  required: ['stop_id'],
  additionalProperties: false,
  repeatable: false,
  timeoutMs: BROWSER_REQUEST_TIMEOUT_MS,
});

export const saveRecipe = requestTool({
  name: 'save_recipe',
  description:
    'Save a range of this errand’s recorded actions as a named recipe. Bind ordinary type/select values, a single-field form_input value, or a click target’s exact accessible name. Indices are global across this job’s requests, zero-based and inclusive. The host records locators and checkpoints; no executable code is accepted. Returns saved with the recipe id, name, parameters and read_only, which is true when every step only reads pages of one site, as a watch’s recipe must; use that id with run_recipe or watch. ' +
    NO_REPEAT,
  properties: {
    name: { type: 'string', description: 'A short task name for the path.' },
    first_action: { type: 'integer', minimum: 0, description: 'First recorded action’s global job index, inclusive.' },
    last_action: { type: 'integer', minimum: 0, description: 'Last recorded action’s global job index, inclusive.' },
    parameters: {
      type: 'array',
      description: 'Named inputs and the recorded actions whose values they replace.',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, action_index: { type: 'integer', minimum: 0 } },
        required: ['name', 'action_index'],
        additionalProperties: false,
      },
    },
  },
  required: ['name', 'first_action', 'last_action', 'parameters'],
  additionalProperties: false,
  repeatable: false,
  timeoutMs: BROWSER_REQUEST_TIMEOUT_MS,
});

export const runRecipe = requestTool({
  name: 'run_recipe',
  description:
    'Replay a host-recorded recipe with named ordinary inputs, checking the page between steps and stopping before any commit. Returns completed when every step finishes without a commit, reached_commit_point with its ref before a purchase, or checkpoint_failed with the failed step, expected and found state, and current observation. Use purchase at the commit point; repair a failed checkpoint with browser and save_recipe. ' +
    NO_REPEAT,
  properties: {
    recipe_id: { type: 'string', description: 'A saved recipe id listed for this site.' },
    parameters: PARAMETERS,
  },
  required: ['recipe_id', 'parameters'],
  additionalProperties: false,
  repeatable: false,
  timeoutMs: BROWSER_REQUEST_TIMEOUT_MS,
});

export const watch = requestTool({
  name: 'watch',
  description:
    'Set a host watch on a venue’s availability, from a read-only recipe that reaches its availability view and exact booking bounds. The host checks without model polling. All watches in this job may book only once, within bounds and after a calendar check. A paid booking needs the principal’s approval of the bounds: the host reads the venue’s fees and cancellation terms itself, shows them on the principal’s card, and holds them within max_total. Give release only when the venue states its own schedule, quoting it; never infer one, and without it the watch keeps its ordinary pace. ' +
    'Returns armed or awaiting_principal, then wait; or refused with a reason, such as read_only_recipe_required (save the route again from steps that only read), release_zone_unknown (add the venue’s time_zone), venue_unavailable or terms_unavailable (the host could not read the venue or its terms: report it to main), or terms_over_bounds (the venue’s terms can charge more than max_total: report the amount and terms it gives to main, which can ask the principal for a higher maximum). Wakes report booked; unconfirmed (report it to main and never retry it); available (a table within bounds the host did not book itself: book it through purchase); outside_bounds (the watch carries on); calendar_conflict or calendar_unavailable (report it to main); expired; or blocked (the site kept refusing checks: report it to main). ' +
    'On a site the host has no reader for, also mark region from an observation of the view the recipe ends on; region_required or site_has_reader says whether the site needs one. The host never books there itself: it wakes you with changed and the region’s text before and after (untrusted page text). Observe, and if a table fits, book it through purchase: a free table is pressed at once, a paid one within the approved maximum goes through, anything else sends a card. A change you leave unbooked slows the watch. region_missing: the host cannot find the region or its route; mark it again with watch_id, the same bounds and a fresh observation, which answers marked. A mark is refused with region_off_route (mark an element on the view the recipe ends on), or region_unmarkable or region_too_large (mark the smaller element that holds the slots). ' +
    NO_REPEAT,
  properties: {
    site: {
      type: 'string',
      format: 'uri',
      description: 'The public site URL, matching the saved availability recipe.',
    },
    recipe_id: { type: 'string', description: 'The read-only availability recipe to check.' },
    parameters: PARAMETERS,
    venue: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The site’s own id for the venue where it shows one; otherwise its name again.',
        },
        name: {
          type: 'string',
          description: 'The venue’s name exactly as the site shows it: a booking matches the watch by it.',
        },
      },
      required: ['id', 'name'],
      additionalProperties: false,
    },
    party_size: { type: 'integer', minimum: 1, description: 'The exact number of guests.' },
    windows: {
      type: 'array',
      minItems: 1,
      items: WINDOW,
      description: 'Allowed booking windows with explicit UTC offsets.',
    },
    financial: {
      type: 'object',
      properties: {
        currency: { type: 'string', pattern: '^[A-Z]{3}$', description: 'The approved currency.' },
        max_total: {
          type: 'string',
          pattern: '^\\d+(?:\\.\\d{1,3})?$',
          description: 'Maximum total exposure per reservation in major currency units, including all guests and fees.',
        },
      },
      required: ['currency', 'max_total'],
      additionalProperties: false,
    },
    until: { ...DATE_TIME, description: 'The deadline at which checking ends and the job is notified.' },
    release: {
      type: 'object',
      description:
        'The venue’s own release schedule, only when the venue states one; never a guess. The host checks just after each release on the venue’s clock, then often for a few minutes. Recorded once; it cannot change later.',
      properties: {
        wording: { type: 'string', minLength: 1, maxLength: 500, description: 'The venue’s words, quoted.' },
        days_ahead: {
          type: 'integer',
          minimum: 0,
          maximum: 366,
          description: 'Tables for a date open this many days before it.',
        },
        day_of_month: {
          type: 'integer',
          minimum: 1,
          maximum: 31,
          description: 'Tables open on this day of the month, with months_ahead.',
        },
        months_ahead: {
          type: 'integer',
          minimum: 0,
          maximum: 12,
          description: 'How many months before the date’s month that day falls.',
        },
        time: {
          type: 'string',
          pattern: '^(?:[01]\\d|2[0-3]):[0-5]\\d$',
          description: 'The release time, 24-hour HH:MM on the venue’s clock.',
        },
        time_zone: {
          type: 'string',
          description:
            'The venue’s IANA timezone, such as Asia/Tokyo; needed on a site with no host reader, since a reader’s own zone comes first.',
        },
      },
      required: ['wording', 'time'],
      oneOf: [{ required: ['days_ahead'] }, { required: ['day_of_month', 'months_ahead'] }],
      additionalProperties: false,
    },
    region: {
      ...REF,
      description:
        'On a site with no host reader: the element that shows availability, such as the slot list’s container, which stays while tables come and go. The host keeps its text as the baseline.',
    },
    watch_id: {
      type: 'string',
      description:
        'Mark a region watch’s region again after region_missing: its id, with the same bounds and a new region (and recipe when the route changed). Its approval stays.',
    },
  },
  required: ['site', 'recipe_id', 'parameters', 'venue', 'party_size', 'windows', 'financial', 'until'],
  additionalProperties: false,
  repeatable: false,
  timeoutMs: BROWSER_REQUEST_TIMEOUT_MS,
});

export const listWatches = requestTool({
  name: 'list_watches',
  description:
    'Read this job’s watches, their bounds and current states, and for a region watch its marked region: when it was marked, since when it is missing, wakes this hour and its baseline text (untrusted). Returns the watches; inspect these before setting or cancelling a watch. After a timeout use request_status or repeat this read-only call; a repeat changes nothing.',
  properties: {},
  required: [],
  additionalProperties: false,
  repeatable: true,
  timeoutMs: BROWSER_REQUEST_TIMEOUT_MS,
});

export const cancelWatch = requestTool({
  name: 'cancel_watch',
  description:
    'Cancel one of this job’s watches and revoke its unused booking authority. Returns cancelled, also for a watch that had already ended, or in_progress: its booking is being pressed, and finishes and reports before cancellation completes. Wait for that report instead of starting another booking. ' +
    NO_REPEAT,
  properties: { watch_id: { type: 'string', description: 'The watch id returned by watch or list_watches.' } },
  required: ['watch_id'],
  additionalProperties: false,
  repeatable: false,
  timeoutMs: BROWSER_REQUEST_TIMEOUT_MS,
});

registerTools(
  [
    browser,
    fillSecret,
    credentialForm,
    signInCode,
    purchase,
    requestConsent,
    saveRecipe,
    runRecipe,
    watch,
    listWatches,
    cancelWatch,
  ],
  'browser',
);
