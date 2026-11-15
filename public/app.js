'use strict';

const $ = (selector) => document.querySelector(selector);
const categories = {
  mandatory_event: ['必须参加', 'high'],
  mandatory_task: ['必须完成', 'high'],
  change_or_cancel: ['变更 / 取消', 'high'],
  optional_recruitment: ['自愿报名', 'low'],
  useful_info: ['参考信息', 'low'],
  noise: ['普通消息', 'low']
};
const platformNames = { wechat: '微信', qq: 'QQ', manual: '导入' };
const statusNames = {
  pending: '待确认', review: '待确认', draft: '待确认', pending_review: '待确认',
  approved: '已确认', dismissed: '已忽略', synced: '已交接',
  uncertain: '结果待核实', unknown: '结果待核实', failed: '交接失败',
  syncing: '交接中', blocked: '需要处理'
};
const state = { data: null, view: 'inbox', selected: null, editing: null, query: '', category: 'all', sound: false, busy: false };
let toastTimer;
let audioContext;
let lastFocusedBeforeDialog;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function button(label, className, handler) {
  const node = el('button', className, label);
  node.type = 'button';
  node.addEventListener('click', handler);
  return node;
}

function sound() {
  if (!state.sound || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  try {
    audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    const now = audioContext.currentTime;
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(680, now);
    oscillator.frequency.exponentialRampToValueAtTime(430, now + 0.055);
    gain.gain.setValueAtTime(0.018, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.07);
    oscillator.connect(gain).connect(audioContext.destination);
    oscillator.start(now);
    oscillator.stop(now + 0.08);
  } catch { /* Sound is optional and never blocks work. */ }
}

function toast(message, error = false) {
  const node = $('#toast');
  clearTimeout(toastTimer);
  node.textContent = message;
  node.classList.toggle('error', error);
  node.hidden = false;
  toastTimer = setTimeout(() => { node.hidden = true; }, error ? 7000 : 4300);
}

function formatDate(value, withTime = true) {
  if (!value || !Number.isFinite(Date.parse(value))) return '时间待核对';
  const date = new Date(value);
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
    ...(withTime ? { hour: '2-digit', minute: '2-digit', hour12: false } : {})
  }).format(date);
}

function beijingInput(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return '';
  const shifted = new Date(Date.parse(value) + 8 * 3600000);
  return shifted.toISOString().slice(0, 16);
}

function fromBeijingInput(value) {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error('请填写完整的北京时间，或将不确定的时间留空。');
  const result = `${value}:00+08:00`;
  if (!Number.isFinite(Date.parse(result))) throw new Error('日期无法识别，请重新核对。');
  return result;
}

function isReview(draft) {
  return !['approved', 'dismissed', 'synced', 'syncing', 'uncertain', 'unknown', 'blocked'].includes(draft.status);
}

function statusBadge(value = 'pending') {
  const node = el('span', 'status-badge', statusNames[value] || value);
  node.classList.toggle('success', value === 'synced' || value === 'approved');
  node.classList.toggle('dim', value === 'dismissed');
  node.classList.toggle('warning', ['failed', 'uncertain', 'unknown', 'blocked'].includes(value));
  return node;
}

async function api(path, body) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    if (state.data?.csrfToken) headers['X-CSRF-Token'] = state.data.csrfToken;
  }
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers, credentials: 'same-origin',
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  let data;
  try { data = await response.json(); }
  catch { throw new Error('本地服务返回了无法识别的结果，请检查运行窗口。'); }
  if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
  return data;
}

async function refresh({ quiet = false } = {}) {
  try {
    state.data = await api('/api/state');
    state.data.messages ||= [];
    state.data.drafts ||= [];
    state.data.approvals ||= [];
    state.data.handoffs ||= [];
    render();
  } catch (error) {
    if (!quiet) toast(error.message, true);
    if (!state.data) {
      const empty = emptyState('本地服务暂时不可用', '请检查启动窗口的提示，再点击刷新。这里不会把连接失败显示成“没有消息”。', '↻');
      empty.append(button('重新连接', 'button', () => refresh()));
      $('#item-list').replaceChildren(empty);
      $('#detail').replaceChildren(emptyState('等待连接', '你的消息尚未载入。连接恢复后再核对和交接。', '—'));
      $('#notion-state').textContent = '连接状态未知';
    }
  }
}

