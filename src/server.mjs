import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, mkdirSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RelayStore, destinationIdentity } from './store.mjs';
import { notionConfiguration } from './notion.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']]
]);

function respond(res, status, data, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
  });
  res.end(type.startsWith('application/json') ? JSON.stringify(data) : data);
}

async function jsonBody(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
    throw Object.assign(new Error('仅接受 application/json。'), { status: 415 });
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw Object.assign(new Error('导入内容不能超过 2 MiB。'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('JSON 格式无效。'), { status: 400 }); }
}

export function createRelayServer({ store, env = process.env, clock = () => new Date() } = {}) {
  const config = notionConfiguration(env);
  const csrfToken = randomBytes(32).toString('hex');
  let ownedStore = false;
  let lockPath;
  let lockFd;
  const releaseLock = () => {
    if (lockFd !== undefined) { closeSync(lockFd); lockFd = undefined; unlinkSync(lockPath); }
  };
  if (!store) {
    const dataDirectory = resolve(env.SIGNAL_RELAY_DATA_DIR || resolve(root, '.data'));
    mkdirSync(dataDirectory, { recursive: true });
    lockPath = resolve(dataDirectory, 'instance.lock');
    try { lockFd = openSync(lockPath, 'wx'); }
    catch { throw new Error('此数据目录已被占用。若上次异常退出，请确认程序已完全关闭后手动移除 .data/instance.lock。'); }
    try { store = new RelayStore(resolve(dataDirectory, 'relay.sqlite3'), { clock }); }
    catch (error) { releaseLock(); throw error; }
    ownedStore = true;
  }
  const state = () => ({ ...store.state(), csrfToken, notion: { ...destinationIdentity(config), destinationLabel: config.configured ? '你配置的 Notion 数据源' : '演示预览，未连接 Notion' }, now: clock().toISOString(), timezone: 'Asia/Shanghai' });
  const server = http.createServer(async (req, res) => {
    try {
      const port = server.address()?.port;
      const expectedHost = `127.0.0.1:${port}`;
      if (req.headers.host !== expectedHost) return respond(res, 403, { error: '仅允许本机回环地址访问。' });
      const url = new URL(req.url, `http://${expectedHost}`);
      if (req.headers.origin && req.headers.origin !== `http://${expectedHost}`) {
        return respond(res, 403, { error: '拒绝跨站请求。' });
      }
      if (req.method === 'GET' && assets.has(url.pathname)) {
        const [name, type] = assets.get(url.pathname);
        return respond(res, 200, readFileSync(resolve(root, 'public', name)), type);
      }
      if (req.method === 'GET' && url.pathname === '/api/state') return respond(res, 200, state());
      if (req.method === 'GET' && url.pathname === '/api/example') {
        const fixture = JSON.parse(readFileSync(resolve(root, 'examples/messages.json'), 'utf8'));
        return respond(res, 200, fixture);
      }
      if (req.method !== 'POST') return respond(res, 404, { error: '没有这个页面。' });
      const supplied = Buffer.from(String(req.headers['x-csrf-token'] || ''));
      const expected = Buffer.from(csrfToken);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        return respond(res, 403, { error: '页面已过期，请刷新后重新操作。' });
      }
      const body = await jsonBody(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('请求必须是 JSON 对象。');
      if (url.pathname === '/api/import') {
        const result = store.importMessages(body.messages);
        return respond(res, 200, { ...result, ...state() });
      }
      const route = /^\/api\/drafts\/([\w-]+)\/(edit|approve|dismiss|sync)$/.exec(url.pathname);
      if (!route) return respond(res, 404, { error: '没有这个操作。' });
      const [, id, action] = route;
      if (action === 'edit') store.edit(id, body);
      if (action === 'approve') store.approve(id, body, config);
      if (action === 'dismiss') store.dismiss(id, body);
      if (action === 'sync') {
        if (!['preview', 'live'].includes(body.mode)) throw new Error('请选择预览或明确写入。');
        if (body.mode === 'preview') return respond(res, 200, store.preview(id, body, config));
        return respond(res, 200, { result: await store.sync(id, body, config), ...state() });
      }
      return respond(res, 200, state());
    } catch (error) {
      // Provider errors are normalized by the adapter; never log request bodies or credentials.
      const message = typeof error?.message === 'string' ? error.message.slice(0, 240) : '操作失败，请检查当前状态。';
      return respond(res, error.status || 400, { error: message });
    }
  });
  server.requestTimeout = 20_000;
  server.headersTimeout = 10_000;
  const cleanup = () => { if (ownedStore) { store.close(); releaseLock(); ownedStore = false; } };
  server.on('close', cleanup);
  server.on('error', cleanup);
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT || 4318);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT 必须在 1024–65535 之间。');
  const server = createRelayServer();
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用，请设置 PORT 后重试。` : '本地服务器启动失败。');
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => console.log(`Signal Desk Relay: http://127.0.0.1:${port}`));
  process.on('SIGINT', () => server.close());
  process.on('SIGTERM', () => server.close());
}
