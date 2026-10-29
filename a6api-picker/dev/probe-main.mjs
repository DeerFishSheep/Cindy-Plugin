// 本地实测：把真正的 main.js（电子脑）跑在 Node 里，配一个假宿主 +
// 真 worker（真 curl 抓 a6api.com），逐条打 RPC。
//
//   node dev/probe-main.mjs
//
// 覆盖：search/run（含综合榜 + 性价比榜）、brands/list、models/list、status/get、
// session/get、last/get、fav/set → fav/list → fav/refresh（含未在榜 down）、
// fav/set off；若本机浏览器有 a6api 登录态，再跑 balance/get、tokens/list、
// pin/current、login/cookie（全部只读）。
//
// 不覆盖写操作：pin/set、disable/channel、login/password —— 会改账号状态/需要
// 真密码，见 README「未实跑项」。
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataRoot = process.env.A6API_PROBE_DATA_ROOT || mkdtempSync(join(tmpdir(), 'cindy-a6api-main-'));
const keepData = Boolean(process.env.A6API_PROBE_DATA_ROOT);
const workerData = join(dataRoot, 'worker');
mkdirSync(workerData, { recursive: true });
const fsRoot = join(dataRoot, 'data');
mkdirSync(fsRoot, { recursive: true });

// ── 真 worker 子进程 ────────────────────────────────────────────────────────

const child = spawn(process.execPath, [join(root, 'node/worker.cjs')], {
  cwd: root,
  env: { ...process.env, A6API_DATA_DIR: workerData },
  stdio: ['pipe', 'pipe', 'pipe']
});
const lines = createInterface({ input: child.stdout });
const waiters = new Map();
let seq = 0;

child.stderr.on('data', (buf) => {
  const text = String(buf).trim();
  if (text) console.error('[worker]', text);
});

lines.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const job = waiters.get(msg.id);
  if (!job) return;
  waiters.delete(msg.id);
  clearTimeout(job.timer);
  if (msg.error) job.reject(new Error(msg.error.message));
  else job.resolve(msg.result);
});

function workerRpc(method, params, cindy) {
  const id = ++seq;
  const payload = { jsonrpc: '2.0', id, method, params };
  if (cindy) payload.cindy = cindy;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiters.delete(id); reject(new Error(method + ' timeout')); }, 120000);
    waiters.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify(payload) + '\n');
  });
}

// ── 假宿主：/kv、/secrets、fs root:'data'、BroadcastChannel ────────────────

let kv = {};
const secrets = new Map();

globalThis.fetch = async (url, init = {}) => {
  const path = String(url);
  const method = (init.method || 'GET').toUpperCase();
  if (path === '/kv') {
    if (method === 'PUT') kv = JSON.parse(init.body || '{}');
    return { ok: true, status: 200, json: async () => kv };
  }
  if (path === '/secrets') {
    return {
      ok: true,
      status: 200,
      json: async () => [...secrets.entries()].map(([key, value]) => ({ key, saved: true, tail: String(value).slice(-4) }))
    };
  }
  if (path.startsWith('/secrets/')) {
    const key = path.slice('/secrets/'.length);
    if (method === 'PUT') secrets.set(key, JSON.parse(init.body || '{}').value);
    if (method === 'DELETE') secrets.delete(key);
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  }
  throw new Error('unexpected fetch: ' + path);
};

function safePath(rel) {
  // 与宿主 fs root:'data' 的规则同口径：相对路径、正斜杠分段、不以点开头、无 ..
  const segments = String(rel || '').split('/');
  const bad =
    !segments.length ||
    segments.some((seg) => !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(seg) || seg.endsWith('.'));
  if (bad) throw new Error('invalid fs path: ' + rel);
  return join(fsRoot, ...segments);
}

const sent = [];
let hostHandler = null;
globalThis.cindy = {
  send: async (msg) => { sent.push(msg); return { ok: true }; },
  fs: async (req) => {
    try {
      const file = safePath(req.path || '');
      if (req.op === 'write') {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, String(req.content ?? ''), 'utf8');
        return { ok: true, path: req.path, bytes: Buffer.byteLength(String(req.content ?? '')) };
      }
      if (req.op === 'read') {
        if (!existsSync(file)) return { ok: false, message: 'not found' };
        return { ok: true, content: readFileSync(file, 'utf8') };
      }
      if (req.op === 'delete') { rmSync(file, { force: true }); return { ok: true }; }
      if (req.op === 'list') return { ok: true, entries: [] };
      return { ok: false, message: 'unsupported op' };
    } catch (err) {
      return { ok: false, message: String(err.message || err) };
    }
  },
  node: {
    request: async (req) => {
      try {
        // 宿主按 node.secretBindings 注入：main.js 自己看不到明文，worker 才拿得到。
        const cookie = secrets.get('a6api_cookie');
        const injected = cookie ? { secrets: { a6api_cookie: cookie } } : undefined;
        const result = await workerRpc(req.method, req.params || {}, injected);
        return { ok: true, result };
      } catch (err) {
        return { ok: false, message: String(err.message || err) };
      }
    }
  },
  onHostMessage: (fn) => { hostHandler = fn; },
  commands: { register: async () => {} }
};