function messageFor(draft) {
  return state.data.messages.find((message) => String(message.id) === String(draft.messageId)) || null;
}

function recordsFor(draft) {
  return state.data.handoffs.filter((record) => String(record.draftId || record.actionId) === String(draft.id));
}

function showPayload(payload, label = 'Notion 交接预览') {
  $('#payload-title').textContent = label;
  $('#payload-dialog .muted').textContent = label === '已保存的交接数据'
    ? '这是该次交接尝试实际保存的数据。查看历史不会调用 Notion，也不会重新创建记录。'
    : '这是本次准备交接的数据。预览不会向 Notion 写入。';
  $('#payload-content').textContent = JSON.stringify(payload, null, 2);
  lastFocusedBeforeDialog = document.activeElement;
  $('#payload-dialog').showModal();
}

function safeNotionLink(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !['notion.so', 'www.notion.so', 'notion.site', 'www.notion.site', 'app.notion.com'].includes(url.hostname.toLowerCase())
      || url.username || url.password || url.port) return null;
    return url.href;
  } catch { return null; }
}

function destinationSummary(notion = state.data.notion, frozen = false) {
  const node = el('div', 'status-banner');
  if (notion?.configured) {
    node.append(el('strong', '', `${frozen ? '此版本已批准的目标' : '确认交接目标'}：${notion.destinationLabel || 'Notion 数据源'}`));
    node.append(el('p', 'readback-note', `Data source ID：${notion.dataSourceId || '未提供，请刷新后核对'}`));
    const mapping = [notion.titleProperty && `事项 → ${notion.titleProperty}`, notion.dateProperty && `计划时间 → ${notion.dateProperty}`, notion.deadlineProperty && `官方截止 → ${notion.deadlineProperty}`].filter(Boolean);
    if (mapping.length) node.append(el('p', 'readback-note', `字段映射：${mapping.join('；')}`));
    node.append(el('p', 'readback-note', frozen ? '目标及字段映射已绑定到此批准快照。若配置发生变化，需重新编辑并确认。' : '批准会绑定此目标及字段映射。更换目标后，需要重新编辑并确认。'));
  } else {
    node.append(el('strong', '', '演示预览，未连接 Notion'));
    node.append(el('p', 'readback-note', '本次确认仅绑定演示目标。之后配置真实 Notion，需要重新编辑并确认，才能真实交接。'));
  }
  return node;
}

function visibleDrafts() {
  const query = state.query.toLocaleLowerCase();
  let drafts = state.data.drafts.filter((draft) => {
    if (state.view === 'review' && !isReview(draft)) return false;
    if (state.view === 'handoff' && !['approved', 'synced', 'syncing', 'uncertain', 'unknown', 'failed', 'blocked'].includes(draft.status) && !recordsFor(draft).length) return false;
    if (state.category !== 'all' && draft.category !== state.category) return false;
    if (!query) return true;
    const message = messageFor(draft);
    return [draft.title, draft.action, draft.summary, message?.text, message?.conversation, message?.sender, message?.platform].filter(Boolean).join(' ').toLocaleLowerCase().includes(query);
  });
  const order = { high: 0, medium: 1, low: 2 };
  return drafts.sort((a, b) => {
    if (state.view !== 'handoff') {
      const reviewOrder = Number(!isReview(a)) - Number(!isReview(b));
      if (reviewOrder) return reviewOrder;
      const importanceOrder = (order[a.importance] ?? 1) - (order[b.importance] ?? 1);
      if (importanceOrder) return importanceOrder;
    }
    return Date.parse(messageFor(b)?.sentAt || 0) - Date.parse(messageFor(a)?.sentAt || 0);
  });
}

