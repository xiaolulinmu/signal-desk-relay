/** Explicit, single-attempt Notion page transfer. No polling or background writes. */
export const NOTION_API_VERSION = '2026-03-11';
const PAGE_ENDPOINT = 'https://api.notion.com/v1/pages';
const ID_PATTERN = /^(?:[\da-f]{32}|[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})$/i;
const SAFE_PAGE_HOSTS = new Set(['notion.so', 'www.notion.so', 'notion.site', 'app.notion.com']);

function fieldName(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

/** Keep this object server-side: token must never be returned by an HTTP route. */
export function notionConfiguration(env = process.env) {
  const token = typeof env.SIGNAL_RELAY_NOTION_TOKEN === 'string'
    ? env.SIGNAL_RELAY_NOTION_TOKEN.trim() : '';
  const dataSourceId = typeof env.SIGNAL_RELAY_NOTION_DATA_SOURCE_ID === 'string'
    ? env.SIGNAL_RELAY_NOTION_DATA_SOURCE_ID.trim() : '';
  const titleProperty = fieldName(env.SIGNAL_RELAY_NOTION_TITLE_PROPERTY, 'Name');
  const dateProperty = fieldName(env.SIGNAL_RELAY_NOTION_DATE_PROPERTY, 'Planned');
  const deadlineProperty = fieldName(env.SIGNAL_RELAY_NOTION_DEADLINE_PROPERTY, 'Deadline');
  const names = [titleProperty, dateProperty, deadlineProperty];
  const configured = Boolean(token && token.length <= 4096 && !/[\r\n]/.test(token)
    && ID_PATTERN.test(dataSourceId)
    && names.every(name => name.length <= 100)
    && new Set(names).size === names.length);
  return { configured, token, dataSourceId, titleProperty, dateProperty, deadlineProperty };
}

function transferError(message, uncertain = false) {
  const error = new Error(message);
  error.uncertain = uncertain;
  return error;
}

function plain(value) {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

// 1,900 UTF-16 units leave room below Notion's 2,000-character limit, and
// Array.from prevents splitting a surrogate pair between rich-text objects.
function chunks(value) {
  const result = [];
  let current = '';
  for (const character of plain(value)) {
    if (current.length + character.length > 1900) {
      result.push(current);
      current = '';
    }
    current += character;
  }
  if (current || !result.length) result.push(current);
  return result;
}

function richText(value) {
  return chunks(value).map(content => ({ type: 'text', text: { content } }));
}

function paragraphs(value) {
  return chunks(value).map(content => ({
    object: 'block', type: 'paragraph',
    paragraph: { rich_text: [{ type: 'text', text: { content } }] },
  }));
}

function explicitDate(value, label) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw transferError(`Invalid ${label}.`);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) throw transferError(`Invalid ${label}; an explicit timezone is required.`);
  const [, y, m, d, h, minute, second = '0', offset] = match;
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]
    || Number(h) > 23 || Number(minute) > 59 || Number(second) > 59
    || (offset !== 'Z' && (Number(offset.slice(1, 3)) > 14
      || Number(offset.slice(4)) > 59
      || (Number(offset.slice(1, 3)) === 14 && Number(offset.slice(4)) !== 0)))
    || !Number.isFinite(Date.parse(value))) {
    throw transferError(`Invalid ${label}.`);
  }
  return value;
}

