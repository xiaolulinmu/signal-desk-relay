import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RelayStore, destinationIdentity } from '../src/store.mjs';
import { notionConfiguration } from '../src/notion.mjs';

const now = '2026-11-15T08:00:00.000Z';
const source = { id: 'source-1', platform: 'manual', account: 'demo', conversation: 'Fictional group', sender: 'Demo coordinator', sentAt: '2026-11-15T10:00:00+08:00', text: 'Submit the fictional form by 2026-11-17 17:00.' };
const proposal = { category: 'mandatory_task', title: 'Fictional form', action: 'Submit the fictional form', summary: 'A test-only notice', importance: 'high', officialStart: null, officialEnd: null, deadline: '2026-11-17T17:00:00+08:00', location: null, reasons: ['Explicit action and deadline'], needsReview: true };
const config = notionConfiguration({ SIGNAL_RELAY_NOTION_TOKEN: 'synthetic-only-token', SIGNAL_RELAY_NOTION_DATA_SOURCE_ID: '00000000-0000-4000-8000-000000000001' });
const remote = { id: '00000000-0000-4000-8000-000000000002', url: 'https://app.notion.com/p/00000000-0000-4000-8000-000000000002' };
function makeStore(options = {}) { return new RelayStore(':memory:', { clock: () => new Date(now), analyzer: () => structuredClone(proposal), ...options }); }
function draftOf(store) { return store.state().drafts[0]; }
function ready(store, destination = config) { store.importMessages([source]); const draft = draftOf(store); store.approve(draft.id, { revision: draft.revision }, destination); return draftOf(store); }

test('imports preserve immutable source evidence and always create a review proposal', () => {
  const store = makeStore({ analyzer: message => { message.text = 'Analyzer attempted mutation'; return { ...proposal, needsReview: false }; } });
  assert.deepEqual(store.importMessages([source]), { imported: 1, duplicates: 0, skippedOld: 0 });
  const state = store.state();
  assert.equal(state.messages[0].sourceId, source.id);
  assert.equal(state.messages[0].text, source.text);
  assert.notEqual(state.messages[0].id, source.id);
  assert.equal(state.drafts[0].messageId, state.messages[0].id);
  assert.equal(state.drafts[0].status, 'review');
  assert.equal(state.drafts[0].revision, 1);
  assert.equal(state.drafts[0].needsReview, true);
  state.messages[0].text = 'State mutation is also isolated';
  assert.equal(store.state().messages[0].text, source.text);
  store.close();
});

test('deduplication includes platform, account, conversation and source id', () => {
  const store = makeStore();
  store.importMessages([source]);
  assert.deepEqual(store.importMessages([source]), { imported: 0, duplicates: 1, skippedOld: 0 });
  assert.equal(store.importMessages([{ ...source, platform: 'qq' }, { ...source, account: 'second' }, { ...source, conversation: 'Second group' }]).imported, 3);
  assert.equal(store.state().messages.length, 4);
  store.close();
});

test('changed evidence under the same identity rejects the entire transaction', () => {
  const store = makeStore();
  store.importMessages([source]);
  assert.throws(() => store.importMessages([{ ...source, id: 'new-message' }, { ...source, text: 'Changed notice' }]), { status: 409 });
  assert.equal(store.state().messages.length, 1);
  assert.throws(() => store.importMessages([{ ...source, sender: 'Other sender' }]), { status: 409 });
  store.close();
});

test('whole batch validates before writes; malformed, oversized and future input is rejected', () => {
  const store = makeStore();
  for (const invalid of [
    { ...source, text: '' }, { ...source, text: 'x'.repeat(20001) }, { ...source, platform: 'unknown' },
    { ...source, sentAt: '2026-11-15 10:00' }, { ...source, sentAt: '2026-02-31T10:00:00+08:00' },
    { ...source, sentAt: '2026-11-17T10:00:00+08:00' },
  ]) {
    assert.throws(() => store.importMessages([source, invalid]));
    assert.equal(store.state().messages.length, 0);
  }
  assert.throws(() => store.importMessages(Array.from({ length: 501 }, () => source)));
  assert.throws(() => store.importMessages(Array.from({ length: 120 }, (_, index) => ({ ...source, id: String(index), text: 'x'.repeat(20000) }))));
  store.close();
});