function renderStats() {
  const drafts = state.data.drafts;
  const count = (value) => String(value).padStart(2, '0');
  $('#count-review').textContent = count(drafts.filter(isReview).length);
  $('#count-approved').textContent = count(drafts.filter((draft) => ['approved', 'synced'].includes(draft.status)).length);
  $('#count-synced').textContent = count(drafts.filter((draft) => draft.status === 'synced').length);
  $('#count-messages').textContent = count(state.data.messages.length);
  $('#tab-inbox-count').textContent = String(drafts.filter(isReview).length);
  $('#notion-state').textContent = state.data.notion?.configured ? '已配置 · 仅在你点击时写入' : '演示模式 · 尚未连接 Notion';
  $('#sample-label').hidden = !state.data.messages.some((message) => message.text?.startsWith('【虚构'));
}

function render() {
  renderStats();
  document.querySelectorAll('[data-view]').forEach((tab) => {
    const selected = tab.dataset.view === state.view;
    tab.classList.toggle('active', selected);
    if (selected) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  });
  const notes = {
    inbox: '本地规则生成分类建议。内容与日期需要你逐项核对。',
    review: '优先核对必须参加、必须完成和变更通知。自愿报名始终单独标记。',
    handoff: '只交接你确认的准确版本。预览不会写入，真实交接需要单独点击。'
  };
  $('#view-note').textContent = notes[state.view];
  $('#list-title').textContent = { inbox: '消息收件箱', review: '待你核对', handoff: '确认与交接记录' }[state.view];
  const drafts = visibleDrafts();
  if (!drafts.some((draft) => String(draft.id) === String(state.selected))) state.selected = drafts[0]?.id ?? null;
  const list = $('#item-list');
  if (!drafts.length) {
    const hasData = state.data.drafts.length > 0;
    const empty = emptyState(
      hasData ? (state.view === 'handoff' ? '还没有需要交接的事项' : '当前视图没有事项') : '让重要消息浮出水面',
      hasData ? '调整筛选，或先在收件箱核对并确认一项通知。' : '主动导入消息，或先用完全虚构的示例体验从原文到交接的过程。',
      state.view === 'handoff' ? '↗' : '⌁'
    );
    if (!hasData) empty.append(button('载入虚构示例', 'button', loadDemo));
    list.replaceChildren(empty);
  } else list.replaceChildren(...drafts.map(renderCard));
  const draft = state.data.drafts.find((item) => String(item.id) === String(state.selected));
  if (draft) renderDetail(draft);
  else $('#detail').replaceChildren(emptyState('每次确认，都有依据', '选择一条消息，查看来源、原文和规则建议。确认前，你始终可以编辑。', '◎', true));
}

function emptyState(title, text, mark, detail = false) {
  const node = el('div', `empty${detail ? ' detail-empty' : ''}`);
  node.append(el('span', 'empty-mark', mark), el('h3', '', title), el('p', '', text));
  return node;
}

function renderCard(draft) {
  const message = messageFor(draft);
  const card = button('', 'message-card', () => {
    state.selected = draft.id;
    sound();
    render();
    if (window.matchMedia('(max-width:850px)').matches) {
      $('#detail').scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
      $('#detail').focus({ preventScroll: true });
    }
  });
  const selected = String(state.selected) === String(draft.id);
  card.classList.toggle('selected', selected);
  card.setAttribute('aria-pressed', String(selected));
  const top = el('div', 'card-top');
  top.append(el('span', 'platform-badge', platformNames[message?.platform] || message?.platform || '来源'), el('span', 'card-conversation', message?.conversation || '来源缺失'), statusBadge(draft.status));
  const bottom = el('div', 'card-bottom');
  const category = categories[draft.category] || ['待核对', 'low'];
  bottom.append(el('span', `category-chip ${category[1]}`, category[0]), el('span', '', message?.sender || '发送人未知'), el('time', 'card-time', formatDate(draft.deadline || draft.officialStart || message?.sentAt)));
  card.append(top, el('strong', 'card-title', draft.title || '未命名事项'), el('p', 'card-summary', draft.summary || draft.action || message?.text || '原文缺失，需要核对'), bottom);
  return card;
}

