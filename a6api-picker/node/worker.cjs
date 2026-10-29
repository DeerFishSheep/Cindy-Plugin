// Cindy 随包 Node worker：A6API 渠道抓取 / 评分 / 固定。
//
// 抓取与评分算法原样来自 dsh-a6api 的 lib/core.mjs（唯一的改动是把固定写死的
// ~/.dsh 换成 A6API_DATA_DIR，见 core.mjs 顶部注释）。这里只做四件事：
//   1. 把宿主注入的 Cookie（node.secretBindings）整理成 core 要的 cred
//   2. 把 core 的返回压成面板要的紧凑结构
//   3. 用一行一个 JSON-RPC 对象跟 main.js 通信（日志只走 stderr）
//   4. 从本机 Chrome 读 a6api 登录态（Cookie + userId）
//
// 持久化边界：Cookie 由宿主保险库保管（main.js 经 /secrets 写入），userId/令牌
// 选择在 /kv，榜单快照在 fs root:'data'。本进程只把 A6API_DATA_DIR 指到系统临时
// 目录，用来放 Chrome Cookies 的临时拷贝和模型缓存，不写 ~/.dsh。

const readline = require('node:readline');
const os = require('node:os');
const path = require('node:path');

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

// core.mjs 在模块求值时就读取这个变量，必须先设好再 import。
process.env.A6API_DATA_DIR =
  process.env.A6API_DATA_DIR || path.join(os.tmpdir(), 'cindy-a6api-picker-' + (process.getuid ? process.getuid() : 'u'));

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

function secretCookie(request, params) {
  const injected = request && request.cindy && request.cindy.secrets && request.cindy.secrets.a6api_cookie;
  if (injected) return String(injected).trim();
  // 兼容 CLI / 本地调试：只在显式传 params.cookie 时使用，正式链路走宿主注入。
  return params && typeof params.cookie === 'string' ? params.cookie.trim() : '';
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

function slim(rows) {
  const c = rowCost;
  return rows.map((r) => ({
    costCny100m: c(r),
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

// core 里的 costCnyPer100MInput 是纯函数，但 import 是异步的；先同步放一个占位，
// 实际调用前由 init 赋真值，避免 slim 变成 async。
let rowCost = () => null;

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
      model: params.model || '',
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

    const value = c.byValue(result.ranking);
    return {
      ok: true,
      model: result.model || params.model || '',
      total: result.total,
      fetched: result.fetched,
      kept: result.kept,
      scope: result.scope,
      tokenId: result.tokenId,
      ts: result.ts,
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

  async 'session/import'(request) {
    const c = await core();
    const info = c.importBrowserCookie();
    const userId = c.resolveUserId(info.cookie);
    if (!userId) throw new Error('浏览器里的 a6api 登录态里没有用户 ID，请在该浏览器打开一次 a6api.com 再试');
    const tokens = await c.listTokens({ cookie: info.cookie, userId });
    if (!tokens.length) throw new Error('浏览器里的 a6api 登录态已失效，请重新登录 a6api.com');
    return {
      ok: true,
      cookie: info.cookie,
      userId,
      source: info.source,
      tokenCount: tokens.length,
      tokens: tokens.map((t) => ({ id: Number(t.id), name: t.name }))
    };
  },

  async 'session/probe'(request, params) {
    const c = await core();
    const cred = await resolveCred(request, params);
    if (!cred) return { ok: false, error: '未登录：没有 Cookie', loggedIn: false };
    const userId = cred.userId || (await c.fetchUserId(cred.cookie));
    let tokens = [];
    try {
      tokens = await c.listTokens({ cookie: cred.cookie, userId });
    } catch (err) {
      log('listTokens failed: ' + err.message);
    }
    return { ok: true, loggedIn: true, userId, tokenCount: tokens.length, tokens };
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
      model: params.model || '',
      tokenId: Number(params.tokenId || 0) || null,
      cred
    });
    if (pinned && pinned.row) pinned.row = slim([pinned.row])[0];
    return { ok: true, pinned };
  },

  async 'pin/set'(request, params) {
    const c = await core();
    const cred = await resolveCred(request, params);
    if (!cred) return { ok: false, error: '未登录：先同步浏览器登录或粘贴 Cookie' };
    const tokenId = Number(params.tokenId || 0);
    if (!tokenId) return { ok: false, error: '没有可用令牌' };
    const data = await c.pinChannel({
      cred,
      tokenId,
      channelId: Number(params.channelId),
      model: params.model || ''
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
    if (!cred) return { ok: false, error: '未登录：先同步浏览器登录或粘贴 Cookie' };
    const channelId = Number(params.channelId || 0);
    if (!channelId) return { ok: false, error: '缺少渠道 ID' };
    await c.disableChannel({ cred, channelId, model: params.model || '' });
    return { ok: true, channelId };
  },

  async 'balance/get'(request, params) {
    const c = await core();
    const cred = await resolveCred(request, params);
    if (!cred) return { ok: false, error: '未登录' };
    return { ok: true, balance: await c.fetchBalance(cred) };
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