test('old messages are skipped, with the exact 30-day boundary included', () => {
  const store = makeStore();
  const boundary = new Date(Date.parse(now) - 30 * 86400000).toISOString();
  const old = new Date(Date.parse(boundary) - 1).toISOString();
  assert.deepEqual(store.importMessages([{ ...source, id: 'old', sentAt: old }, { ...source, id: 'boundary', sentAt: boundary }]), { imported: 1, duplicates: 0, skippedOld: 1 });
  store.close();
});

test('an invalid analyzer proposal rolls back every message in the batch', () => {
  let calls = 0;
  const store = makeStore({ analyzer: () => ++calls === 1 ? proposal : { ...proposal, category: 'invented' } });
  assert.throws(() => store.importMessages([source, { ...source, id: 'second' }]));
  assert.equal(store.state().messages.length, 0);
  store.close();
});

test('approval requires a concrete action and time, and optional participation is explicit', () => {
  const empty = makeStore({ analyzer: () => ({ ...proposal, action: '', deadline: null }) });
  empty.importMessages([source]);
  const draft = draftOf(empty);
  assert.throws(() => empty.approve(draft.id, { revision: 1 }));
  const edited = empty.edit(draft.id, { revision: 1, action: 'Review and act' });
  assert.throws(() => empty.approve(draft.id, { revision: edited.revision }));
  empty.close();
  const optional = makeStore({ analyzer: () => ({ ...proposal, category: 'optional_recruitment' }) });
  optional.importMessages([source]);
  const opportunity = draftOf(optional);
  assert.throws(() => optional.approve(opportunity.id, { revision: 1 }));
  assert.equal(optional.approve(opportunity.id, { revision: 1, participating: true }).draft.participating, true);
  assert.throws(() => optional.approve(opportunity.id, { revision: 1, participating: true }), { status: 409 });
  optional.close();
});

test('editing increments revision, preserves old approval and invalidates it for transfer', () => {
  const store = makeStore();
  const draft = ready(store);
  const originalApproval = store.state().approvals[0];
  assert.throws(() => store.edit(draft.id, { revision: 0, title: 'Changed' }));
  const edited = store.edit(draft.id, { revision: 1, title: 'Reviewed new title', officialStart: '2026-11-16 09:00', officialEnd: '2026-11-16 10:00' });
  assert.equal(edited.revision, 2);
  assert.equal(edited.status, 'review');
  assert.equal(edited.officialStart, '2026-11-16T01:00:00.000Z');
  assert.deepEqual(store.state().approvals[0], originalApproval);
  assert.throws(() => store.preview(draft.id, { revision: 1 }, config), { status: 409 });
  assert.throws(() => store.preview(draft.id, { revision: 2 }, config), { status: 409 });
  store.approve(draft.id, { revision: 2 }, config);
  assert.equal(store.state().approvals.length, 2);
  assert.equal(store.preview(draft.id, { revision: 2 }, config).payload.properties.Name.title[0].text.content, edited.title);
  store.close();
});

test('invalid edits do not alter revision or approval; unknown edit fields are refused', () => {
  const store = makeStore();
  const draft = ready(store);
  for (const patch of [{ deadline: '2026-02-31 12:00' }, { officialEnd: '2026-11-17 12:00' }, { category: 'mandatory_event' }, { participating: 'true' }]) {
    assert.throws(() => store.edit(draft.id, { revision: 1, ...patch }));
    assert.equal(draftOf(store).revision, 1);
    assert.equal(draftOf(store).status, 'approved');
  }
  store.close();
});

test('preview is read-only and unconfigured synchronization never calls a sender', async () => {
  const store = makeStore();
  const draft = ready(store, notionConfiguration({}));
  const preview = store.preview(draft.id, { revision: 1 }, notionConfiguration({}));
  assert.equal(preview.configured, false);
  assert.equal(preview.payload.parent.data_source_id, '');
  assert.equal(store.state().handoffs.length, 0);
  let calls = 0;
  await assert.rejects(store.sync(draft.id, { revision: 1 }, notionConfiguration({}), { sender: () => { calls++; } }));
  assert.equal(calls, 0);
  assert.equal(draftOf(store).status, 'approved');
  store.close();
});