function field(label, name, value, type = 'text', note) {
  const wrapper = el('label', 'field');
  const input = el(type === 'textarea' ? 'textarea' : 'input');
  if (type !== 'textarea') input.type = type;
  else input.rows = 2;
  input.name = name;
  input.value = type === 'datetime-local' ? beijingInput(value) : (value || '');
  if (type === 'datetime-local') input.step = '60';
  if (['title', 'action'].includes(name)) input.maxLength = name === 'title' ? 200 : 4000;
  if (name === 'location') input.maxLength = 500;
  wrapper.append(el('span', '', label), input);
  if (note) wrapper.append(el('small', 'field-note', note));
  return wrapper;
}

function formValues(form) {
  const data = new FormData(form);
  return {
    title: String(data.get('title') || '').trim(), action: String(data.get('action') || '').trim(),
    officialStart: fromBeijingInput(data.get('officialStart')),
    officialEnd: fromBeijingInput(data.get('officialEnd')),
    deadline: fromBeijingInput(data.get('deadline')),
    location: String(data.get('location') || '').trim(),
    participating: Boolean(data.get('participating'))
  };
}

function unchanged(values, draft) {
  for (const key of ['title', 'action', 'location']) if (values[key] !== String(draft[key] || '').trim()) return false;
  for (const key of ['officialStart', 'officialEnd', 'deadline']) if (beijingInput(values[key]) !== beijingInput(draft[key])) return false;
  // Participation is an explicit choice at approval, and need not be pre-saved.
  return true;
}

async function mutate(draft, operation, payload, success) {
  if (state.busy) return null;
  state.busy = true;
  document.querySelectorAll('#detail button').forEach((node) => { node.disabled = true; });
  try {
    const result = await api(`/api/drafts/${encodeURIComponent(draft.id)}/${operation}`, { revision: draft.revision, ...payload });
    if (operation === 'edit') state.editing = null;
    await refresh({ quiet: true });
    if (success) toast(success);
    sound();
    return result;
  } catch (error) {
    toast(error.message, true);
    await refresh({ quiet: true });
    return null;
  } finally {
    state.busy = false;
    document.querySelectorAll('#detail button').forEach((node) => { node.disabled = false; });
  }
}