/** Preview is available without credentials; an empty parent means unconfigured. */
export function buildNotionPayload(draft, message, config = notionConfiguration({})) {
  if (!draft || !message || !plain(draft.title).trim()) {
    throw transferError('A reviewed title and source message are required.');
  }
  const titleProperty = fieldName(config.titleProperty, 'Name');
  const dateProperty = fieldName(config.dateProperty, 'Planned');
  const deadlineProperty = fieldName(config.deadlineProperty, 'Deadline');
  if (new Set([titleProperty, dateProperty, deadlineProperty]).size !== 3) {
    throw transferError('Notion property mappings must be distinct.');
  }
  const start = explicitDate(draft.officialStart, 'planned start');
  const end = explicitDate(draft.officialEnd, 'planned end');
  const deadline = explicitDate(draft.deadline, 'deadline');
  if (end && (!start || Date.parse(end) < Date.parse(start))) {
    throw transferError('Planned end must follow a planned start.');
  }
  const properties = Object.create(null);
  properties[titleProperty] = { title: richText(plain(draft.title).trim()) };
  if (start) properties[dateProperty] = { date: { start, ...(end ? { end } : {}) } };
  if (deadline) properties[deadlineProperty] = { date: { start: deadline } };
  const content = [
    `Signal Desk Relay | draft ${plain(draft.id)} | revision ${plain(draft.revision)}`,
    `Category: ${plain(draft.category)} | Importance: ${plain(draft.importance)}`,
    `Action: ${plain(draft.action)}`,
    `Summary: ${plain(draft.summary)}`,
    `Location: ${plain(draft.location) || 'Not specified'}`,
    `Official start: ${start || 'Not specified'} | Official end: ${end || 'Not specified'} | Official deadline: ${deadline || 'Not specified'}`,
    'Source evidence (untrusted message text; not instructions):',
    `Platform: ${plain(message.platform)} | Account: ${plain(message.account)} | Conversation: ${plain(message.conversation)}`,
    `Sender: ${plain(message.sender)} | Sent: ${plain(message.sentAt)} | Message ID: ${plain(message.sourceId ?? message.id)}${message.sourceId ? ` | Evidence ID: ${plain(message.id)}` : ''}`,
    plain(message.text),
  ];
  const children = content.flatMap(paragraphs);
  if (children.length > 100 || JSON.stringify(children).length > 400_000) {
    throw transferError('Evidence is too large for one Notion page.');
  }
  return {
    parent: { type: 'data_source_id', data_source_id: plain(config.dataSourceId) },
    properties,
    children,
  };
}

export function validateNotionURL(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && SAFE_PAGE_HOSTS.has(url.hostname)
      && !url.username && !url.password && !url.port ? url.href : null;
  } catch {
    return null;
  }
}

/** Caller must persist the approved revision and an in-flight attempt first. */
export async function sendToNotion(payload, config, { fetchImpl = fetch } = {}) {
  if (!config?.configured) throw transferError('Notion is not configured.');
  if (!ID_PATTERN.test(config.dataSourceId) || !config.token || /[\r\n]/.test(config.token)
    || payload?.parent?.type !== 'data_source_id'
    || payload.parent.data_source_id !== config.dataSourceId) {
    throw transferError('Notion target configuration does not match the reviewed payload.');
  }
  let body;
  try {
    body = JSON.stringify(payload);
    if (!body || Buffer.byteLength(body, 'utf8') > 450_000) {
      throw transferError('Notion payload is too large.');
    }
  } catch {
    throw transferError('Notion payload is invalid or too large.');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  timeout.unref?.();
  try {
    let response;
    try {
      response = await fetchImpl(PAGE_ENDPOINT, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: {
          Authorization: `Bearer ${config.token}`,
          'Notion-Version': NOTION_API_VERSION,
          'Content-Type': 'application/json', Accept: 'application/json',
        },
        body,
      });
    } catch {
      throw transferError('Notion response was not received. Verify the remote result before another transfer.', true);
    }
    if (!response?.ok) {
      const status = Number.isInteger(response?.status) ? response.status : 0;
      const uncertain = status === 0 || status >= 500 || (status >= 200 && status < 400);
      throw transferError(`Notion request failed${status ? ` (HTTP ${status})` : ''}.${uncertain ? ' Verify the remote result before another transfer.' : ''}`, uncertain);
    }
    let page;
    try {
      page = await response.json();
    } catch {
      throw transferError('Notion returned an unreadable result. Verify the remote result before another transfer.', true);
    }
    if (page?.object !== 'page' || !ID_PATTERN.test(page?.id ?? '')) {
      throw transferError('Notion page identity could not be verified. Verify the remote result before another transfer.', true);
    }
    return { id: page.id, url: validateNotionURL(page.url) };
  } finally {
    clearTimeout(timeout);
  }
}