test('approval freezes a public destination identity, excluding its credential', () => {
  const store = makeStore();
  const draft = ready(store);
  const snapshot = store.state().approvals[0].snapshot;
  assert.deepEqual(snapshot.destination, destinationIdentity(config));
  assert.equal(JSON.stringify(snapshot).includes(config.token), false);
  assert.equal(Object.hasOwn(snapshot.destination, 'token'), false);
  assert.equal(store.preview(draft.id, { revision: 1 }, { ...config, token: 'rotated-synthetic-token' }).configured, true);
  store.close();
});

test('an approval made while unconfigured cannot transfer after a destination is added', async () => {
  const store = makeStore();
  const draft = ready(store, { configured: false });
  assert.deepEqual(destinationIdentity(), destinationIdentity(notionConfiguration({})));
  assert.equal(store.preview(draft.id, { revision: 1 }, notionConfiguration({})).configured, false);
  let calls = 0;
  assert.throws(() => store.preview(draft.id, { revision: 1 }, config), { status: 409 });
  await assert.rejects(store.sync(draft.id, { revision: 1 }, config, { sender: async () => { calls++; return remote; } }), { status: 409 });
  assert.equal(calls, 0);
  assert.equal(store.state().handoffs.length, 0);
  const edited = store.edit(draft.id, { revision: 1 });
  store.approve(draft.id, { revision: edited.revision }, config);
  await store.sync(draft.id, { revision: edited.revision }, config, { sender: async () => { calls++; return remote; } });
  assert.equal(calls, 1);
  store.close();
});