function renderDetail(draft) {
  const detail = $('#detail');
  const message = messageFor(draft);
  const category = categories[draft.category] || ['待核对', 'low'];
  const intro = el('div', 'detail-intro');
  intro.append(el('p', 'detail-kicker', 'REVIEW THE SIGNAL'), el('span', 'revision', `版本 ${draft.revision} · ${statusNames[draft.status] || draft.status || '待确认'}`));
  const importance = { high: '优先处理', medium: '需要关注', low: '按需查看' }[draft.importance] || '需要核对';
  const important = el('p', 'importance-line', `${importance} · ${category[0]}`);
  const title = el('h2', 'detail-title', draft.title || '未命名事项');
  const summary = el('p', 'detail-summary', draft.summary || draft.action || '请对照原文，核对具体行动与时间。');
  const evidenceSection = el('div', 'detail-section');
  evidenceSection.append(el('span', 'section-label', '消息从哪里来 · 原始证据'));
  const evidence = el('div', 'evidence-box');
  const source = el('div', 'evidence-source');
  source.append(el('span', 'platform-badge', platformNames[message?.platform] || message?.platform || '?'), el('span', '', message?.conversation || '会话缺失'), el('span', 'sender', ` / ${message?.sender || '发送人缺失'}`), el('time', '', `${formatDate(message?.sentAt)} 北京时间`));
  evidence.append(source, el('pre', 'original-text', message?.text || '原始消息不可用。请先补充证据。'), el('small', 'evidence-id', `消息 ID：${message?.id || draft.messageId || '缺失'} · 账户：${message?.account || '缺失'}`));
  evidenceSection.append(evidence);
  detail.replaceChildren(intro, important, title, summary, evidenceSection);

  if (Array.isArray(draft.reasons) && draft.reasons.length) {
    const reasonSection = el('div', 'detail-section');
    reasonSection.append(el('span', 'section-label', '分类建议的依据'));
    const list = el('ul', 'reasons');
    list.append(...draft.reasons.map((reason) => el('li', '', reason)));
    reasonSection.append(list);
    detail.append(reasonSection);
  }

  if (!isReview(draft) && !(draft.status === 'approved' && state.editing === draft.id)) {
    renderReadOnly(draft, detail);
    return;
  }

  const form = el('form', 'review-form');
  const editingApproved = draft.status === 'approved';
  if (editingApproved) form.append(el('p', 'review-warning', '保存修改后，旧批准立即失效。你需要重新核对新版本，才能交接。'));
  form.append(el('span', 'section-label', '核对后交接的内容 · 日期均为北京时间'));
  form.append(field('事项名称', 'title', draft.title), field('下一步要做什么', 'action', draft.action, 'textarea'));
  const times = el('div', 'form-row');
  times.append(field('官方开始时间', 'officialStart', draft.officialStart, 'datetime-local'), field('官方结束时间', 'officialEnd', draft.officialEnd, 'datetime-local'));
  form.append(times);
  const deadlineRow = el('div', 'form-row');
  deadlineRow.append(field('官方最终截止', 'deadline', draft.deadline, 'datetime-local', '不确定时留空，不能把推测当成通知。'), field('地点', 'location', draft.location));
  form.append(deadlineRow);
  if (draft.category === 'optional_recruitment') {
    const participation = el('label', 'checkline');
    const checkbox = el('input');
    checkbox.type = 'checkbox'; checkbox.name = 'participating'; checkbox.checked = Boolean(draft.participating);
    participation.append(checkbox, el('span', '', '我要参加这个自愿活动，允许将它作为我的事项交接。'));
    form.append(participation);
  }
  form.append(destinationSummary());
  const confirm = el('label', 'checkline');
  const confirmInput = el('input');
  confirmInput.type = 'checkbox'; confirmInput.name = 'reviewed';
  confirm.append(confirmInput, el('span', '', `我已核对原文、行动与时间，确认当前版本 ${draft.revision}。`));
  if (!editingApproved) form.append(confirm);
  const actions = el('div', 'detail-actions');
  const save = button(editingApproved ? '保存为新待确认版本' : '保存修改', editingApproved ? 'button' : 'quiet-button', async () => {
    try {
      const values = formValues(form);
      if (!values.title) throw new Error('请填写事项名称。');
      await mutate(draft, 'edit', values, '修改已保存。请核对新版本后再确认。');
    } catch (error) { toast(error.message, true); }
  });
  const approve = button('确认此版本 →', 'button', async () => {
    try {
      const values = formValues(form);
      if (!unchanged(values, draft)) throw new Error('你修改了内容，请先保存，再核对并确认新版本。');
      if (!confirmInput.checked) throw new Error('请先勾选“我已核对”，再确认当前版本。');
      if (draft.category === 'optional_recruitment' && !values.participating) throw new Error('自愿活动需要你先选择“我要参加”。');
      await mutate(draft, 'approve', { participating: values.participating }, '此版本已确认。可在交接记录中预览，再选择写入 Notion。');
    } catch (error) { toast(error.message, true); }
  });
  const dismiss = button('忽略这条建议', 'quiet-button dismiss-button', () => mutate(draft, 'dismiss', {}, '已忽略，原文仍保留供你核对。'));
  if (editingApproved) actions.append(save, button('取消修改', 'quiet-button', () => { state.editing = null; renderDetail(draft); }));
  else actions.append(save, approve, dismiss);
  form.append(actions, el('p', 'readback-note', '确认只记录你的决定，不会自动向 Notion 写入。任何后续修改都需要重新确认。'));
  form.addEventListener('submit', (event) => { event.preventDefault(); if (editingApproved) save.click(); else approve.click(); });
  detail.append(form);
}

