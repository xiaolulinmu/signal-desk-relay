import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNotionPayload, notionConfiguration, NOTION_API_VERSION, sendToNotion, validateNotionURL } from '../src/notion.mjs';

const target = '00000000-0000-4000-8000-000000000001';
const pageId = '00000000-0000-4000-8000-000000000002';
const config = notionConfiguration({ SIGNAL_RELAY_NOTION_TOKEN: 'synthetic-test-token', SIGNAL_RELAY_NOTION_DATA_SOURCE_ID: target });
const message = { id: 'example-1', platform: 'manual', account: 'demo', conversation: 'Fictional class', sender: 'Demo coordinator', sentAt: '2026-11-15T10:00:00+08:00', text: 'Bring your form. <script>alert(1)</script> https://untrusted.example/path' };
const draft = { id: 'draft-1', revision: 2, title: 'Submit the fictional form', action: 'Review form before submission', summary: 'Synthetic mandatory form reminder', category: 'mandatory_task', importance: 'high', officialStart: null, officialEnd: null, deadline: '2026-11-17T17:00:00+08:00', location: null };

test('configuration defaults to disabled and does not import any local credentials', () => {
  assert.equal(notionConfiguration({}).configured, false);
  assert.equal(notionConfiguration({}).token, '');
  assert.equal(config.configured, true);
  assert.equal(notionConfiguration({ SIGNAL_RELAY_NOTION_TOKEN: 'x', SIGNAL_RELAY_NOTION_DATA_SOURCE_ID: 'bad-target' }).configured, false);
  assert.equal(notionConfiguration({ SIGNAL_RELAY_NOTION_TOKEN: 'x\nAuthorization: leaked', SIGNAL_RELAY_NOTION_DATA_SOURCE_ID: target }).configured, false);
});

test('preview has evidence and dates without turning untrusted text into rich links or markup', () => {
  const payload = buildNotionPayload(draft, message, config);
  assert.deepEqual(payload.parent, { type: 'data_source_id', data_source_id: target });
  assert.equal(payload.properties.Name.title[0].text.content, draft.title);
  assert.equal(payload.properties.Planned, undefined);
  assert.equal(payload.properties.Deadline.date.start, draft.deadline);
  const allText = payload.children.flatMap(block => block.paragraph.rich_text.map(r => r.text.content));
  assert.ok(allText.some(text => text.includes('draft draft-1 | revision 2')));
  assert.ok(allText.some(text => text.includes('Fictional class')));
  assert.ok(allText.some(text => text.includes(message.text)));
  assert.ok(payload.children.every(block => block.type === 'paragraph' && block.paragraph.rich_text.every(r => !r.text.link && !r.href)));
  assert.equal(JSON.stringify(payload).includes(config.token), false);
});

test('source message id and local evidence id remain distinguishable', () => {
  const payload = buildNotionPayload(draft, { ...message, id: 'internal-fingerprint', sourceId: 'original-message-id' }, config);
  const text = payload.children.flatMap(block => block.paragraph.rich_text.map(r => r.text.content)).join('\n');
  assert.match(text, /Message ID: original-message-id \| Evidence ID: internal-fingerprint/);
});

test('preview can be made unconfigured, with an explicitly empty target', () => {
  const payload = buildNotionPayload(draft, message);
  assert.equal(payload.parent.data_source_id, '');
});

test('all evidence is preserved in bounded plain paragraphs, including astral characters', () => {
  const text = '💫'.repeat(10_000);
  const payload = buildNotionPayload(draft, { ...message, text }, config);
  const lastParts = payload.children.slice(9).map(block => block.paragraph.rich_text[0].text.content);
  assert.equal(lastParts.join(''), text);
  assert.ok(lastParts.every(part => part.length <= 2000 && !/[\uD800-\uDBFF]$/.test(part)));
});

test('explicit dates retain timezone; invalid dates and backwards ranges are rejected', () => {
  const payload = buildNotionPayload({ ...draft, officialStart: '2026-11-18T09:00:00+08:00', officialEnd: '2026-11-18T10:00:00+08:00' }, message, config);
  assert.deepEqual(payload.properties.Planned.date, { start: '2026-11-18T09:00:00+08:00', end: '2026-11-18T10:00:00+08:00' });
  for (const deadline of ['2026-11-17 17:00', '2026-02-31T12:00:00+08:00', '2026-11-17T25:00:00+08:00', '2026-11-17T17:00:00+14:01']) {
    assert.throws(() => buildNotionPayload({ ...draft, deadline }, message, config));
  }
  assert.throws(() => buildNotionPayload({ ...draft, officialEnd: '2026-11-18T10:00:00+08:00' }, message, config));
  assert.throws(() => buildNotionPayload({ ...draft, officialStart: '2026-11-18T12:00:00+08:00', officialEnd: '2026-11-18T10:00:00+08:00' }, message, config));
});

