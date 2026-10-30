// Cindy 电子脑：面板/设置页 ↔ 随包 Node worker 的桥。
//
// 链路：panel.html / settings.html --BroadcastChannel--> main.js
//       main.js --cindy.node.request--> node/worker.cjs --curl--> a6api.vip
//
// 上游 pi-a6api 0.3.10 的 main.js 把凭据落在插件数据目录（a6api-session.json），
// Cindy 里没有「插件自己拿一个磁盘路径」这回事，所以持久化拆成三处：
//   - Cookie：宿主保险库（node.secretBindings.a6api_cookie），按方法临时注入 worker；
//     面板/设置页 PUT /secrets 写入，main.js 只写不读明文。
//   - userId / tokenId / 筛选条件：插件 /kv。
//   - 上次榜单 last.json、收藏 favorites.json：fs root:'data'（插件私有数据目录）。
//
// 方法名与上游 a6api.* 通道一一对应（见 README 的对照表）。网络与登录解析都在
// worker 里，收藏/快照这类要落盘的留在这一层（沙箱里只有 main.js 能写 fs）。

const CHANNEL = 'a6api-picker';
const LAST_FILE = 'last.json';
const FAV_FILE = 'favorites.json';
const FILTERS_FILE = 'filters.json';

/** 与 pi-a6api 0.3.10 的 ALGO_VERSION 保持一致；算法口径一变就递增，旧快照自动作废。 */
const ALGO_VERSION = 75;

/** 默认模型；面板/工具没指定时用它。 */
const DEFAULT_MODEL = 'deepseek-v4.1-flash';

// ── /kv ────────────────────────────────────────────────────────────────────

async function readKv() {
  try {
    const res = await fetch('/kv');
    if (!res.ok) return {};
    const cfg = await res.json();
    return cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg : {};
  } catch {
    return {};
  }
}

async function writeKv(patch) {
  const current = await readKv();
  const next = { ...current, ...(patch || {}) };
  await fetch('/kv', { method: 'PUT', body: JSON.stringify(next) });
  return next;
}

// ── 凭据（只写，不回读明文） ────────────────────────────────────────────────

async function secretStatus() {
  try {
    const list = await (await fetch('/secrets')).json();
    const hit = Array.isArray(list) ? list.find((x) => x && x.key === 'a6api_cookie') : null;
    return { saved: Boolean(hit && hit.saved), tail: (hit && hit.tail) || null, unknown: false };
  } catch {
    return { saved: false, tail: null, unknown: true };
  }
}

async function saveSecret(value) {
  const res = await fetch('/secrets/a6api_cookie', {
    method: 'PUT',
    body: JSON.stringify({ value: String(value) })
  });
  if (!res.ok) throw new Error('Cookie 没能写入宿主保险库（HTTP ' + res.status + '）');
  // /secrets 只能看到 saved/tail；再记一个非敏感标记，供 /secrets 查询失败时兜底。
  await writeKv({ hasCookie: true });
}

async function clearSecret() {
  try {
    await fetch('/secrets/a6api_cookie', { method: 'DELETE' });
  } catch {}
}

async function sessionState() {
  const kv = await readKv();
  const secret = await secretStatus();
  return {
    loggedIn: Boolean(secret.saved || (secret.unknown && Boolean(kv.hasCookie))),
    userId: kv.userId || null,
    tokenId: kv.tokenId || null,
    updatedAt: kv.sessionUpdatedAt || null
  };
}

// ── 插件私有数据目录（fs root:'data'） ──────────────────────────────────────

async function readDataFile(path) {
  try {
    const res = await cindy.fs({ op: 'read', root: 'data', path });
    if (!res || !res.ok) return null;
    const text = typeof res.content === 'string' ? res.content : res.content ? String(res.content) : '';
    return text || null;
  } catch {
    return null;
  }
}

async function writeDataFile(path, text) {
  try {
    const res = await cindy.fs({ op: 'write', root: 'data', path, content: text });
    return Boolean(res && res.ok);
  } catch {
    return false;
  }
}