function renderReadOnly(draft, detail) {
  const summary = el('div', 'handoff-box');
  summary.append(el('h3', '', draft.status === 'dismissed' ? '已忽略这条建议' : draft.status === 'synced' ? '已交接到 Notion' : '你已确认的事项'));
  summary.append(el('p', '', `下一步：${draft.action || '未填写'}`));
  if (draft.officialStart) summary.append(el('p', '', `官方开始：${formatDate(draft.officialStart)} 北京时间`));
  if (draft.officialEnd) summary.append(el('p', '', `官方结束：${formatDate(draft.officialEnd)} 北京时间`));
  summary.append(el('p', '', `官方截止：${draft.deadline ? `${formatDate(draft.deadline)} 北京时间` : '未填写，保留待安排状态'}`));
  if (draft.location) summary.append(el('p', '', `地点：${draft.location}`));
  detail.append(summary);
  if (draft.status === 'dismissed') {
    detail.append(el('p', 'readback-note', '此条建议不会交接。原始证据与处理状态仍可查看。'));
    return;
  }
  const approval = state.data.approvals.find((entry) => String(entry.draftId) === String(draft.id) && entry.revision === draft.revision);
  if (approval?.snapshot?.destination) detail.append(destinationSummary(approval.snapshot.destination, true));
  if (['uncertain', 'unknown', 'blocked', 'syncing'].includes(draft.status)) {
    const banner = el('div', 'review-warning', '交接结果需要核实。请先在 Notion 查看是否已生成记录；本程序不会自动重复创建。');
    detail.append(banner);
  }
  const actions = el('div', 'detail-actions');
  if (draft.status === 'approved') {
    actions.append(button('预览 Notion 数据', 'quiet-button', async () => {
      const result = await mutate(draft, 'sync', { mode: 'preview' });
      if (result) showPayload(result.payload ?? result.preview ?? result);
    }));
    actions.append(button('修改并重新确认', 'quiet-button', () => { state.editing = draft.id; renderDetail(draft); }));
    if (state.data.notion?.configured) {
      actions.append(button('写入 Notion ↗', 'button', async () => {
        const target = state.data.notion.destinationLabel || '已配置的 Notion 数据源';
        if (!window.confirm(`将已确认的版本 ${draft.revision}「${draft.title}」写入 ${target}？\nData source ID：${state.data.notion.dataSourceId || '未提供'}\n\n此次会真实创建一条记录，请先核对交接预览。目标变化后，旧批准不能用于真实写入。`)) return;
        await mutate(draft, 'sync', { mode: 'live' }, '交接请求已处理，请查看记录中的实际结果。');
      }));
    } else {
      const note = el('div', 'status-banner');
      note.append(el('strong', '', '演示预览，未连接 Notion。'), document.createTextNode(' 可完整预览交接数据。真实写入需在启动前配置自己的 SIGNAL_RELAY_NOTION_TOKEN 与 SIGNAL_RELAY_NOTION_DATA_SOURCE_ID，详细步骤见项目 README。配置后需要重新编辑并确认。'));
      detail.append(note);
    }
  }
  detail.append(actions);
  const records = recordsFor(draft);
  if (records.length) {
    const list = el('div', 'record-list');
    records.slice().reverse().forEach((record) => {
      const node = el('div', 'record');
      const recordStatus = record.status || record.state || record.mode || '记录';
      node.append(el('strong', '', `${statusNames[recordStatus] || recordStatus} · ${formatDate(record.createdAt || record.at || record.updatedAt)}`));
      if (record.error || record.message) node.append(el('span', '', record.error || record.message));
      if (record.result?.id || record.pageId || record.remoteId) node.append(el('p', '', `Notion 页面 ID：${record.result?.id || record.pageId || record.remoteId}`));
      const remoteURL = safeNotionLink(record.result?.url);
      if (remoteURL) {
        const link = el('a', 'text-button', '打开已交接的 Notion 页面 ↗');
        link.href = remoteURL;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        node.append(link);
      }
      if (record.payload && typeof record.payload === 'object') {
        node.append(button('查看此次保存的交接数据', 'quiet-button', () => showPayload(record.payload, '已保存的交接数据')));
      }
      list.append(node);
    });
    detail.append(el('span', 'section-label', '交接尝试记录'), list);
  }
}

