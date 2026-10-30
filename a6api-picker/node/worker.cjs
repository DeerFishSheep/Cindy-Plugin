// Cindy 随包 Node worker：A6API 渠道抓取 / 评分 / 登录解析。
//
// 抓取与评分算法原样来自 pi-a6api 0.3.10 的 lib/core.mjs（唯一改动是落盘目录：
// 不再写 ~/.dsh，改读 A6API_DATA_DIR）。这里只做四件事：
//   1. 把宿主注入的 Cookie（node.secretBindings）整理成 core 要的 cred
//   2. 把 core 的返回压成面板要的紧凑结构（slim / valueRanking，与上游一致）
//   3. 用一行一个 JSON-RPC 对象跟 main.js 通信（日志只走 stderr）
//   4. 从本机 Chrome/Edge/Brave 读 a6api 登录态、用账号密码登录
//
// 持久化边界：Cookie 由宿主保险库保管（main.js 经 /secrets 写入），userId/令牌
// 选择在 /kv，榜单与收藏在 fs root:'data'。本进程只把 A6API_DATA_DIR 指到系统
// 临时目录，用来放 Chrome Cookies 的临时拷贝、cookie jar 和模型缓存。
//
// 方法名与上游 main.js 的 a6api.* 通道一一对应：
//   search/run → a6api.search          balance/get → a6api.balance
//   brands/list → a6api.brands         models/list → a6api.models
//   session/import → a6api.login（同步浏览器）   login/cookie → a6api.login.cookie
//   login/password → a6api.login.password        tokens/list → a6api.tokens
//   pin/current → a6api.pin.current    pin/set → a6api.pin
//   disable/channel → a6api.disable    status/probe → a6api.status
// fav/* 与快照要落 main.js 的 fs data，留在电子脑那一层（见 main.js）。

const readline = require('node:readline');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');

// 正式版 Cindy 的 worker 继承宿主的 PATH，但把常用目录补在前面更稳。
process.env.PATH = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
  process.env.PATH || ''
].join(':');

const DEFAULT_MODEL = 'deepseek-v4.1-flash';

// core.mjs 在模块求值时就读取这个变量，必须先设好再 import。
process.env.A6API_DATA_DIR =
  process.env.A6API_DATA_DIR ||
  path.join(os.tmpdir(), 'a6api-picker-cindy-' + (process.getuid ? process.getuid() : 'u'));

try {
  fs.mkdirSync(process.env.A6API_DATA_DIR, { recursive: true });
} catch {}

let corePromise = null;
function core() {
  if (corePromise === null) corePromise = import('./core.mjs');
  return corePromise;
}

// ── JSON-RPC 基础设施 ──────────────────────────────────────────────────────