test('changed data source and property mappings are blocked after a database restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'signal-relay-destination-test-'));
  const database = join(directory, 'test.sqlite');
  try {
    const options = { clock: () => new Date(now), analyzer: () => proposal };
    const store = new RelayStore(database, options);
    const draft = ready(store);
    store.close();
    const reopened = new RelayStore(database, options);
    let calls = 0;
    for (const changed of [
      { ...config, dataSourceId: '00000000-0000-4000-8000-000000000003' },
      { ...config, titleProperty: '事项' },
      { ...config, dateProperty: '日期' },
      { ...config, deadlineProperty: '截止' },
      { ...config, configured: false },
    ]) {
      assert.throws(() => reopened.preview(draft.id, { revision: 1 }, changed), { status: 409 });
      await assert.rejects(reopened.sync(draft.id, { revision: 1 }, changed, { sender: async () => { calls++; return remote; } }));
    }
    assert.equal(calls, 0);
    assert.equal(reopened.state().handoffs.length, 0);
    assert.equal(draftOf(reopened).status, 'approved');
    assert.equal(reopened.preview(draft.id, { revision: 1 }, config).configured, true);
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('successful transfer is durable before awaiting, blocks concurrent actions and cannot repeat', async () => {
  const store = makeStore();
  const draft = ready(store);
  let finish;
  let calls = 0;
  const attempt = store.sync(draft.id, { revision: 1 }, config, { sender: async payload => {
    calls++;
    assert.equal(store.state().handoffs[0].status, 'syncing');
    assert.equal(draftOf(store).status, 'syncing');
    assert.equal(payload.properties.Name.title[0].text.content, draft.title);
    return new Promise(resolve => { finish = resolve; });
  } });
  assert.throws(() => store.edit(draft.id, { revision: 1, title: 'During transfer' }), { status: 409 });
  assert.throws(() => store.dismiss(draft.id, { revision: 1 }), { status: 409 });
  assert.throws(() => store.close(), { status: 409 });
  await assert.rejects(store.sync(draft.id, { revision: 1 }, config, { sender: async () => remote }), { status: 409 });
  finish(remote);
  assert.equal((await attempt).status, 'synced');
  assert.equal(draftOf(store).status, 'synced');
  assert.equal(store.state().handoffs[0].result.id, remote.id);
  await assert.rejects(store.sync(draft.id, { revision: 1 }, config, { sender: async () => remote }), { status: 409 });
  assert.equal(calls, 1);
  store.close();
});

test('unknown results block repeated creates; provider diagnostics and tokens are not persisted', async () => {
  const store = makeStore();
  const draft = ready(store);
  let calls = 0;
  await assert.rejects(store.sync(draft.id, { revision: 1 }, config, { sender: async () => { calls++; throw new Error(`Provider detail ${config.token}`); } }), { uncertain: true });
  assert.equal(draftOf(store).status, 'uncertain');
  assert.equal(store.state().handoffs[0].status, 'uncertain');
  assert.equal(JSON.stringify(store.state()).includes(config.token), false);
  await assert.rejects(store.sync(draft.id, { revision: 1 }, config, { sender: async () => { calls++; return remote; } }), { status: 409 });
  assert.equal(calls, 1);
  store.close();
});

test('a known rejected attempt allows a separate explicit manual attempt', async () => {
  const store = makeStore();
  const draft = ready(store);
  await assert.rejects(store.sync(draft.id, { revision: 1 }, config, { sender: async () => {
    const error = new Error('not authorized'); error.uncertain = false; throw error;
  } }), { uncertain: false });
  assert.equal(draftOf(store).status, 'approved');
  assert.equal(store.state().handoffs[0].status, 'failed');
  await store.sync(draft.id, { revision: 1 }, config, { sender: async () => remote });
  assert.equal(store.state().handoffs.length, 2);
  assert.equal(draftOf(store).status, 'synced');
  store.close();
});

test('dismissed drafts cannot be approved or transferred', async () => {
  const store = makeStore();
  const draft = ready(store);
  store.dismiss(draft.id, { revision: 1 });
  assert.equal(draftOf(store).status, 'dismissed');
  assert.throws(() => store.approve(draft.id, { revision: 1 }), { status: 409 });
  await assert.rejects(store.sync(draft.id, { revision: 1 }, config, { sender: async () => remote }), { status: 409 });
  store.close();
});

test('reopening persisted in-flight records changes them to uncertain without any remote request', () => {
  const directory = mkdtempSync(join(tmpdir(), 'signal-relay-store-test-'));
  const database = join(directory, 'test.sqlite');
  try {
    const options = { clock: () => new Date(now), analyzer: () => proposal };
    const store = new RelayStore(database, options);
    const draft = ready(store);
    const state = store.state();
    store.close();
    const db = new DatabaseSync(database);
    const payload = { ...draft, status: 'syncing' };
    db.prepare("UPDATE drafts SET status = 'syncing', payload = ? WHERE id = ?").run(JSON.stringify(payload), draft.id);
    db.prepare('INSERT INTO handoffs(id,draft_id,revision,approval_id,status,created_at,updated_at,payload) VALUES (?,?,?,?,?,?,?,?)')
      .run('interrupted-attempt', draft.id, 1, state.approvals[0].id, 'syncing', now, now, '{}');
    db.close();
    const reopened = new RelayStore(database, options);
    assert.equal(draftOf(reopened).status, 'uncertain');
    assert.equal(reopened.state().handoffs[0].status, 'uncertain');
    assert.throws(() => reopened.preview(draft.id, { revision: 1 }, config), { status: 409 });
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('evidence tampering invalidates an existing approval before any remote call', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'signal-relay-tamper-test-'));
  const database = join(directory, 'test.sqlite');
  try {
    const options = { clock: () => new Date(now), analyzer: () => proposal };
    const store = new RelayStore(database, options);
    const draft = ready(store);
    const message = store.state().messages[0];
    store.close();
    const db = new DatabaseSync(database);
    db.prepare('UPDATE messages SET payload = ? WHERE id = ?').run(JSON.stringify({ ...message, text: 'tampered' }), message.id);
    db.close();
    const reopened = new RelayStore(database, options);
    let calls = 0;
    await assert.rejects(reopened.sync(draft.id, { revision: 1 }, config, { sender: async () => { calls++; return remote; } }), { status: 409 });
    assert.equal(calls, 0);
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