async function saveLast(payload) {
  await writeDataFile(LAST_FILE, JSON.stringify(payload));
}

async function loadLast() {
  const text = await readDataFile(LAST_FILE);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ── worker 调用 ────────────────────────────────────────────────────────────

const TIMEOUTS = {
  // 6 页 × 最多 30s curl 超时，慢网络下可能接近 2 分钟；Cindy 单次 node 请求上限 120s。
  'search/run': 110000,
  'status/probe': 60000,
  'models/list': 60000,
  'brands/list': 60000,
  'session/import': 60000,
  'login/cookie': 45000,
  'login/password': 60000,
  'login/open-page': 15000,
  'tokens/list': 45000,
  'pin/current': 45000,
  'pin/set': 45000,
  'disable/channel': 45000,
  'balance/get': 45000
};

async function callWorker(method, params, callCtx) {
  const timeoutMs = TIMEOUTS[method] || 60000;
  let response;
  try {
    response = await cindy.node.request({
      method,
      params: params && typeof params === 'object' ? params : {},
      timeoutMs,
      ...(callCtx && callCtx.callId ? { callId: callCtx.callId, cancelWithCall: true } : {})
    });
  } catch (err) {
    return { ok: false, error: 'Node 进程没能启动：' + String((err && err.message) || err) };
  }
  if (!response || !response.ok) {
    return { ok: false, error: (response && response.message) || 'Node 进程没有响应' };
  }
  const result = response.result;
  return result && typeof result === 'object' ? result : { ok: true, result };
}

// ── 浏览器登录同步 ──────────────────────────────────────────────────────────

async function syncFromBrowser() {
  const r = await callWorker('session/import', {});
  if (!r.ok) throw new Error(r.error || '浏览器里没有 a6api 登录态');
  await saveSecret(r.cookie);
  await writeKv({ userId: r.userId, hasCookie: true, sessionUpdatedAt: Date.now() });
  broadcast({ type: 'state-changed' });
  return r;
}

/**
 * 打开登录页后每 2 秒重试同步，最多盯 5 分钟。
 * 上游 PI 版就是这个行为：用户去浏览器登录完，回到面板自动变成已登录。
 * 面板侧还会每 3 秒重发一次 login，所以就算电子脑被回收也能续上。
 */
let loginWatch = null;

function stopLoginWatch() {
  if (loginWatch) {
    clearInterval(loginWatch);
    loginWatch = null;
  }
}

function watchBrowserLogin() {
  if (loginWatch) return;
  const started = Date.now();
  loginWatch = setInterval(async () => {
    if (Date.now() - started > 5 * 60 * 1000) {
      stopLoginWatch();
      return;
    }
    try {
      await syncFromBrowser();
      stopLoginWatch();
    } catch {}
  }, 2000);
}

// ── 收藏 ────────────────────────────────────────────────────────────────────
//
// 和上游一致：键是「模型名 + 渠道 ID」，每条额外存一份数据快照 —— 这样它当前
// 不在榜上时仍能显示上次看到的值，刷新时再覆盖。落盘在插件私有数据目录。

async function readFav() {
  const text = await readDataFile(FAV_FILE);
  if (!text) return {};
  try {
    const raw = JSON.parse(text);
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

async function writeFav(data) {
  return writeDataFile(FAV_FILE, JSON.stringify(data, null, 2) + '\n');
}

async function favList(p) {
  const model = p.model || DEFAULT_MODEL;
  const all = await readFav();
  return { ok: true, model, items: Array.isArray(all[model]) ? all[model] : [] };
}

async function favSet(p) {
  const model = p.model || DEFAULT_MODEL;
  const channelId = Number(p.channelId || 0);
  if (!channelId) return { ok: false, error: '缺少渠道 ID' };

  const all = await readFav();
  const list = Array.isArray(all[model]) ? all[model] : [];
  const rest = list.filter((x) => Number(x.channelId) !== channelId);
  if (p.on !== false) {
    rest.push({ channelId, addedAt: Date.now(), snapshot: p.snapshot ?? null, down: false });
  }
  all[model] = rest;
  if (!(await writeFav(all))) return { ok: false, error: '收藏写不进插件数据目录' };
  return { ok: true, model, items: rest };
}

/** 用最新榜单覆盖快照；榜里没有的标 down（下架，或该模型对它已停售）。 */
async function favRefresh(p) {
  const model = p.model || DEFAULT_MODEL;
  const rows = Array.isArray(p.rows) ? p.rows : [];
  const byId = new Map(rows.map((r) => [Number(r.id), r]));

  const all = await readFav();
  const list = Array.isArray(all[model]) ? all[model] : [];
  all[model] = list.map((item) => {
    const fresh = byId.get(Number(item.channelId));
    return fresh
      ? { ...item, snapshot: fresh, down: false, refreshedAt: Date.now() }
      : { ...item, down: true, refreshedAt: Date.now() };
  });
  if (!(await writeFav(all))) return { ok: false, error: '收藏写不进插件数据目录' };
  return { ok: true, model, items: all[model] };
}

// ── 方法表（对应上游 a6api.* 通道） ────────────────────────────────────────

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

const METHODS = {
  // a6api.search
  async 'search/run'(p) {
    const kv = await readKv();
    const params = {
      model: p.model || DEFAULT_MODEL,
      brand: p.guaranteed === true ? '' : p.brand || '',
      guaranteed: p.guaranteed === true,
      minCache: num(p.minCache),
      minSr: num(p.minSr),
      maxRatio: num(p.maxRatio),
      minSample: num(p.minSample),
      minTps: num(p.minTps),
      maxTtft: num(p.maxTtft),
      onlyQualified: p.onlyQualified !== false,
      tokenId: Number(p.tokenId || kv.tokenId || 0) || null,
      userId: kv.userId || undefined
    };
    const result = await callWorker('search/run', params);
    if (!result.ok) return result;
    const payload = { ...result, algo: ALGO_VERSION };
    await saveLast({ params: p, data: payload, ts: Date.now() });
    return payload;
  },

  // a6api.last
  async 'last/get'() {
    const saved = await loadLast();
    const stale = !saved || !saved.data || saved.data.algo !== ALGO_VERSION;
    return stale ? { ok: true, data: null, stale: true } : { ok: true, ...saved };
  },

  // a6api.balance
  async 'balance/get'() {
    const kv = await readKv();
    return callWorker('balance/get', { userId: kv.userId || undefined });
  },

  // a6api.brands
  async 'brands/list'(p) {
    const kv = await readKv();
    return callWorker('brands/list', { brand: p.brand || '', userId: kv.userId || undefined });
  },

  // a6api.models
  async 'models/list'(p) {
    const kv = await readKv();
    return callWorker('models/list', { brand: p.brand || '', userId: kv.userId || undefined });
  },

  // a6api.session（允许面板把选中的令牌写回，重开界面不被重置）
  async 'session/get'(p) {
    if (p.tokenId !== undefined) {
      await writeKv({ tokenId: Number(p.tokenId || 0) || null, sessionUpdatedAt: Date.now() });
    }
    return { ok: true, ...(await sessionState()) };
  },

  // a6api.login —— 先试浏览器同步；失败就开登录页并后台盯 5 分钟
  async 'login/browser'() {
    try {
      const r = await syncFromBrowser();
      return { ok: true, mode: 'sync', userId: r.userId, tokenCount: r.tokenCount, source: r.source };
    } catch (error) {
      try {
        await callWorker('login/open-page', {});
      } catch {}
      watchBrowserLogin();
      return {
        ok: true,
        mode: 'browser',
        reason: '已打开 a6api 登录页，登录完成后这里会自动变成已登录（' + String((error && error.message) || error) + '）'
      };
    }
  },

  // a6api.login.cookie —— Cookie 一般已由面板写进保险库；带 cookie 时这里补写
  async 'login/cookie'(p) {
    if (typeof p.cookie === 'string' && p.cookie.trim()) await saveSecret(p.cookie.trim());
    const r = await callWorker('login/cookie', {});
    if (!r.ok) return r;
    await writeKv({ userId: r.userId || null, hasCookie: true, sessionUpdatedAt: Date.now() });
    broadcast({ type: 'state-changed' });
    return { ok: true, userId: r.userId || null };
  },

  // a6api.login.password —— 账号密码登录（worker 走 /api/user/login + cookie jar）
  async 'login/password'(p) {
    const username = String(p.username || '').trim();
    const password = String(p.password || '');
    if (!username || !password) return { ok: false, error: '账号和密码都要填' };
    const r = await callWorker('login/password', { username, password });
    if (!r.ok) return r;
    await saveSecret(r.cookie);
    await writeKv({ userId: r.userId || null, hasCookie: true, sessionUpdatedAt: Date.now() });
    broadcast({ type: 'state-changed' });
    return { ok: true, userId: r.userId || null };
  },

  // a6api.logout
  async logout() {
    stopLoginWatch();
    await clearSecret();
    await writeKv({ userId: null, tokenId: null, hasCookie: false, sessionUpdatedAt: null });
    broadcast({ type: 'state-changed' });
    return { ok: true };
  },

  // a6api.tokens
  async 'tokens/list'() {
    const kv = await readKv();
    const r = await callWorker('tokens/list', { userId: kv.userId || undefined });
    if (!r.ok) return r;
    const tokens = Array.isArray(r.tokens) ? r.tokens : [];
    const wanted = Number(kv.tokenId || 0) || 0;
    const tokenId =
      (wanted && tokens.some((t) => Number(t.id) === wanted) ? wanted : null) ||
      (tokens[0] && Number(tokens[0].id)) ||
      null;
    if (tokenId !== (kv.tokenId || null)) await writeKv({ tokenId });
    return { ok: true, tokens, tokenId };
  },

  // a6api.pin.current
  async 'pin/current'(p) {
    const kv = await readKv();
    const tokenId = Number(p.tokenId || kv.tokenId || 0) || null;
    const r = await callWorker('pin/current', {
      model: p.model || DEFAULT_MODEL,
      tokenId,
      userId: kv.userId || undefined
    });
    if (r.ok && tokenId && tokenId !== (kv.tokenId || null)) await writeKv({ tokenId });
    return r;
  },

  // a6api.pin
  async 'pin/set'(p) {
    const kv = await readKv();
    const tokenId = Number(p.tokenId || kv.tokenId || 0);
    if (!tokenId) return { ok: false, error: '没有可用令牌' };
    const r = await callWorker('pin/set', {
      channelId: Number(p.channelId || 0),
      model: p.model || DEFAULT_MODEL,
      tokenId,
      userId: kv.userId || undefined
    });
    if (r.ok) await writeKv({ tokenId });
    return r;
  },

  // a6api.disable
  async 'disable/channel'(p) {
    const kv = await readKv();
    return callWorker('disable/channel', {
      channelId: Number(p.channelId || 0),
      model: p.model || DEFAULT_MODEL,
      userId: kv.userId || undefined
    });
  },

  // a6api.status
  async 'status/get'() {
    const r = await callWorker('status/probe', {});
    const state = await sessionState();
    return {
      ok: true,
      ...state,
      reachable: Boolean(r.ok && r.reachable),
      model: DEFAULT_MODEL,
      algo: ALGO_VERSION
    };
  },

  // a6api.fav.list / a6api.fav.set / a6api.fav.refresh
  'fav/list': favList,
  'fav/set': favSet,
  'fav/refresh': favRefresh,

  // 面板筛选条件（上游用 localStorage；Cindy 存插件数据目录 filters.json，
  // 与 last.json / favorites.json 同一处：Cindy 的 ghost-fs data 目录）
  async 'filters/get'() {
    const text = await readDataFile(FILTERS_FILE);
    if (!text) return { ok: true, filters: null };
    try {
      const v = JSON.parse(text);
      return { ok: true, filters: v && typeof v === 'object' && !Array.isArray(v) ? v : null };
    } catch {
      return { ok: true, filters: null };
    }
  },
  async 'filters/save'(p) {
    const filters = p.filters && typeof p.filters === 'object' ? p.filters : null;
    if (!filters) return { ok: false, error: '缺少 filters' };
    const ok = await writeDataFile(FILTERS_FILE, JSON.stringify(filters));
    return ok ? { ok: true } : { ok: false, error: '筛选条件写入失败' };
  },

  // 设置页状态 / 通用配置写回
  async 'panel/state'() {
    const [kv, secret, last] = await Promise.all([readKv(), secretStatus(), loadLast()]);
    return {
      ok: true,
      hasCookie: secret.saved || (secret.unknown && Boolean(kv.hasCookie)),
      cookieTail: secret.tail,
      userId: kv.userId || null,
      tokenId: kv.tokenId || null,
      loggedIn: Boolean(secret.saved || (secret.unknown && Boolean(kv.hasCookie))),
      last: last && last.data ? last : null
    };
  },
  async 'config/save'(p) {
    const patch = {};
    for (const key of ['userId', 'tokenId', 'hasCookie']) {
      if (p[key] !== undefined) patch[key] = p[key];
    }
    const kv = await writeKv(patch);
    return { ok: true, userId: kv.userId || null, tokenId: kv.tokenId || null };
  }
};

async function handleRpc(method, params) {
  const handler = METHODS[method];
  if (!handler) return { ok: false, error: '未知方法：' + method };
  const p = params && typeof params === 'object' ? params : {};
  try {
    return await handler(p);
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

// ── BroadcastChannel 桥 ────────────────────────────────────────────────────

const channel = new BroadcastChannel(CHANNEL);
const replies = new Map(); // reqId -> { ts, method, payload }

function broadcast(payload) {
  try {
    channel.postMessage(payload);
  } catch {}
}

function sameRequest(a, b) {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

channel.onmessage = async (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;

  // 面板/设置页可能因为电子脑刚被唤醒而重发同一个 reqId；直接回放上次结果。
  if (data.type === 'rpc' && data.reqId) {
    const prev = replies.get(data.reqId);
    if (prev && sameRequest(prev.method, data.method)) {
      if (Date.now() - prev.ts < 120000) {
        channel.postMessage(prev.payload);
      } else {
        replies.delete(data.reqId);
      }
      return;
    }

    const payload = { type: 'rpc-reply', reqId: data.reqId, ...(await handleRpc(String(data.method || ''), data.params || {})) };
    replies.set(data.reqId, { ts: Date.now(), method: data.method, payload });
    channel.postMessage(payload);

    // 只保留最近 200 条，避免长期开着面板时无限增长。
    if (replies.size > 200) {
      const oldest = [...replies.entries()].sort((a, b) => a[1].ts - b[1].ts).slice(0, replies.size - 200);
      for (const [key] of oldest) replies.delete(key);
    }
    return;
  }

  if (data.type === 'wake') {
    channel.postMessage({ type: 'awake', ts: Date.now() });
  }
};

// ── Agent 工具 ─────────────────────────────────────────────────────────────

function pct(v) {
  return v === null || v === undefined ? '-' : (Number(v) / 100).toFixed(1) + '%';
}

function sec(ms) {
  if (ms === null || ms === undefined) return '-';
  return Number(ms) >= 1000 ? (Number(ms) / 1000).toFixed(2) + 's' : Math.round(Number(ms)) + 'ms';
}

function money(v) {
  return v === null || v === undefined ? '-' : '¥' + Number(v).toFixed(2);
}

function formatRank(rows, limit) {
  return rows.slice(0, limit).map((r, i) => {
    return (
      `${i + 1}. #${r.id} ${r.sup || '(未命名商家)'}  ${r.score}分  ` +
      `${money(r.costCny100m)}/亿  倍率×${r.ratio}  首字${sec(r.ttft)}  缓存${pct(r.cache)}  ` +
      `成功率${pct(r.sr24)}  吞吐${r.tps == null ? '-' : Math.round(Number(r.tps))}` +
      (r.auth ? '  保真' : '') +
      (r.pinned ? '  ✓当前固定' : '')
    );
  });
}

function formatRows(result, limit) {
  const ranking = Array.isArray(result.ranking) ? result.ranking : [];
  const value = Array.isArray(result.valueRanking) ? result.valueRanking : [];
  if (!ranking.length && !value.length) {
    return '没有渠道通过当前筛选。可以放宽缓存/成功率/首字/倍率条件，或换一个模型名再试。';
  }
  const scope = result.scope === 'public' ? '未登录（公开接口，看不到固定状态）' : '已登录';
  return (
    `A6API 渠道榜单 · ${result.model || ''} · ${scope}\n` +
    `接口 ${result.total} 条，抓到 ${result.fetched} 条，达标 ${result.kept} 条，参与排名 ${ranking.length} 条。\n\n` +
    `【综合榜】稳定性 + 成功率 + 延迟 + 缓存 + 价格加权\n` +
    (formatRank(ranking, limit).join('\n') || '（空）') +
    `\n\n【性价比榜】性能分 × 价格分，单位成本更低的排前面\n` +
    (formatRank(value, 5).join('\n') || '（空）') +
    `\n\n成本口径：1 亿输入 + 25 万输出 token，按各渠道自己的 24h 缓存命中率折算成人民币。` +
    `\n固定渠道、禁用渠道、收藏渠道、两家对比都在右侧栏「A6API 渠道」面板里操作。`
  );
}

async function handleToolCall(msg) {
  if (msg.tool !== 'a6api_channel_search') {
    await cindy.send({
      type: 'tool-result',
      callId: msg.callId,
      ok: false,
      errorCode: 'UNKNOWN_TOOL',
      message: '这个插件只有 a6api_channel_search 一个工具。'
    });
    return;
  }

  const args = msg.args || {};
  const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 30);
  const kv = await readKv();
  const result = await callWorker(
    'search/run',
    {
      model: args.model || DEFAULT_MODEL,
      brand: args.guaranteed === true ? '' : args.brand || '',
      guaranteed: args.guaranteed === true,
      minCache: num(args.minCache),
      minSr: num(args.minSr),
      maxRatio: num(args.maxRatio),
      maxTtft: num(args.maxTtft),
      minTps: num(args.minTps),
      minSample: num(args.minSample),
      onlyQualified: args.onlyQualified !== false,
      userId: kv.userId || undefined,
      tokenId: Number(kv.tokenId || 0) || null
    },
    { callId: msg.callId }
  );

  if (!result.ok) {
    await cindy.send({
      type: 'tool-result',
      callId: msg.callId,
      ok: false,
      errorCode: 'A6API_FAILED',
      message:
        (result.error || '拉取 A6API 渠道失败') +
        '。可以在右侧栏「A6API 渠道」面板里点「刷新」重试；如果一直失败，检查网络或代理是否能访问 a6api.vip。'
    });
    return;
  }

  // 顺手留一份快照：用户随后打开面板时直接有榜可看，不用再等一次网络往返。
  await saveLast({ params: args, data: { ...result, algo: ALGO_VERSION }, ts: Date.now() });

  await cindy.send({
    type: 'tool-result',
    callId: msg.callId,
    ok: true,
    result: { content: formatRows(result, limit) }
  });
}

cindy.onHostMessage(async (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'tool-call') {
    await handleToolCall(msg);
    return;
  }
  if (msg.type === 'event' && msg.name === 'node-status') {
    broadcast({ type: 'node-status', state: msg.state });
  }
});

// worker 崩溃/重启时给面板一个提示（面板据此显示"重试"）。
broadcast({ type: 'main-ready' });