function reply(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function log(message) {
  try {
    process.stderr.write('[a6api-picker] ' + String(message) + '\n');
  } catch {}
}

function fail(id, message) {
  reply({ jsonrpc: '2.0', id, result: { ok: false, error: String(message || '未知错误') } });
}

// ── 凭据 ──────────────────────────────────────────────────────────────────

/**
 * Cookie 只从宿主注入的 request.cindy.secrets 里取。
 * params.cookie 仅用于本地 dev 脚本 / CLI 直连，正式链路不会经过它。
 */
function secretCookie(request, params) {
  const injected = request && request.cindy && request.cindy.secrets && request.cindy.secrets.a6api_cookie;
  if (injected) return String(injected).trim();
  return params && typeof params.cookie === 'string' ? params.cookie.trim() : '';
}

/**
 * 用 Cookie 认出账号并验证它还有效。
 *
 * 站点现在要求 new-api-user 头，所以 /api/user/self 这条老路（上游 fetchUserId
 * 的唯一实现）对纯 Cookie 会返 401。这里先解 session cookie 里的用户 ID，再用
 * 拉令牌列表证明登录态真的可用；解不出来时才退回 fetchUserId（老站点）。
 */
async function identify(cookie) {
  const c = await core();
  const fromCookie = c.userIdFromCookie(cookie);
  if (fromCookie) {
    const tokens = await c.listTokens({ cookie, userId: fromCookie });
    if (!tokens.length) throw new Error('这个 Cookie 对应的账号没有可用令牌，登录态可能已失效');
    return { userId: fromCookie, tokenCount: tokens.length };
  }
  const userId = await c.fetchUserId(cookie);
  return { userId, tokenCount: null };
}

async function resolveCred(request, params) {
  const c = await core();
  const cookie = secretCookie(request, params);
  if (!cookie) return null;

  let userId = Number((params && params.userId) || 0) || c.userIdFromCookie(cookie) || null;
  if (!userId) {
    // session cookie 解不出来时问一次 /api/user/self（它只需要 Cookie）。
    try {
      userId = await c.fetchUserId(cookie);
    } catch (err) {
      log('fetchUserId failed: ' + err.message);
    }
  }
  return { cookie, userId };
}

// ── 行压缩（与上游 main.js 的 slim 逐字段一致） ────────────────────────────

// core 里的 costCnyPer100MInput 是纯函数，但 import 是异步的；先同步放一个占位，
// 实际调用前由启动逻辑赋真值，避免 slim 变成 async。
let rowCost = () => null;

function slim(rows) {
  return rows.map((r) => ({
    costCny100m: rowCost(r),
    id: r.id,
    sup: r.sup,
    ch: r.ch,
    ratio: r.ratio,
    ttft: r.ttft,
    ttftRaw: r.ttftRaw,
    p50: r.p50,
    tps: r.tps,
    sr24: r.sr24,
    srr: r.srr,
    srrRaw: r.srrRaw,
    cache: r.cache,
    blk: r.blk,
    n: r.n,
    score: r.score,
    stab: r.stab,
    auth: r.auth,
    rtp: r.rtp,
    parts: r.parts,
    pinned: r.pinned
  }));
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// ── 方法实现 ──────────────────────────────────────────────────────────────

const handlers = {
  async 'search/run'(request, params) {
    const c = await core();
    const cred = await resolveCred(request, params);
    const guaranteedOnly = params.guaranteed === true;
    const result = await c.collect({
      model: params.model || DEFAULT_MODEL,
      brand: guaranteedOnly ? '' : params.brand || '',
      guaranteedOnly,
      minCache: num(params.minCache),
      minSr: num(params.minSr),
      maxRatio: num(params.maxRatio),
      minSample: num(params.minSample),
      minTps: num(params.minTps),
      maxTtft: num(params.maxTtft),
      onlyQualified: params.onlyQualified !== false,
      // 没有登录态时不要把令牌 ID 带给公开接口，避免站点因为未知参数报错。
      tokenId: cred ? Number(params.tokenId || 0) || null : null,
      maxPages: 6,
      pageSize: 100,
      cred
    });

    const value = c.byValue(result.ranking).map((r, i) => ({ ...r, valueNo: i + 1 }));
    return {
      ok: true,
      ts: Date.now(),
      total: result.total,
      fetched: result.fetched,
      kept: result.kept,
      scope: result.scope,
      model: params.model || DEFAULT_MODEL,
      brand: params.brand || '',
      tokenId: result.tokenId || null,
      loggedIn: Boolean(cred && cred.cookie),
      ranking: slim(result.ranking),
      valueRanking: slim(value)
    };
  },

  async 'models/list'(request, params) {
    const c = await core();
    const cred = await resolveCred(request, params);
    const models = params.brand ? await c.fetchModelsByBrand(params.brand, cred) : await c.fetchModels();
    return { ok: true, models };
  },

  async 'brands/list'(request, params) {
    const c = await core();
    const cred = await resolveCred(request, params);
    return { ok: true, brands: await c.fetchBrands(cred) };
  },

  /** a6api.login 的同步分支：读本机浏览器里的 a6api 会话。 */
  async 'session/import'() {
    const c = await core();
    const info = c.importBrowserCookie();
    const userId = c.resolveUserId(info.cookie);
    if (!userId) throw new Error('浏览器里的 a6api 登录态里没有用户 ID，请在该浏览器打开一次 a6api.vip 再试');
    const tokens = await c.listTokens({ cookie: info.cookie, userId });
    if (!tokens.length) throw new Error('浏览器里的 a6api 登录态已失效，请重新登录 a6api.vip');
    return {
      ok: true,
      cookie: info.cookie,
      userId,
      source: info.source,
      tokenCount: tokens.length,
      tokens: tokens.map((t) => ({ id: Number(t.id), name: t.name }))
    };
  },

  /** 验证保险库里那份 Cookie 还能不能用，并换回 userId。 */
  async 'login/cookie'(request) {
    const cookie = secretCookie(request, {});
    if (!cookie) return { ok: false, error: '还没有保存 Cookie：先同步浏览器或粘贴 Cookie' };
    try {
      const who = await identify(cookie);
      return { ok: true, ...who };
    } catch (err) {
      return { ok: false, error: '这个 Cookie 用不了：' + String((err && err.message) || err) };
    }
  },

  /** 账号密码登录：POST /api/user/login，用 cookie jar 收 session。 */
  async 'login/password'(request, params) {
    const c = await core();
    const username = String(params.username || '').trim();
    const password = String(params.password || '');
    if (!username || !password) return { ok: false, error: '账号和密码都要填' };
    const jar = path.join(process.env.A6API_DATA_DIR, '.a6api-jar.txt');
    const cookie = await c.loginWithPassword(username, password, jar);
    try { fs.rmSync(jar, { force: true }); } catch {}
    const who = await identify(cookie);
    return { ok: true, cookie, ...who };
  },

  /** 同步失败时打开站点登录页（用户登录完，main.js 每 2 秒重试同步）。 */
  async 'login/open-page'() {
    const url = 'https://a6api.vip/login';
    await new Promise((resolve) => {
      try {
        execFile('open', [url], () => resolve());
      } catch {
        resolve();
      }
    });
    return { ok: true };
  },

  async 'tokens/list'(request, params) {
    const c = await core();
    const cred = await resolveCred(request, params);
    if (!cred) return { ok: false, error: '未登录' };
    return { ok: true, tokens: await c.listTokens(cred) };
  },

  async 'pin/current'(request, params) {
    const c = await core();
    const cred = await resolveCred(request, params);
    if (!cred) return { ok: false, error: '未登录' };
    const pinned = await c.fetchPinned({
      model: params.model || DEFAULT_MODEL,
      tokenId: Number(params.tokenId || 0) || null,
      cred
    });
    // row 与榜单行同构（补上 costCny100m），固定商家不在榜时对比也能直接用
    if (pinned && pinned.row) pinned.row = slim([pinned.row])[0];
    return { ok: true, pinned, tokenId: Number(params.tokenId || 0) || null };
  },

  async 'pin/set'(request, params) {
    const c = await core();
    const cred = await resolveCred(request, params);
    if (!cred) return { ok: false, error: '未登录：先点「登录 a6api」' };
    const tokenId = Number(params.tokenId || 0);
    if (!tokenId) return { ok: false, error: '没有可用令牌' };
    const data = await c.pinChannel({
      cred,
      tokenId,
      channelId: Number(params.channelId),
      model: params.model || DEFAULT_MODEL
    });
    return {
      ok: true,
      channelId: data.channel_id || Number(params.channelId),
      channelName: data.channel_name || '',
      supplierName: data.supplier_name || '',
      tokenId
    };
  },

  async 'disable/channel'(request, params) {
    const c = await core();
    const cred = await resolveCred(request, params);
    if (!cred) return { ok: false, error: '未登录：先点「登录 a6api」' };
    const channelId = Number(params.channelId || 0);
    if (!channelId) return { ok: false, error: '缺少渠道 ID' };
    await c.disableChannel({ cred, channelId, model: params.model || DEFAULT_MODEL });
    return { ok: true, channelId };
  },

  async 'balance/get'(request, params) {
    const c = await core();
    const cred = await resolveCred(request, params);
    if (!cred) return { ok: false, error: '未登录' };
    return { ok: true, balance: await c.fetchBalance(cred) };
  },

  /** a6api.status 的可达性部分：1 条、公开接口，不依赖登录。 */
  async 'status/probe'() {
    const c = await core();
    try {
      const r = await c.collect({ model: DEFAULT_MODEL, maxPages: 1, pageSize: 1, onlyQualified: false });
      return { ok: true, reachable: r.fetched > 0 };
    } catch (err) {
      return { ok: true, reachable: false, error: String((err && err.message) || err) };
    }
  }
};

// ── 启动 ──────────────────────────────────────────────────────────────────

(async () => {
  const c = await core();
  rowCost = (r) => {
    const v = c.costCnyPer100MInput(r);
    return v === null || v === undefined ? null : Math.round(v * 1000) / 1000;
  };
  log('ready, dataDir=' + process.env.A6API_DATA_DIR);

  readline.createInterface({ input: process.stdin }).on('line', async (line) => {
    if (!line.trim()) return;
    let request;
    try {
      request = JSON.parse(line);
    } catch (err) {
      log('bad json: ' + err.message);
      return;
    }

    const { id, method, params } = request;
    const fn = handlers[method];
    if (!fn) {
      reply({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
      return;
    }

    try {
      const result = await fn(request, params || {});
      reply({ jsonrpc: '2.0', id, result });
    } catch (err) {
      log(method + ' failed: ' + (err && err.stack ? err.stack : err));
      fail(id, (err && err.message) || err);
    }
  });
})();
