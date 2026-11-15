import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { analyzeMessage, parseShanghaiDate } from './processor.mjs';
import { buildNotionPayload, sendToNotion, validateNotionURL } from './notion.mjs';

const DAY = 86_400_000;
const CATEGORIES = new Set(['mandatory_event', 'mandatory_task', 'change_or_cancel', 'optional_recruitment', 'useful_info', 'noise']);
const IMPORT_PLATFORMS = new Set(['wechat', 'qq', 'manual']);
const DATE_FIELDS = ['officialStart', 'officialEnd', 'deadline'];
const EDIT_FIELDS = new Set(['revision', 'title', 'action', 'officialStart', 'officialEnd', 'deadline', 'location', 'participating']);
const PAGE_ID = /^(?:[\da-f]{32}|[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})$/i;

function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  error.statusCode = status;
  return error;
}

function hash(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

function stringField(value, name, max, { empty = false } = {}) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) {
    throw fail(`${name} must be ${empty ? 'a string' : 'a non-empty string'} of at most ${max} characters.`);
  }
  return value;
}

function validInstant(value, name) {
  if (typeof value !== 'string') throw fail(`${name} must include an explicit timezone.`);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) throw fail(`${name} must include an explicit timezone.`);
  const [, yearText, monthText, dayText, hourText, minuteText, secondText = '0', offset] = match;
  const year = Number(yearText), month = Number(monthText), day = Number(dayText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]
    || Number(hourText) > 23 || Number(minuteText) > 59 || Number(secondText) > 59
    || (offset !== 'Z' && (Number(offset.slice(1, 3)) > 14 || Number(offset.slice(4)) > 59
      || (Number(offset.slice(1, 3)) === 14 && Number(offset.slice(4)) !== 0)))
    || !Number.isFinite(Date.parse(value))) throw fail(`${name} is not a valid calendar timestamp.`);
  return new Date(value).toISOString();
}

function draftDate(value, name) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > 50) throw fail(`${name} is invalid.`);
  let parsed;
  try { parsed = parseShanghaiDate(value); } catch { throw fail(`${name} is invalid.`); }
  if (!parsed) throw fail(`${name} is invalid. Use YYYY-MM-DD HH:mm in Beijing time or an ISO timestamp with timezone.`);
  // Validate the original calendar day too: Date.parse can normalize February 31.
  const normalizedInput = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(value) ? value.replace(' ', 'T') + ':00+08:00' : value;
  validInstant(normalizedInput, name);
  return validInstant(parsed, name);
}

function validateDates(draft) {
  if (draft.officialEnd && (!draft.officialStart || Date.parse(draft.officialEnd) < Date.parse(draft.officialStart))) {
    throw fail('Official end must follow an official start.');
  }
}

function draftSnapshot(draft) {
  return Object.fromEntries(['id', 'messageId', 'revision', 'category', 'title', 'action', 'summary', 'importance',
    'officialStart', 'officialEnd', 'deadline', 'location', 'reasons', 'needsReview', 'participating']
    .map(key => [key, draft[key]]));
}

/** Public destination fields only. Credential rotation does not change approval. */
export function destinationIdentity(config = { configured: false }) {
  const name = (value, fallback) => typeof value === 'string' && value.trim() ? value.trim() : fallback;
  return {
    configured: Boolean(config?.configured),
    dataSourceId: typeof config?.dataSourceId === 'string' ? config.dataSourceId : '',
    titleProperty: name(config?.titleProperty, 'Name'),
    dateProperty: name(config?.dateProperty, 'Planned'),
    deadlineProperty: name(config?.deadlineProperty, 'Deadline'),
  };
}

function normalizeProposal(proposal) {
  if (!proposal || typeof proposal !== 'object' || !CATEGORIES.has(proposal.category)
    || !['high', 'medium', 'low'].includes(proposal.importance)) throw fail('The analyzer returned an invalid proposal.');
  const normalized = {
    category: proposal.category,
    title: stringField(proposal.title, 'Proposal title', 500, { empty: true }),
    action: stringField(proposal.action, 'Proposal action', 4000, { empty: true }),
    summary: stringField(proposal.summary, 'Proposal summary', 4000, { empty: true }),
    importance: proposal.importance,
    location: proposal.location == null ? null : stringField(proposal.location, 'Proposal location', 500, { empty: true }),
    needsReview: true,
    participating: false,
  };
  if (!Array.isArray(proposal.reasons) || proposal.reasons.length > 30) throw fail('The analyzer returned invalid reasons.');
  normalized.reasons = proposal.reasons.map(reason => stringField(reason, 'Proposal reason', 1000, { empty: true }));
  for (const field of DATE_FIELDS) normalized[field] = draftDate(proposal[field], field);
  validateDates(normalized);
  return normalized;
}

