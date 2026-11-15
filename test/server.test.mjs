import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRelayServer } from '../src/server.mjs';
import { RelayStore } from '../src/store.mjs';

async function fixture(t) {
  let imports = 0;
  const store = {
    state: () => ({ messages: [], drafts: [], approvals: [], handoffs: [] }),
    importMessages: () => ({ imported: ++imports, duplicates: 0, skippedOld: 0 })
  };
  const server = createRelayServer({ store, env: {}, clock: () => new Date('2026-11-15T08:00:00Z') });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const state = await fetch(`${base}/api/state`).then(r => r.json());
  return { server, base, state, imports: () => imports };
}

test('local state exposes no provider credentials and starts with Notion disabled', async t => {
  const { base, state } = await fixture(t);
  assert.equal(state.notion.configured, false);
  assert.equal(Object.hasOwn(state.notion, 'token'), false);
  assert.equal(state.timezone, 'Asia/Shanghai');
  assert.equal(state.csrfToken.length, 64);
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(await page.text(), /Signal Desk Relay/);
});

test('mutations require both the local origin and a current unpredictable CSRF token', async t => {
  const { base, state, imports } = await fixture(t);
  const body = JSON.stringify({ messages: [] });
  const headers = { 'Content-Type': 'application/json' };
  assert.equal((await fetch(`${base}/api/import`, { method: 'POST', headers, body })).status, 403);
  headers['X-CSRF-Token'] = state.csrfToken;
  headers.Origin = 'https://untrusted.invalid';
  assert.equal((await fetch(`${base}/api/import`, { method: 'POST', headers, body })).status, 403);
  assert.equal(imports(), 0);
  headers.Origin = base;
  assert.equal((await fetch(`${base}/api/import`, { method: 'POST', headers, body })).status, 200);
  assert.equal(imports(), 1);
});

test('JSON content type, malformed requests, unknown paths and file traversal are rejected', async t => {
  const { base, state } = await fixture(t);
  const headers = { 'X-CSRF-Token': state.csrfToken, 'Content-Type': 'text/plain' };
  assert.equal((await fetch(`${base}/api/import`, { method: 'POST', headers, body: '{}' })).status, 415);
  headers['Content-Type'] = 'application/json';
  assert.equal((await fetch(`${base}/api/import`, { method: 'POST', headers, body: '{' })).status, 400);
  assert.equal((await fetch(`${base}/api/import`, { method: 'POST', headers, body: 'null' })).status, 400);
  assert.equal((await fetch(`${base}/api/import`, { method: 'POST', headers, body: 'x'.repeat(2 * 1024 * 1024 + 1) })).status, 413);
  assert.equal((await fetch(`${base}/.env`)).status, 404);
  assert.equal((await fetch(`${base}/%2e%2e/package.json`)).status, 404);
});

test('HTTP review flow preserves evidence, rejects stale approval, and previews without remote writes', async t => {
  const clock = () => new Date('2026-11-15T08:00:00Z');
  const store = new RelayStore(':memory:', { clock });
  const server = createRelayServer({ store, env: {}, clock });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const initial = await fetch(`${base}/api/state`).then(r => r.json());
  const post = async (path, body) => {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base, 'X-CSRF-Token': initial.csrfToken },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const examples = await fetch(`${base}/api/example`).then(r => r.json());
  const imported = await post('/api/import', { messages: examples });
  assert.equal(imported.status, 200);
  assert.equal(imported.body.imported, examples.length);
  assert.equal(imported.body.drafts.length, examples.length);
  assert.equal((await post('/api/import', { messages: examples })).body.duplicates, examples.length);
  const message = imported.body.messages.find(m => m.sourceId === 'fictional-report-20261115');
  const draft = imported.body.drafts.find(d => d.messageId === message.id);
  const path = `/api/drafts/${draft.id}`;
  const edited = await post(`${path}/edit`, { revision: draft.revision, title: 'Reviewed fictional report' });
  assert.equal(edited.status, 200);
  assert.equal((await post(`${path}/approve`, { revision: draft.revision })).status, 409);
  const revision = draft.revision + 1;
  const approved = await post(`${path}/approve`, { revision });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.approvals[0].snapshot.message.text, message.text);
  const preview = await post(`${path}/sync`, { revision, mode: 'preview' });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.configured, false);
  assert.match(JSON.stringify(preview.body.payload), /Reviewed fictional report/);
  assert.match(JSON.stringify(preview.body.payload), /示例设计课/);
  const blocked = await post(`${path}/sync`, { revision, mode: 'live' });
  assert.equal(blocked.status, 400);
  assert.match(blocked.body.error, /not configured/);
  assert.equal(store.state().handoffs.length, 0);
  assert.equal(store.state().drafts.find(d => d.id === draft.id).status, 'approved');
  const uncertain = imported.body.drafts.find(d => !d.officialStart && !d.deadline);
  assert.ok(uncertain);
  assert.equal((await post(`/api/drafts/${uncertain.id}/approve`, { revision: uncertain.revision })).status, 400);
});

test('a second server cannot recover or alter a live instance database', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'signal-relay-http-'));
  const server = createRelayServer({ env: { SIGNAL_RELAY_DATA_DIR: directory } });
  t.after(() => {
    assert.equal(existsSync(join(directory, 'instance.lock')), false);
    rmSync(directory, { recursive: true, force: true });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    assert.equal(existsSync(join(directory, 'instance.lock')), true);
    assert.throws(() => createRelayServer({ env: { SIGNAL_RELAY_DATA_DIR: directory } }), /数据目录已被占用/);
    const state = await fetch(`http://127.0.0.1:${server.address().port}/api/state`).then(r => r.json());
    assert.equal(state.messages.length, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
  const reopened = createRelayServer({ env: { SIGNAL_RELAY_DATA_DIR: directory } });
  reopened.listen(0, '127.0.0.1');
  await once(reopened, 'listening');
  await new Promise(resolve => reopened.close(resolve));
});