async function loadDemo() {
  if (state.busy) return;
  state.busy = true;
  try {
    const fixture = await api('/api/example');
    const messages = Array.isArray(fixture) ? fixture : fixture.messages;
    if (!Array.isArray(messages)) throw new Error('示例格式无法识别。');
    await api('/api/import', { messages });
    state.view = 'inbox';
    state.query = ''; $('#search').value = '';
    state.category = 'all'; $('#category-filter').value = 'all';
    await refresh();
    toast('已导入虚构示例。可以展开原文，体验核对与交接预览。');
    sound();
  } catch (error) { toast(error.message, true); }
  finally { state.busy = false; }
}

function openImport() {
  lastFocusedBeforeDialog = document.activeElement;
  $('#import-error').hidden = true;
  $('#import-dialog').showModal();
}

function closeDialog(dialog) {
  dialog.close();
  lastFocusedBeforeDialog?.focus?.();
}

$('#import-open').addEventListener('click', openImport);
document.querySelectorAll('.dialog-close').forEach((node) => node.addEventListener('click', () => closeDialog($('#import-dialog'))));
$('#payload-close').addEventListener('click', () => closeDialog($('#payload-dialog')));
$('#payload-done').addEventListener('click', () => closeDialog($('#payload-dialog')));
$('#demo-load').addEventListener('click', loadDemo);
$('#refresh').addEventListener('click', () => { sound(); refresh(); });
$('#sound-toggle').addEventListener('click', () => {
  state.sound = !state.sound;
  $('#sound-toggle').setAttribute('aria-pressed', String(state.sound));
  $('#sound-toggle').textContent = state.sound ? '音效开启' : '音效关闭';
  sound();
});
document.querySelectorAll('[data-view]').forEach((node) => node.addEventListener('click', () => {
  state.view = node.dataset.view;
  state.selected = null;
  sound();
  if (state.data) render();
}));
$('#search').addEventListener('input', (event) => { state.query = event.target.value; if (state.data) render(); });
$('#category-filter').addEventListener('change', (event) => { state.category = event.target.value; if (state.data) render(); });
$('#import-file').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (file.size > 2 * 1024 * 1024) throw new Error('文件超过 2 MiB，请分批导入。');
    $('#import-json').value = await file.text();
    $('#import-error').hidden = true;
  } catch (error) {
    $('#import-error').textContent = error.message;
    $('#import-error').hidden = false;
  }
});
$('#import-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (state.busy) return;
  const submit = $('#import-submit');
  try {
    const raw = $('#import-json').value;
    if (new Blob([raw]).size > 2 * 1024 * 1024) throw new Error('消息内容超过 2 MiB，请分批导入。');
    let parsed;
    try { parsed = JSON.parse(raw); } catch { throw new Error('JSON 格式不正确，请检查括号、引号和逗号。'); }
    const messages = Array.isArray(parsed) ? parsed : parsed?.messages;
    if (!Array.isArray(messages) || !messages.length) throw new Error('请提供非空消息数组，或包含 messages 数组的对象。');
    if (messages.length > 500) throw new Error('每次最多导入 500 条消息。');
    state.busy = true; submit.disabled = true;
    await api('/api/import', { messages });
    state.view = 'inbox'; state.selected = null;
    closeDialog($('#import-dialog'));
    await refresh();
    toast('消息已导入。请逐项核对规则生成的建议。');
    sound();
  } catch (error) {
    $('#import-error').textContent = error.message;
    $('#import-error').hidden = false;
  } finally { state.busy = false; submit.disabled = false; }
});

function updateClock() {
  const now = new Date();
  $('#clock-date').textContent = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit' }).format(now).replace('/', '.');
  $('#clock-time').textContent = `北京时间 ${new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(now)}`;
}
updateClock();
setInterval(updateClock, 30000);
$('#item-list').replaceChildren(el('p', 'loading-line', '正在读取本地消息…'));
refresh();