// BroadcastChannel：main.js 会 new 一个；这里把实例留给测试脚本，并拦 postMessage 收回执。
let mainChannel = null;
const replies = new Map();
globalThis.BroadcastChannel = class {
  constructor() {
    this.onmessage = null;
    mainChannel = this;
  }
  postMessage(msg) {
    if (msg && msg.type === 'rpc-reply' && replies.has(msg.reqId)) {
      const resolve = replies.get(msg.reqId);
      replies.delete(msg.reqId);
      resolve(msg);
    }
  }
};

await import(pathToFileURL(join(root, 'main.js')).href);

const waitForChannel = () => new Promise((r) => setTimeout(r, 50));
await waitForChannel();
if (!mainChannel) throw new Error('main.js 没有建立 BroadcastChannel');

let mainSeq = 0;
function rpc(method, params = {}) {
  const reqId = 'probe-' + (++mainSeq);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { replies.delete(reqId); reject(new Error(method + ' timeout')); }, 130000);
    replies.set(reqId, (msg) => { clearTimeout(timer); resolve(msg); });
    mainChannel.onmessage({ data: { type: 'rpc', reqId, method, params } });
  });
}

// ── 输出辅助 ────────────────────────────────────────────────────────────────

function row(r) {
  return {
    id: r.id,
    sup: r.sup,
    score: r.score,
    costCny100m: r.costCny100m,
    ratio: r.ratio,
    ttft: r.ttft,
    tps: r.tps,
    cache: r.cache,
    sr24: r.sr24,
    auth: r.auth
  };
}

function brief(result) {
  if (!result || !result.ok) return result;
  const out = { ...result };
  if (Array.isArray(out.ranking)) {
    out.rankingSample = out.ranking.slice(0, 3).map(row);
    delete out.ranking;
  }
  if (Array.isArray(out.valueRanking)) {
    out.valueRankingSample = out.valueRanking.slice(0, 3).map(row);
    delete out.valueRanking;
  }
  if (Array.isArray(out.items)) {
    out.items = out.items.map((it) => ({
      channelId: it.channelId,
      down: it.down,
      hasSnapshot: Boolean(it.snapshot),
      snapshotId: it.snapshot && it.snapshot.id,
      snapshotScore: it.snapshot && it.snapshot.score,
      snapshotCache: it.snapshot && it.snapshot.cache,
      refreshedAt: it.refreshedAt || null
    }));
  }
  if (out.cookie) out.cookie = '<redacted ' + out.cookie.length + ' chars>';
  if (Array.isArray(out.models)) out.models = out.models.slice(0, 6).concat(out.models.length > 6 ? ['…'] : []);
  return out;
}

function show(label, value) {
  console.log('\n## ' + label);
  console.log(JSON.stringify(brief(value), null, 2));
}

const MODEL = 'deepseek-v4.1-flash';

// ── 主流程 ──────────────────────────────────────────────────────────────────

const pub = await rpc('search/run', {
  model: MODEL,
  onlyQualified: true,
  minCache: 80,
  minSr: 95,
  maxRatio: 0.1,
  maxTtft: 8
});
show('1. search/run 公开数据（综合榜 + 性价比榜）', pub);
if (!pub.ok) throw new Error('公开数据失败：' + pub.error);
console.log('   → 综合榜 ' + pub.ranking.length + ' 条 / 性价比榜 ' + (pub.valueRanking || []).length + ' 条');
const pick = pub.ranking[0];
if (!pick) throw new Error('榜单为空，无法继续测试收藏');

show('2. brands/list', await rpc('brands/list'));
show('3. models/list（DeepSeek）', await rpc('models/list', { brand: 'DeepSeek' }));
show('4. status/get', await rpc('status/get'));
show('5. session/get（未登录）', await rpc('session/get'));
const last = await rpc('last/get');
console.log('\n## 6. last/get（快照）');
console.log(JSON.stringify({ ok: last.ok, stale: last.stale || false, model: last.params && last.params.model, kept: last.data && last.data.kept, algo: last.data && last.data.algo }, null, 2));

