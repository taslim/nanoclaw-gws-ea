import type { ModuleMigrationName, PortableMigration } from '../../db/migrations/index.js';

/** Main's delegated reservation limits are independent of facts supplied by a page or browser job. */
export const browserReservationBoundsMigration: PortableMigration & { name: ModuleMigrationName } = {
  version: 1,
  name: 'module:gws-ea-browser:reservation-bounds',
  async up(db) {
    await db.exec(`
      CREATE TABLE gws_ea_browser_reservation_bounds (
        job_id TEXT PRIMARY KEY REFERENCES gws_ea_browser_jobs(id),
        bounds_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  },
};

/** Watch grants and the one booking claim outlive queues and browser processes. */
export const browserWatchesMigration: PortableMigration & { name: ModuleMigrationName } = {
  version: 1,
  name: 'module:gws-ea-browser:watches',
  async up(db) {
    await db.exec(`
      CREATE TABLE gws_ea_browser_watches (
        id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES gws_ea_browser_jobs(id), site TEXT NOT NULL,
        check_recipe_id TEXT NOT NULL, check_recipe_version INTEGER NOT NULL,
        parameters_json TEXT NOT NULL, check_key TEXT NOT NULL, bounds_json TEXT NOT NULL,
        approval_id TEXT UNIQUE, approval_json TEXT, approval_finished_at TEXT, authority_id TEXT,
        status TEXT NOT NULL CHECK(status IN ('awaiting_principal','armed','checking','preparing','booking','booked','expired','cancelled','blocked','outcome_unknown')),
        pending_request_id TEXT, booking_recipe_id TEXT, booking_recipe_version INTEGER,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, next_check_at TEXT NOT NULL
      );
      CREATE INDEX gws_ea_browser_watch_due ON gws_ea_browser_watches(status,next_check_at);
      CREATE INDEX gws_ea_browser_watch_job ON gws_ea_browser_watches(job_id,status);
      CREATE TABLE gws_ea_browser_watch_job_claims (
        job_id TEXT PRIMARY KEY REFERENCES gws_ea_browser_jobs(id),
        state TEXT NOT NULL CHECK(state IN ('available','committing','booked','unknown')),
        watch_id TEXT, authority_id TEXT, attempt_id TEXT, request_id TEXT,
        commit_started_at TEXT, finished_at TEXT, last_action_index INTEGER
      );
      CREATE TABLE gws_ea_browser_watch_recipe_links (
        check_recipe_id TEXT NOT NULL, check_recipe_version INTEGER NOT NULL,
        booking_recipe_id TEXT NOT NULL, booking_recipe_version INTEGER NOT NULL,
        source_watch_id TEXT NOT NULL, source_attempt_id TEXT NOT NULL, verified_at TEXT NOT NULL,
        PRIMARY KEY(check_recipe_id,check_recipe_version,booking_recipe_id,booking_recipe_version)
      );
      CREATE TABLE gws_ea_browser_watch_slot_claims (
        site TEXT NOT NULL, slot_key TEXT NOT NULL, job_id TEXT NOT NULL,
        watch_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
        PRIMARY KEY(site,slot_key)
      );
      CREATE TABLE gws_ea_browser_watch_checks (
        id TEXT PRIMARY KEY, site TEXT NOT NULL, check_recipe_id TEXT NOT NULL,
        check_recipe_version INTEGER NOT NULL, parameter_hash TEXT NOT NULL,
        trigger TEXT NOT NULL CHECK(trigger IN ('timer','notify')),
        scheduled_at TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
        outcome TEXT, next_check_at TEXT, backoff_until TEXT
      );
      CREATE INDEX gws_ea_browser_watch_check_budget ON gws_ea_browser_watch_checks(site,started_at);
      CREATE TABLE gws_ea_browser_watch_check_members (
        check_id TEXT NOT NULL REFERENCES gws_ea_browser_watch_checks(id),
        watch_id TEXT NOT NULL REFERENCES gws_ea_browser_watches(id),
        PRIMARY KEY(check_id,watch_id)
      );
      CREATE TABLE gws_ea_browser_watch_site_state (
        site TEXT PRIMARY KEY, last_check_at TEXT, last_interval_ms INTEGER,
        next_allowed_at TEXT, backoff_until TEXT, consecutive_blocks INTEGER NOT NULL DEFAULT 0,
        budget_scale REAL NOT NULL DEFAULT 1
      );
      CREATE TABLE gws_ea_browser_watch_notices (
        watch_id TEXT NOT NULL, event_key TEXT NOT NULL, outcome_json TEXT NOT NULL,
        created_at TEXT NOT NULL, delivered_at TEXT, PRIMARY KEY(watch_id,event_key)
      );
      CREATE TABLE gws_ea_browser_watch_notify (
        site TEXT NOT NULL, message_id TEXT NOT NULL, received_at TEXT NOT NULL,
        consumed_at TEXT, PRIMARY KEY(site,message_id)
      );
      CREATE INDEX gws_ea_browser_watch_pending_notices ON gws_ea_browser_watch_notices(created_at) WHERE delivered_at IS NULL;
      CREATE INDEX gws_ea_browser_watch_pending_notify ON gws_ea_browser_watch_notify(site) WHERE consumed_at IS NULL;
      ALTER TABLE gws_ea_browser_authorities ADD COLUMN watch_id TEXT REFERENCES gws_ea_browser_watches(id);
    `);
  },
};

/**
 * A venue's release schedule, written once when its watch is created and outside the
 * bounds the principal approves. Watches set before it have none.
 */
export const browserWatchReleaseMigration: PortableMigration & { name: ModuleMigrationName } = {
  version: 1,
  name: 'module:gws-ea-browser:watch-release',
  async up(db) {
    await db.exec('ALTER TABLE gws_ea_browser_watches ADD COLUMN release_json TEXT;');
  },
};

/** A recipe id is immutable; saving the same task appends a version for future errands. */
export const browserRecipesMigration: PortableMigration & { name: ModuleMigrationName } = {
  version: 1,
  name: 'module:gws-ea-browser:recipes',
  async up(db) {
    await db.exec(`
      CREATE TABLE gws_ea_browser_action_trace (
        job_id TEXT NOT NULL REFERENCES gws_ea_browser_jobs(id),
        action_index INTEGER NOT NULL,
        request_id TEXT NOT NULL,
        step_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(job_id,action_index)
      );
      CREATE TABLE gws_ea_browser_recipes (
        id TEXT PRIMARY KEY,
        site TEXT NOT NULL,
        name TEXT NOT NULL,
        version INTEGER NOT NULL,
        source_job_id TEXT NOT NULL REFERENCES gws_ea_browser_jobs(id),
        first_action INTEGER NOT NULL,
        last_action INTEGER NOT NULL,
        parameters_json TEXT NOT NULL,
        steps_json TEXT NOT NULL,
        read_only INTEGER NOT NULL CHECK(read_only IN(0,1)),
        created_at TEXT NOT NULL,
        UNIQUE(site,name,version)
      );
      CREATE INDEX gws_ea_browser_recipes_site ON gws_ea_browser_recipes(site,name,version);
    `);
  },
};

export const browserQueueMigration: PortableMigration & { name: ModuleMigrationName } = {
  version: 2,
  name: 'module:gws-ea-browser:durable-queue',
  async up(db) {
    await db.exec(`
      CREATE TABLE gws_ea_browser_jobs (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL UNIQUE,
        browser_session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id),
        source_agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
        cancelled INTEGER NOT NULL DEFAULT 0 CHECK(cancelled IN (0,1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE gws_ea_browser_requests (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES gws_ea_browser_jobs(id),
        session_id TEXT NOT NULL REFERENCES sessions(id),
        request_id TEXT NOT NULL,
        action TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        budget_ms INTEGER NOT NULL,
        accepted_at TEXT NOT NULL,
        started_at TEXT,
        commit_started_at TEXT,
        answered_at TEXT,
        answer_json TEXT,
        delivered_at TEXT,
        UNIQUE(session_id, request_id)
      );
      CREATE INDEX gws_ea_browser_requests_pending ON gws_ea_browser_requests(job_id, answered_at, accepted_at);
      CREATE INDEX gws_ea_browser_requests_delivery ON gws_ea_browser_requests(delivered_at, answered_at);
      CREATE TABLE gws_ea_browser_downloads (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES gws_ea_browser_jobs(id),
        request_id TEXT NOT NULL REFERENCES gws_ea_browser_requests(id),
        host_path TEXT NOT NULL,
        filename TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        inbox_path TEXT,
        handed_off_at TEXT
      );
    `);
  },
};

/** Profile-local site ownership and durable wake candidates; never session mailbox state. */
export const browserSiteLeasesMigration: PortableMigration & { name: ModuleMigrationName } = {
  version: 1,
  name: 'module:gws-ea-browser:site-leases',
  async up(db) {
    await db.exec(`
      CREATE TABLE gws_ea_browser_site_leases (
        site TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('active', 'idle', 'purchase')),
        updated_at TEXT NOT NULL
      );
      CREATE INDEX gws_ea_browser_site_leases_job ON gws_ea_browser_site_leases(job_id);
      CREATE TABLE gws_ea_browser_site_waiters (
        site TEXT NOT NULL,
        job_id TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        PRIMARY KEY (site, job_id)
      );
    `);
  },
};

/**
 * Host-generated credentials (KTD6): each operation's binding, candidate and
 * source references, phase and decided settlement; never a value. A finalized row is the
 * ownership record of the Login it names. Rows outlive jobs, so `job_id` is
 * deliberately not a foreign key.
 */
export const browserCredentialAttemptsMigration: PortableMigration & { name: ModuleMigrationName } = {
  version: 1,
  name: 'module:gws-ea-browser:credential-attempts',
  async up(db) {
    await db.exec(`
      CREATE TABLE gws_ea_browser_credential_attempts (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('signup','rotation')),
        job_id TEXT NOT NULL,
        instance_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        vault_id TEXT NOT NULL,
        origin TEXT NOT NULL,
        site TEXT NOT NULL,
        username TEXT NOT NULL,
        source_item_id TEXT,
        source_version INTEGER,
        candidate_item_id TEXT,
        candidate_version INTEGER,
        phase TEXT NOT NULL CHECK(phase IN ('preparing','saved','exposed','awaiting_verification','unknown','rejected','confirmed','finalized','conflict')),
        save_started_at TEXT,
        conflict_reason TEXT CHECK(conflict_reason IN ('ownership_mismatch','password_changed','login_removed')),
        settlement TEXT CHECK(settlement IN ('promoted','kept')),
        evidence_json TEXT,
        owned_item_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        exposed_at TEXT,
        finalized_at TEXT,
        CHECK((kind = 'rotation') = (source_item_id IS NOT NULL)),
        CHECK(owned_item_id IS NULL OR phase = 'finalized'),
        CHECK(settlement IS NULL OR kind = 'rotation'),
        CHECK(settlement IS NULL OR settlement = 'promoted' OR conflict_reason IS NOT NULL)
      );
      CREATE UNIQUE INDEX gws_ea_browser_credential_open_rotation ON gws_ea_browser_credential_attempts(vault_id,source_item_id) WHERE source_item_id IS NOT NULL AND phase NOT IN ('rejected','finalized');
      CREATE INDEX gws_ea_browser_credential_owned ON gws_ea_browser_credential_attempts(vault_id,owned_item_id) WHERE owned_item_id IS NOT NULL;
    `);
  },
};

/** Spending state is independent of transient approval cards and session lifetime. */
export const browserPurchaseMigration: PortableMigration & { name: ModuleMigrationName } = {
  version: 4,
  name: 'module:gws-ea-browser:purchases',
  async up(db) {
    await db.exec(`
      ALTER TABLE gws_ea_browser_jobs ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0,1));
      CREATE TABLE gws_ea_browser_purchase_cards (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES gws_ea_browser_jobs(id),
        request_id TEXT NOT NULL UNIQUE,
        approval_id TEXT UNIQUE,
        approval_json TEXT,
        status TEXT NOT NULL CHECK(status IN ('open','approved','rejected','expired','withdrawn','superseded')),
        facts_json TEXT NOT NULL,
        bounds_json TEXT NOT NULL,
        exception_ids_json TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        notified_at TEXT
      );
      CREATE UNIQUE INDEX gws_ea_browser_current_card ON gws_ea_browser_purchase_cards(job_id) WHERE status = 'open';
      CREATE TABLE gws_ea_browser_reservation_guarantees (
        id TEXT PRIMARY KEY,
        approval_id TEXT NOT NULL UNIQUE,
        principal_user_id TEXT NOT NULL,
        currency TEXT NOT NULL,
        max_total_minor INTEGER NOT NULL CHECK(max_total_minor >= 0),
        created_at TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE TABLE gws_ea_browser_guarantee_proposals (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        request_id TEXT NOT NULL UNIQUE,
        approval_id TEXT UNIQUE,
        currency TEXT NOT NULL,
        max_total_minor INTEGER NOT NULL,
        expires_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('open','approved','withdrawn','expired','rejected')),
        created_at TEXT NOT NULL
      );
      CREATE TABLE gws_ea_browser_authorities (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES gws_ea_browser_jobs(id),
        approval_id TEXT UNIQUE,
        card_id TEXT REFERENCES gws_ea_browser_purchase_cards(id),
        kind TEXT NOT NULL CHECK(kind IN ('checkout','watch','reservation_guarantee')),
        state TEXT NOT NULL CHECK(state IN ('live','committing','committed','unknown','revoked')),
        facts_json TEXT NOT NULL,
        bounds_json TEXT NOT NULL,
        exception_ids_json TEXT NOT NULL,
        guarantee_id TEXT REFERENCES gws_ea_browser_reservation_guarantees(id),
        attempt_id TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        commit_started_at TEXT,
        commit_request_id TEXT,
        outcome_json TEXT,
        notified_at TEXT,
        UNIQUE(guarantee_id,attempt_id)
      );
      CREATE UNIQUE INDEX gws_ea_browser_live_checkout ON gws_ea_browser_authorities(job_id) WHERE kind = 'checkout' AND state IN ('live','committing');
      CREATE TABLE gws_ea_browser_pending_commits (
        authority_id TEXT PRIMARY KEY REFERENCES gws_ea_browser_authorities(id),
        generation INTEGER NOT NULL DEFAULT 0,
        queued_request_id TEXT
      );
      CREATE TABLE gws_ea_browser_purchase_attempts (
        id TEXT PRIMARY KEY,
        authority_id TEXT NOT NULL UNIQUE REFERENCES gws_ea_browser_authorities(id),
        job_id TEXT NOT NULL,
        site TEXT NOT NULL,
        facts_json TEXT NOT NULL,
        attempted_at TEXT NOT NULL,
        resolution TEXT CHECK(resolution IN ('committed','not_committed')),
        evidence_json TEXT,
        merchant_record_id TEXT,
        merchant_account TEXT,
        reconciled_at TEXT
      );
      CREATE UNIQUE INDEX gws_ea_browser_record_attempt ON gws_ea_browser_purchase_attempts(site,merchant_account,merchant_record_id) WHERE merchant_record_id IS NOT NULL;
      CREATE INDEX gws_ea_browser_unresolved_site ON gws_ea_browser_purchase_attempts(site,resolution);
      CREATE TABLE gws_ea_browser_purchase_blocks (
        site TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );
    `);
  },
};

/**
 * Consent stops and the principal's standing grants (KTD11). A stop is one wording the engine could not agree
 * to on its own, for one job's form; a grant is the principal's agreement to that exact wording on one site
 * and frame origin, live until main withdraws it. Grants outlive jobs, so they name no job.
 */
export const browserConsentMigration: PortableMigration & { name: ModuleMigrationName } = {
  version: 1,
  name: 'module:gws-ea-browser:consent',
  async up(db) {
    await db.exec(`
      CREATE TABLE gws_ea_browser_consent_stops (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES gws_ea_browser_jobs(id),
        site TEXT NOT NULL,
        origin TEXT NOT NULL,
        wording TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('marketing','opt_out','agreement','bundled','double_negative')),
        form_fingerprint TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('open','requested','approved','rejected','expired','withdrawn')),
        approval_id TEXT UNIQUE,
        created_at TEXT NOT NULL,
        requested_at TEXT,
        decided_at TEXT
      );
      CREATE INDEX gws_ea_browser_consent_stop_job ON gws_ea_browser_consent_stops(job_id,status);
      CREATE TABLE gws_ea_browser_consent_grants (
        id TEXT PRIMARY KEY,
        site TEXT NOT NULL,
        origin TEXT NOT NULL,
        wording TEXT NOT NULL,
        approval_id TEXT NOT NULL,
        principal_user_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        withdrawn_at TEXT
      );
      CREATE UNIQUE INDEX gws_ea_browser_consent_grant_live ON gws_ea_browser_consent_grants(site,origin,wording) WHERE withdrawn_at IS NULL;
    `);
  },
};

/**
 * Incidents (KTD10): spending that may have slipped past the host, each recorded with its job's stop. A job
 * records one incident per kind and evidence; an incident from a page names no purchase attempt.
 */
export const browserIncidentsMigration: PortableMigration & { name: ModuleMigrationName } = {
  version: 1,
  name: 'module:gws-ea-browser:incidents',
  async up(db) {
    await db.exec(`
      CREATE TABLE gws_ea_browser_incidents (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('unapproved_commit')),
        site TEXT NOT NULL,
        job_id TEXT NOT NULL REFERENCES gws_ea_browser_jobs(id),
        attempt_id TEXT,
        evidence_key TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        notified_at TEXT,
        UNIQUE(job_id,kind,evidence_key)
      );
    `);
  },
};

/**
 * Personal-data disclosures (KTD19): main's word that one errand may give one site one of the principal's
 * stored private values. A row names the value by its id in the privacy store and never holds it, so no second
 * copy exists; a value removed there leaves its rows naming nothing.
 */
export const browserDisclosuresMigration: PortableMigration & { name: ModuleMigrationName } = {
  version: 1,
  name: 'module:gws-ea-browser:disclosures',
  async up(db) {
    await db.exec(`
      CREATE TABLE gws_ea_browser_disclosures (
        job_id TEXT NOT NULL REFERENCES gws_ea_browser_jobs(id),
        site TEXT NOT NULL,
        value_id TEXT NOT NULL CHECK(value_id LIKE 'pv-%'),
        created_at TEXT NOT NULL,
        PRIMARY KEY(job_id,site,value_id)
      );
    `);
  },
};

/**
 * Checkouts on any site (KTD3, KTD5, KTD7): a free commit's money-less attempt, each paid attempt's payment
 * platform and contact-email account key, and the change a replacement card names, which the change cap counts.
 * Free attempts outlive jobs, so `job_id` is deliberately not a foreign key.
 */
export const browserGenericCheckoutMigration: PortableMigration & { name: ModuleMigrationName } = {
  version: 1,
  name: 'module:gws-ea-browser:generic-checkout',
  async up(db) {
    await db.exec(`
      CREATE TABLE gws_ea_browser_free_attempts (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        request_id TEXT NOT NULL UNIQUE,
        site TEXT NOT NULL,
        platform TEXT,
        account_key TEXT,
        facts_json TEXT NOT NULL,
        attempted_at TEXT NOT NULL,
        resolution TEXT CHECK(resolution IN ('committed','not_committed')),
        evidence_json TEXT,
        merchant_record_id TEXT,
        reconciled_at TEXT
      );
      CREATE INDEX gws_ea_browser_free_attempts_site ON gws_ea_browser_free_attempts(site,resolution);
      ALTER TABLE gws_ea_browser_purchase_attempts ADD COLUMN platform TEXT;
      ALTER TABLE gws_ea_browser_purchase_attempts ADD COLUMN account_key TEXT;
      ALTER TABLE gws_ea_browser_purchase_cards ADD COLUMN change_text TEXT;
    `);
  },
};

/**
 * Wake-on-change watches (KTD20): on a site with no reader, the region the agent marked, its normalized text as
 * the agent last saw it, when it was marked, and since when the host has not found it. Reader watches leave them
 * null. Wakes are the watch's own notices, so they need no table of their own.
 */
export const browserWatchRegionMigration: PortableMigration & { name: ModuleMigrationName } = {
  version: 1,
  name: 'module:gws-ea-browser:watch-region',
  async up(db) {
    await db.exec(`
      ALTER TABLE gws_ea_browser_watches ADD COLUMN region_json TEXT;
      ALTER TABLE gws_ea_browser_watches ADD COLUMN region_baseline TEXT;
      ALTER TABLE gws_ea_browser_watches ADD COLUMN region_marked_at TEXT;
      ALTER TABLE gws_ea_browser_watches ADD COLUMN region_missing_since TEXT;
    `);
  },
};
