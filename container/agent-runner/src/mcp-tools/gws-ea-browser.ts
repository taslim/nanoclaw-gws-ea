/** The sealed browser agent's native, mailbox-backed host requests. */
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
    'Run an ordered batch in this errand’s host browser. It stops at the first failure or navigation and returns the resulting page observation, with generation-stamped refs. Screenshots arrive as images, linked by each action’s image_index. JavaScript, field-value reads, clipboard access, cookies and storage export are unavailable. Ordinary text input refuses passwords, codes and payment fields; use fill_secret or sign_in_code for sign-in, and credential_form for an authorized signup or password change. ' +
    'Outcomes: completed, or stopped with stale_ref, not_actionable, timeout, navigated, purchase_control, speaks_as_principal, account_security, secret_field, blocked_address, challenge, sign_in_wall, site_busy, unsupported_merchant, window_closed, browser_unavailable or interrupted. A commit-class result is committed or outcome_unknown. Use the returned page after navigated; re-observe stale_ref; use purchase for purchase_control, and report unsupported or blocked work to main. An unknown commit must be reconciled, never retried. ' +
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
    'Ask the host to fill a 1Password login by handle and submit it. The host validates the complete HTTPS frame origin before resolving and again before insertion; no secret value reaches you. Outcomes: submitted, no_item_for_site, origin_mismatch, cleared_after_submit, vault_unavailable or rate_limited. Continue from a fresh observation after submission; report a missing item, unavailable vault or mismatched origin to main. ' +
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
    'Fill and submit a signup or password-change form with a password the host generates and saves in 1Password first, under the credential authority main recorded for this job. Give fresh refs for the fields the form has (a signup’s username, new_password and confirmation; a change’s current_password, new_password and confirmation) and the control that submits them. A multi-step signup sends username alone first, then the password step. For a signup whose form requires accepting the site’s terms of service, give that checkbox as accept_terms; the host checks only a required box named for the site’s terms, never marketing, data sharing or payment terms. The host refuses before revealing anything when the frame, origin, form or control is unexpected, financial or another security change; no value reaches you. ' +
    'Outcomes: continued (observe the next step), account_created or password_changed with vault saved, updated, both_kept (the original login and the new password are both kept in 1Password) or pending; account_exists, password_rejected, current_password_rejected, verification_requested, outcome_unknown, not_owned, refused with a reason, vault_unavailable or rate_limited. The authority covers one submission: never submit it again. ' +
    'After verification_requested, use operation verify: the host waits for the site’s email to the account and opens its link or, given the code field and its control, enters its code; outcomes account_created, verification_requested, nothing_arrived (verify again later), not_watched (the host is not watching this account’s mail, so it cannot complete the verification) or ambiguous, or refused with code_field_needed. After outcome_unknown, use operation reconcile as your next step, with no other action but an observation: it only reads the site’s late response and answers its outcome or inconclusive. Report every outcome but continued to main. ' +
    NO_REPEAT,
  properties: {
    operation: {
      type: 'string',
      enum: ['submit', 'verify', 'reconcile'],
      default: 'submit',
      description:
        'submit fills and activates the form; verify completes the email verification a signup asked for; reconcile only reads the site’s response to an unknown outcome.',
    },
    authority: { type: 'string', description: 'The credential authority id main gave this job.' },
    username: REF,
    current_password: REF,
    new_password: REF,
    confirmation: REF,
    accept_terms: { ...REF, description: 'A signup’s required terms-of-service checkbox in the same form.' },
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
      not: { anyOf: [...ACCOUNT_FIELDS, 'accept_terms'].map((field) => ({ required: [field] })) },
    },
    {
      properties: { operation: { const: 'reconcile' } },
      required: ['operation'],
      not: {
        anyOf: [...ACCOUNT_FIELDS, 'accept_terms', 'code_field', 'activate'].map((field) => ({ required: [field] })),
      },
    },
  ],
  prepare(fields) {
    if (fields.operation === 'reconcile')
      return has(fields, ...ACCOUNT_FIELDS, 'accept_terms', 'code_field', 'activate')
        ? 'reconcile takes only the authority.'
        : fields;
    if (fields.operation === 'verify') {
      if (has(fields, ...ACCOUNT_FIELDS, 'accept_terms')) return 'verify takes only the code field and its control.';
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
    'Register a site-bound sign-in wait before the host presses the send control. The target is the code field, or the starting email field of a host-reviewed passwordless flow; the host binds its new code field after the transition. For assistant mail, isolated external-email interprets one qualifying code or magic link; only the host inserts or opens it. from=principal records the wait for a code relayed through main; never supply a raw code here. Outcomes: code_filled, link_opened, nothing_arrived, ambiguous, origin_mismatch or awaiting_code. Observe again after completion; tell main the recorded site when awaiting_code, and report ambiguity or origin mismatch. ' +
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
    'Request a supported merchant commit under principal-approved authority, or read-only reconciliation of an unresolved attempt. The host reads all checkout facts and financial terms; your words never verify a purchase. Commit outcomes: awaiting_principal, not_a_purchase, unsupported_merchant, terms_unavailable or site_purchase_blocked. Later notices: placed, changed, checkout_lapsed, rejected, expired, withdrawn or outcome_unknown. Wait for the notice when awaiting_principal; use a fresh observation for changed or checkout_lapsed. For outcome_unknown use operation=reconcile with the attempt id and a page ref: confirmed_placed or confirmed_not_placed establishes the host-recorded result; inconclusive keeps purchases blocked and requires main’s informed principal decision. Never automatically retry an uncertain commit. ' +
    NO_REPEAT,
  properties: {
    operation: {
      type: 'string',
      enum: ['commit', 'reconcile'],
      default: 'commit',
      description: 'commit requests authority; reconcile only reads supported evidence.',
    },
    target: REF,
    attempt_id: { type: 'string', description: 'The unresolved attempt’s id; required only for reconcile.' },
    delivery_window: {
      ...WINDOW,
      description:
        'The principal’s explicitly allowed delivery window, when the errand specifies one. Only each bound’s calendar date counts.',
    },
    needed_by: { ...DATE_TIME, description: 'The principal’s latest acceptable delivery time, when specified.' },
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

export const saveRecipe = requestTool({
  name: 'save_recipe',
  description:
    'Save a range of this errand’s recorded actions as a named recipe. Bind ordinary type/select values, a single-field form_input value, or a click target’s exact accessible name. Indices are global across this job’s requests, zero-based and inclusive. The host records locators and checkpoints; no executable code is accepted. Returns saved with the recipe id, name and parameters; use that id with run_recipe. ' +
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
    'Set a host watch using a read-only availability recipe and exact booking bounds. The host checks without model polling; all watches in this job may book only once, within bounds and after a successful calendar check. Financial commitments require the principal’s approval; requested terms are bounds, never merchant facts, and the host re-reads complete terms. Returns armed, awaiting_principal or refused. Wait after arming or approval; wakes report booked, outside_bounds, calendar_conflict, calendar_unavailable, expired, blocked or outcome_unknown. Report a conflict, unavailable calendar, block or uncertain result to main; never retry a possibly completed booking. ' +
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
      properties: { id: { type: 'string' }, name: { type: 'string' } },
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
        terms: {
          type: 'string',
          description:
            'Requested limits on financial commitments, including fee triggers and cancellation deadlines; the host verifies actual merchant terms.',
        },
      },
      required: ['currency', 'max_total', 'terms'],
      additionalProperties: false,
    },
    until: { ...DATE_TIME, description: 'The deadline at which checking ends and the job is notified.' },
  },
  required: ['site', 'recipe_id', 'parameters', 'venue', 'party_size', 'windows', 'financial', 'until'],
  additionalProperties: false,
  repeatable: false,
  timeoutMs: BROWSER_REQUEST_TIMEOUT_MS,
});

export const listWatches = requestTool({
  name: 'list_watches',
  description:
    'Read this job’s watches, their bounds and current states. Returns listed with the watches; inspect these before setting or cancelling a watch. After a timeout use request_status or repeat this read-only call; a repeat changes nothing.',
  properties: {},
  required: [],
  additionalProperties: false,
  repeatable: true,
  timeoutMs: BROWSER_REQUEST_TIMEOUT_MS,
});

export const cancelWatch = requestTool({
  name: 'cancel_watch',
  description:
    'Cancel one of this job’s watches and revoke its unused booking authority. Returns cancelled, already_ended or in_progress; an in-progress commit finishes and reports before cancellation completes. Wait for that report instead of starting another booking. ' +
    NO_REPEAT,
  properties: { watch_id: { type: 'string', description: 'The watch id returned by watch or list_watches.' } },
  required: ['watch_id'],
  additionalProperties: false,
  repeatable: false,
  timeoutMs: BROWSER_REQUEST_TIMEOUT_MS,
});

registerTools(
  [browser, fillSecret, credentialForm, signInCode, purchase, saveRecipe, runRecipe, watch, listWatches, cancelWatch],
  'browser',
);