test('property overrides are supported, but collisions cannot replace the title', () => {
  const override = notionConfiguration({ SIGNAL_RELAY_NOTION_TOKEN: 'test', SIGNAL_RELAY_NOTION_DATA_SOURCE_ID: target, SIGNAL_RELAY_NOTION_TITLE_PROPERTY: '事项', SIGNAL_RELAY_NOTION_DATE_PROPERTY: '计划', SIGNAL_RELAY_NOTION_DEADLINE_PROPERTY: '截止' });
  const payload = buildNotionPayload(draft, message, override);
  assert.equal(payload.properties['事项'].title[0].text.content, draft.title);
  assert.ok(payload.properties['截止']);
  assert.equal(notionConfiguration({ SIGNAL_RELAY_NOTION_TITLE_PROPERTY: 'Deadline' }).configured, false);
  assert.throws(() => buildNotionPayload(draft, message, { ...config, titleProperty: 'Deadline' }));
});

test('an unconfigured or mismatched target never calls fetch', async () => {
  let calls = 0;
  const fetchImpl = () => { calls++; throw new Error('should not be called'); };
  await assert.rejects(sendToNotion(buildNotionPayload(draft, message), notionConfiguration({}), { fetchImpl }), { uncertain: false });
  await assert.rejects(sendToNotion(buildNotionPayload(draft, message), config, { fetchImpl }), { uncertain: false });
  assert.equal(calls, 0);
});

test('one approved call uses fixed endpoint, fixed API version, no redirects and no retries', async () => {
  let calls = 0;
  const payload = buildNotionPayload(draft, message, config);
  const result = await sendToNotion(payload, config, { fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.notion.com/v1/pages');
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers['Notion-Version'], NOTION_API_VERSION);
    assert.equal(options.headers.Authorization, `Bearer ${config.token}`);
    assert.ok(options.signal instanceof AbortSignal);
    assert.deepEqual(JSON.parse(options.body), JSON.parse(JSON.stringify(payload)));
    return { ok: true, status: 200, json: async () => ({ object: 'page', id: pageId, url: `https://app.notion.com/p/${pageId}` }) };
  } });
  assert.deepEqual(result, { id: pageId, url: `https://app.notion.com/p/${pageId}` });
  assert.equal(calls, 1);
});

test('network/timeout failures are uncertain and do not expose provider errors or tokens', async () => {
  for (const name of ['AbortError', 'TypeError']) {
    let calls = 0;
    await assert.rejects(sendToNotion(buildNotionPayload(draft, message, config), config, { fetchImpl: async () => {
      calls++;
      const error = new Error(`untrusted provider diagnostic ${config.token}`);
      error.name = name;
      throw error;
    } }), error => {
      assert.equal(error.uncertain, true);
      assert.equal(error.message.includes(config.token), false);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('5xx is uncertain, 4xx is a rejected attempt, response bodies are not logged or retried', async () => {
  for (const status of [400, 401, 403, 409, 429, 500, 503]) {
    let calls = 0;
    await assert.rejects(sendToNotion(buildNotionPayload(draft, message, config), config, { fetchImpl: async () => {
      calls++;
      return { ok: false, status, json: () => { throw new Error('Response body must not be read.'); } };
    } }), error => {
      assert.equal(error.uncertain, status >= 500);
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      assert.equal(error.message.includes(config.token), false);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('malformed success is uncertain; a valid page with an unsafe URL returns no link', async () => {
  const payload = buildNotionPayload(draft, message, config);
  for (const result of [{ object: 'page', id: 'garbage' }, { object: 'database', id: pageId }]) {
    await assert.rejects(sendToNotion(payload, config, { fetchImpl: async () => ({ ok: true, json: async () => result }) }), { uncertain: true });
  }
  const result = await sendToNotion(payload, config, { fetchImpl: async () => ({ ok: true, json: async () => ({ object: 'page', id: pageId, url: 'https://attacker.example/' }) }) });
  assert.deepEqual(result, { id: pageId, url: null });
});

test('page links use exact HTTPS host allowlist', () => {
  for (const url of ['https://notion.so/page', 'https://www.notion.so/page', 'https://notion.site/page', 'https://app.notion.com/p/page']) assert.equal(validateNotionURL(url), url);
  for (const url of ['http://notion.so/page', 'https://notion.so.attacker.example/page', 'https://attacker.example/?next=notion.so', 'https://user:password@notion.so/page', 'javascript:alert(1)', 'https://notion.so:8443/page']) assert.equal(validateNotionURL(url), null);
});