/** Revisioned local evidence. Callers must use one application owner per database. */
export class RelayStore {
  #db;
  #clock;
  #analyzer;
  #activeSyncs = 0;
  #closed = false;

  constructor(path = ':memory:', { clock = () => new Date(), analyzer = analyzeMessage } = {}) {
    if (typeof clock !== 'function' || typeof analyzer !== 'function') throw fail('A clock and synchronous analyzer are required.');
    this.#clock = clock;
    this.#analyzer = analyzer;
    if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, evidence_hash TEXT NOT NULL, payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS drafts (
        id TEXT PRIMARY KEY, message_id TEXT NOT NULL UNIQUE REFERENCES messages(id),
        revision INTEGER NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES drafts(id), revision INTEGER NOT NULL,
        created_at TEXT NOT NULL, evidence_hash TEXT NOT NULL, snapshot_hash TEXT NOT NULL,
        snapshot TEXT NOT NULL, UNIQUE(draft_id, revision)
      );
      CREATE TABLE IF NOT EXISTS handoffs (
        id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES drafts(id), revision INTEGER NOT NULL,
        approval_id TEXT NOT NULL REFERENCES approvals(id), status TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL,
        result TEXT, error TEXT
      );
    `);
    // A prior in-flight create may have reached Notion. Never repeat it after restart.
    const recoveredAt = this.#now();
    this.#transaction(() => {
      this.#db.prepare("UPDATE handoffs SET status = 'uncertain', updated_at = ?, error = ? WHERE status = 'syncing'")
        .run(recoveredAt, 'Application restarted during transfer. Verify the remote result before another transfer.');
      for (const row of this.#db.prepare("SELECT * FROM drafts WHERE status = 'syncing'").all()) {
        const draft = JSON.parse(row.payload);
        this.#putDraft({ ...draft, status: 'uncertain', updatedAt: recoveredAt });
      }
    });
  }

  #now() {
    const value = this.#clock();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw fail('The application clock is invalid.', 500);
    return date.toISOString();
  }

  #transaction(callback) {
    if (this.#closed) throw fail('The store is closed.', 503);
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const value = callback();
      this.#db.exec('COMMIT');
      return value;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  #putDraft(draft) {
    this.#db.prepare('UPDATE drafts SET revision = ?, status = ?, payload = ? WHERE id = ?')
      .run(draft.revision, draft.status, JSON.stringify(draft), draft.id);
  }

  #draft(id, revision, allowedStatuses) {
    if (!Number.isInteger(revision) || revision < 1) throw fail('A reviewed integer revision is required.');
    const row = this.#db.prepare('SELECT payload FROM drafts WHERE id = ?').get(id);
    if (!row) throw fail('Draft not found.', 404);
    const draft = JSON.parse(row.payload);
    if (draft.revision !== revision) throw fail('The draft changed. Review the latest revision before continuing.', 409);
    if (!allowedStatuses.includes(draft.status)) throw fail(`This draft is ${draft.status}; this action is not available.`, 409);
    return draft;
  }

  #approved(id, revision, config) {
    const draft = this.#draft(id, revision, ['approved']);
    const row = this.#db.prepare('SELECT * FROM approvals WHERE draft_id = ? AND revision = ?').get(id, revision);
    if (!row) throw fail('The approved snapshot is missing. No transfer was attempted.', 409);
    const messageRow = this.#db.prepare('SELECT * FROM messages WHERE id = ?').get(draft.messageId);
    const snapshot = JSON.parse(row.snapshot);
    if (!messageRow || hash(row.snapshot) !== row.snapshot_hash
      || hash(messageRow.payload) !== row.evidence_hash
      || messageRow.evidence_hash !== row.evidence_hash
      || hash(snapshot.message) !== row.evidence_hash
      || JSON.stringify(draftSnapshot(draft)) !== JSON.stringify(snapshot.draft)) {
      throw fail('The approved snapshot or evidence no longer matches. No transfer was attempted.', 409);
    }
    if (!snapshot.destination || JSON.stringify(snapshot.destination) !== JSON.stringify(destinationIdentity(config))) {
      throw fail('The Notion destination or property mapping changed. Edit and approve a new revision for this destination.', 409);
    }
    return { draft, approvalId: row.id, snapshot };
  }

  state() {
    if (this.#closed) throw fail('The store is closed.', 503);
    return {
      messages: this.#db.prepare('SELECT payload FROM messages ORDER BY rowid DESC').all().map(row => JSON.parse(row.payload)),
      drafts: this.#db.prepare('SELECT payload FROM drafts ORDER BY rowid DESC').all().map(row => JSON.parse(row.payload)),
      approvals: this.#db.prepare('SELECT * FROM approvals ORDER BY rowid DESC').all().map(row => ({
        id: row.id, draftId: row.draft_id, revision: row.revision, createdAt: row.created_at,
        evidenceHash: row.evidence_hash, snapshotHash: row.snapshot_hash, snapshot: JSON.parse(row.snapshot),
      })),
      handoffs: this.#db.prepare('SELECT * FROM handoffs ORDER BY rowid DESC').all().map(row => ({
        id: row.id, draftId: row.draft_id, revision: row.revision, approvalId: row.approval_id,
        status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
        payload: JSON.parse(row.payload), result: row.result ? JSON.parse(row.result) : null, error: row.error,
      })),
    };
  }

  importMessages(input) {
    if (!Array.isArray(input) || input.length > 500) throw fail('Import an array containing at most 500 messages.');
    try {
      if (Buffer.byteLength(JSON.stringify(input), 'utf8') > 2 * 1024 * 1024) throw new Error();
    } catch { throw fail('The message batch is invalid JSON or exceeds 2 MiB.'); }
    const now = this.#now();
    const nowTime = Date.parse(now);
    const normalized = input.map(raw => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw fail('Each message must be an object.');
      const sourceId = stringField(raw.id, 'Message ID', 256).trim();
      if (!IMPORT_PLATFORMS.has(raw.platform)) throw fail('Platform must be wechat, qq or manual.');
      const account = stringField(raw.account, 'Account', 256).trim();
      const conversation = stringField(raw.conversation, 'Conversation', 256).trim();
      const sender = stringField(raw.sender, 'Sender', 256).trim();
      const sentAt = validInstant(raw.sentAt, 'Message sentAt');
      const text = stringField(raw.text, 'Message text', 20_000);
      if (Date.parse(sentAt) > nowTime + DAY) throw fail('A message is more than one day in the future.');
      const id = hash([raw.platform, account, conversation, sourceId]);
      return { id, sourceId, platform: raw.platform, account, conversation, sender, sentAt, text };
    });
    return this.#transaction(() => {
      let imported = 0, duplicates = 0, skippedOld = 0;
      for (const message of normalized) {
        if (Date.parse(message.sentAt) < nowTime - 30 * DAY) { skippedOld++; continue; }
        const payload = JSON.stringify(message);
        const evidenceHash = hash(payload);
        const existing = this.#db.prepare('SELECT evidence_hash FROM messages WHERE id = ?').get(message.id);
        if (existing) {
          if (existing.evidence_hash !== evidenceHash) throw fail('An existing message identity has different evidence. Import was cancelled.', 409);
          duplicates++;
          continue;
        }
        const proposal = normalizeProposal(this.#analyzer(structuredClone(message), { now }));
        const draft = { id: randomUUID(), messageId: message.id, revision: 1, ...proposal, status: 'review', createdAt: now, updatedAt: now };
        this.#db.prepare('INSERT INTO messages(id,evidence_hash,payload) VALUES (?,?,?)').run(message.id, evidenceHash, payload);
        this.#db.prepare('INSERT INTO drafts(id,message_id,revision,status,payload) VALUES (?,?,?,?,?)')
          .run(draft.id, message.id, draft.revision, draft.status, JSON.stringify(draft));
        imported++;
      }
      return { imported, duplicates, skippedOld };
    });
  }

  edit(id, patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw fail('An edit patch is required.');
    if (Object.keys(patch).some(key => !EDIT_FIELDS.has(key))) throw fail('The edit contains an unsupported field.');
    return this.#transaction(() => {
      const draft = this.#draft(id, patch.revision, ['review', 'approved']);
      const edited = { ...draft, revision: draft.revision + 1, status: 'review', updatedAt: this.#now() };
      for (const name of ['title', 'action', 'location']) {
        if (Object.hasOwn(patch, name)) edited[name] = name === 'location' && patch[name] == null
          ? null : stringField(patch[name], name, name === 'action' ? 4000 : 500, { empty: true });
      }
      for (const field of DATE_FIELDS) if (Object.hasOwn(patch, field)) edited[field] = draftDate(patch[field], field);
      if (Object.hasOwn(patch, 'participating')) {
        if (typeof patch.participating !== 'boolean') throw fail('Participation must be true or false.');
        edited.participating = patch.participating;
      }
      validateDates(edited);
      this.#putDraft(edited);
      return structuredClone(edited);
    });
  }

  approve(id, request, config = { configured: false }) {
    return this.#transaction(() => {
      const draft = this.#draft(id, request?.revision, ['review']);
      if (!draft.title.trim() || !draft.action.trim()) throw fail('Review a title and concrete action before approval.');
      if (!draft.officialStart && !draft.deadline) throw fail('Set an official start or deadline before approval.');
      if (request?.participating !== undefined && typeof request.participating !== 'boolean') throw fail('Participation must be true or false.');
      const participating = request?.participating ?? draft.participating;
      if (draft.category === 'optional_recruitment' && participating !== true) throw fail('Explicit participation is required for an optional opportunity.');
      const now = this.#now();
      const approved = { ...draft, participating, status: 'approved', updatedAt: now };
      const messageRow = this.#db.prepare('SELECT * FROM messages WHERE id = ?').get(draft.messageId);
      if (!messageRow || hash(messageRow.payload) !== messageRow.evidence_hash) throw fail('Source evidence could not be verified.', 409);
      const snapshot = { draft: draftSnapshot(approved), message: JSON.parse(messageRow.payload), destination: destinationIdentity(config) };
      const snapshotJson = JSON.stringify(snapshot);
      const approvalId = randomUUID();
      this.#db.prepare('INSERT INTO approvals(id,draft_id,revision,created_at,evidence_hash,snapshot_hash,snapshot) VALUES (?,?,?,?,?,?,?)')
        .run(approvalId, id, draft.revision, now, messageRow.evidence_hash, hash(snapshotJson), snapshotJson);
      this.#putDraft(approved);
      return { draft: structuredClone(approved), approvalId };
    });
  }

  dismiss(id, request) {
    return this.#transaction(() => {
      const draft = this.#draft(id, request?.revision, ['review', 'approved']);
      const dismissed = { ...draft, status: 'dismissed', updatedAt: this.#now() };
      this.#putDraft(dismissed);
      return structuredClone(dismissed);
    });
  }

  preview(id, request, config) {
    const { approvalId, snapshot } = this.#approved(id, request?.revision, config);
    return { draftId: id, revision: request.revision, approvalId, configured: Boolean(config?.configured),
      payload: buildNotionPayload(snapshot.draft, snapshot.message, config) };
  }

  async sync(id, request, config, { sender = sendToNotion } = {}) {
    if (!config?.configured) throw fail('Notion is not configured. Preview is available; no remote transfer was attempted.');
    if (typeof sender !== 'function') throw fail('A transfer sender is required.');
    const handoff = this.#transaction(() => {
      const { draft, approvalId, snapshot } = this.#approved(id, request?.revision, config);
      const payload = buildNotionPayload(snapshot.draft, snapshot.message, config);
      const now = this.#now();
      const handoffId = randomUUID();
      this.#db.prepare('INSERT INTO handoffs(id,draft_id,revision,approval_id,status,created_at,updated_at,payload) VALUES (?,?,?,?,?,?,?,?)')
        .run(handoffId, id, draft.revision, approvalId, 'syncing', now, now, JSON.stringify(payload));
      this.#putDraft({ ...draft, status: 'syncing', updatedAt: now });
      return { id: handoffId, payload, revision: draft.revision };
    });
    this.#activeSyncs++;
    try {
      let result;
      try {
        result = await sender(handoff.payload, config);
        if (!result || typeof result.id !== 'string' || !PAGE_ID.test(result.id)) {
          const invalid = new Error('Unverified result');
          invalid.uncertain = true;
          throw invalid;
        }
        result = { id: result.id, url: validateNotionURL(result.url) };
      } catch (error) {
        const uncertain = error?.uncertain !== false;
        const message = uncertain
          ? 'The remote result is uncertain. Verify Notion manually before another transfer.'
          : 'Notion rejected this attempt. Check the configuration before a new manual transfer.';
        this.#transaction(() => {
          const draft = this.#draft(id, handoff.revision, ['syncing']);
          const now = this.#now();
          this.#db.prepare('UPDATE handoffs SET status = ?, updated_at = ?, error = ? WHERE id = ?')
            .run(uncertain ? 'uncertain' : 'failed', now, message, handoff.id);
          this.#putDraft({ ...draft, status: uncertain ? 'uncertain' : 'approved', updatedAt: now });
        });
        const reported = fail(message, uncertain ? 409 : 502);
        reported.uncertain = uncertain;
        throw reported;
      }
      this.#transaction(() => {
        const draft = this.#draft(id, handoff.revision, ['syncing']);
        const now = this.#now();
        this.#db.prepare("UPDATE handoffs SET status = 'synced', updated_at = ?, result = ? WHERE id = ?")
          .run(now, JSON.stringify(result), handoff.id);
        this.#putDraft({ ...draft, status: 'synced', updatedAt: now });
      });
      return { handoffId: handoff.id, status: 'synced', ...result };
    } finally {
      this.#activeSyncs--;
    }
  }

  close() {
    if (this.#activeSyncs) throw fail('A transfer is still in progress; do not close the store before it finishes.', 409);
    if (!this.#closed) { this.#db.close(); this.#closed = true; }
  }
}