// 收藏：真实渠道 + 一个不在榜的假渠道（验证 down 标记）
show('7. fav/set 收真实渠道 #' + pick.id, await rpc('fav/set', { model: MODEL, channelId: pick.id, on: true, snapshot: pick }));
show('8. fav/set 收一个不在榜的渠道 #99999999', await rpc('fav/set', { model: MODEL, channelId: 99999999, on: true, snapshot: null }));
show('9. fav/list（读回，含 snapshot）', await rpc('fav/list', { model: MODEL }));

const fresh = await rpc('search/run', { model: MODEL, onlyQualified: false });
const merged = [...(fresh.ranking || []), ...(fresh.valueRanking || [])];
const seen = new Set();
const rows = merged.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
show('10. fav/refresh（用最新的 ' + rows.length + ' 行覆盖快照）', await rpc('fav/refresh', { model: MODEL, rows }));
show('11. fav/set 取消真实渠道', await rpc('fav/set', { model: MODEL, channelId: pick.id, on: false }));
show('12. fav/set 清掉假渠道，收尾', await rpc('fav/set', { model: MODEL, channelId: 99999999, on: false }));

// 登录态（只读）。先直接问 worker 有没有浏览器登录态：有才走 login/browser
// 的同步分支；没有就跳过 —— 否则 login/browser 会替你打开 a6api 登录页。
const imp = await workerRpc('session/import', {});
if (!imp.ok) {
  console.log('\n## 13. login/browser —— 跳过：本机浏览器没有可用的 a6api 登录态（不调用，避免弹出登录页）');
  console.log('   ' + (imp.error || ''));
}
const login = imp.ok ? await rpc('login/browser') : { ok: false };
console.log('\n## 13. login/browser（读本机浏览器登录态）');
console.log(JSON.stringify({ ok: login.ok, mode: login.mode, userId: login.userId, tokenCount: login.tokenCount, source: login.source, reason: login.reason }, null, 2));

if (login.ok && login.mode === 'sync') {
  show('14. session/get（已登录）', await rpc('session/get'));
  show('15. balance/get', await rpc('balance/get'));
  show('16. tokens/list', await rpc('tokens/list'));
  show('17. pin/current', await rpc('pin/current', { model: MODEL }));
  show('18. login/cookie（验证保险库里的 Cookie）', await rpc('login/cookie'));
  const auth = await rpc('search/run', { model: MODEL, onlyQualified: true });
  console.log('\n## 19. search/run 登录态（scope=' + auth.scope + '）');
  console.log(JSON.stringify({ ok: auth.ok, scope: auth.scope, total: auth.total, fetched: auth.fetched, kept: auth.kept, pinned: auth.ranking.some((r) => r.pinned) }, null, 2));
} else {
  console.log('   浏览器登录态不可用，跳过登录态只读接口（面板/设置页仍可用粘贴 Cookie 或账号密码登录）。');
}

// Agent 工具：和面板共用 search/run，返回综合榜 + 性价比榜摘要
if (hostHandler) {
  await hostHandler({ type: 'tool-call', tool: 'a6api_channel_search', callId: 'probe-call', args: { model: MODEL, limit: 3 } });
  const out = sent.find((m) => m.type === 'tool-result');
  console.log('\n## 20. 工具 a6api_channel_search（limit=3）');
  console.log(out && out.ok ? out.result.content : JSON.stringify(out));
} else {
  console.log('\n## 20. 工具 —— 未注册 onHostMessage，跳过');
}

console.log('\n## 21. 筛选条件：改了就存（filters/save → filters/get，落插件数据目录）');
const saveRes = await rpc('filters/save', { filters: { model: MODEL, brand: 'DeepSeek', minSr: 95, maxRatio: 0.1, guaranteed: true, onlyQualified: true } });
console.log('save: ' + JSON.stringify(saveRes.ok));
const getRes = await rpc('filters/get', {});
console.log('get:  ' + JSON.stringify(getRes.filters));

console.log('\n## 22. 落盘检查（插件数据目录）');
for (const name of ['last.json', 'favorites.json', 'filters.json']) {
  const file = join(fsRoot, name);
  console.log(name + ': ' + (existsSync(file) ? readFileSync(file, 'utf8').length + ' bytes' : '缺失'));
}
console.log('dataRoot: ' + dataRoot);

child.stdin.end();
await new Promise((r) => setTimeout(r, 200));
if (!keepData) rmSync(dataRoot, { recursive: true, force: true });
process.exit(0);
