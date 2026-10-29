// Cindy 电子脑：面板/设置页 ↔ 随包 Node worker 的桥。
//
// 链路：panel.html / settings.html --BroadcastChannel--> main.js
//       main.js --cindy.node.request--> node/worker.cjs --curl--> a6api.com
//
// 这里刻意保持很薄：
//   - Cookie 不经过面板广播：面板直接 PUT /secrets，宿主保险库保管；worker 通过
//     node.secretBindings 的 request.cindy.secrets.a6api_cookie 拿到本次调用的值。
//   - 浏览器登录同步是例外：worker 读到的 Cookie 直接交给宿主保险库（PUT /secrets），
//     不回到面板、不写 /kv。
//   - 榜单快照写 fs root:'data'，筛选条件/用户 ID/令牌选择写 /kv。

const CHANNEL = 'a6api-picker';
const DATA_FILE = 'last.json';

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

// ── 快照（插件私有数据目录） ────────────────────────────────────────────────

async function saveLast(payload) {
  try {
    await cindy.fs({ op: 'write', root: 'data', path: DATA_FILE, content: JSON.stringify(payload) });
  } catch {}
}

async function loadLast() {
  try {
    const res = await cindy.fs({ op: 'read', root: 'data', path: DATA_FILE });
    if (!res || !res.ok) return null;
    const text = typeof res.content === 'string' ? res.content : res.content && res.content.toString();
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

// ── worker 调用 ────────────────────────────────────────────────────────────

const TIMEOUTS = {
  // 6 页 × 最多 30s curl 超时，慢网络下可能接近 2 分钟；Cindy 单次 node 请求上限 120s。
  'search/run': 110000,
  'models/list': 60000,
  'brands/list': 60000,
  'session/import': 45000,
  'session/probe': 45000,
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

// ── 面板 RPC ──────────────────────────────────────────────────────────────

async function panelState() {
  const [kv, secret, last] = await Promise.all([readKv(), secretStatus(), loadLast()]);
  return {
    ok: true,
    hasCookie: secret.saved || (secret.unknown && Boolean(kv.hasCookie)),
    cookieTail: secret.tail,
    userId: kv.userId || null,
    tokenId: kv.tokenId || null,
    last: last && last.data ? last : null
  };
}

async function handleRpc(method, params) {
  const p = params && typeof params === 'object' ? params : {};

  switch (method) {
    case 'panel/state':
      return panelState();

    case 'config/save': {
      const kv = await writeKv(p);
      return { ok: true, userId: kv.userId || null, tokenId: kv.tokenId || null };
    }

    case 'search/run': {
      const kv = await readKv();
      const result = await callWorker('search/run', { ...p, userId: kv.userId || undefined });
      if (result.ok) {
        await saveLast({ params: p, data: result, ts: Date.now() });
      }
      return result;
    }

    case 'models/list':
      return callWorker('models/list', p);
    case 'brands/list':
      return callWorker('brands/list', p);

    case 'session/import': {
      const result = await callWorker('session/import', {});
      if (!result.ok) return result;
      // Cookie 只在 worker → main → 保险库之间流动，不回给面板。
      await saveSecret(result.cookie);
      if (result.userId) await writeKv({ userId: result.userId });
      broadcast({ type: 'state-changed' });
      return {
        ok: true,
        userId: result.userId,
        source: result.source,
        tokenCount: result.tokenCount,
        tokens: result.tokens || []
      };
    }

    case 'session/probe': {
      const kv = await readKv();
      const result = await callWorker('session/probe', { userId: kv.userId || undefined });
      if (result.ok && result.userId && result.userId !== kv.userId) {
        await writeKv({ userId: result.userId });
      }
      return result;
    }

    case 'session/logout': {
      await clearSecret();
      await writeKv({ userId: null, tokenId: null, hasCookie: false });
      broadcast({ type: 'state-changed' });
      return { ok: true };
    }

    case 'tokens/list':
      return callWorker('tokens/list', p);
    case 'pin/current':
      return callWorker('pin/current', p);
    case 'pin/set': {
      const result = await callWorker('pin/set', p);
      if (result.ok && result.tokenId) await writeKv({ tokenId: result.tokenId });
      return result;
    }
    case 'disable/channel':
      return callWorker('disable/channel', p);
    case 'balance/get':
      return callWorker('balance/get', p);

    default:
      return { ok: false, error: '未知方法：' + method };
  }
}

// ── BroadcastChannel 桥 ────────────────────────────────────────────────────

const channel = new BroadcastChannel(CHANNEL);
const replies = new Map(); // reqId -> { ts, payload }

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

    let result;
    try {
      result = await handleRpc(String(data.method || ''), data.params || {});
    } catch (err) {
      result = { ok: false, error: String((err && err.message) || err) };
    }
    const payload = { type: 'rpc-reply', reqId: data.reqId, ...result };
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

function formatRows(result, limit) {
  const rows = (result.ranking || []).slice(0, limit);
  if (!rows.length) {
    return '没有渠道通过当前筛选。可以放宽缓存/成功率/首字/倍率条件，或换一个模型名再试。';
  }
  const lines = rows.map((r, i) => {
    const cost = r.costCny100m === null || r.costCny100m === undefined ? '-' : '¥' + Number(r.costCny100m).toFixed(2) + '/1亿';
    return (
      `${i + 1}. #${r.id} ${r.sup || '(未命名商家)'}  综合 ${r.score}  成本 ${cost}  ` +
      `首字 ${(Number(r.ttft) / 1000).toFixed(2)}s  吞吐 ${Math.round(Number(r.tps) || 0)} tok/s  ` +
      `近期成功率 ${((Number(r.srr) || 0) / 100).toFixed(1)}%  缓存 ${((Number(r.cache) || 0) / 100).toFixed(0)}%  ` +
      `倍率 ${r.ratio}` + (r.pinned ? '  ✓当前固定' : '')
    );
  });
  const scope = result.scope === 'public' ? '未登录（公开接口，看不到固定状态）' : '已登录';
  return (
    `A6API 渠道榜单 · ${result.model || ''} · ${scope}\n` +
    `接口 ${result.total} 条，抓到 ${result.fetched} 条，达标 ${result.kept} 条，参与排名 ${(result.ranking || []).length} 条。\n\n` +
    lines.join('\n') +
    `\n\n成本口径：1 亿输入 + 25 万输出 token，按各渠道自己的缓存命中率折算成人民币。` +
    `\n评分：有效率/价格/稳定性/首字/吞吐 各 20%。` +
    `\n固定或禁用渠道请让用户在右侧栏「A6API 渠道」面板里操作。`
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
      model: args.model || 'deepseek-v4.1-flash',
      brand: args.brand || '',
      minCache: args.minCache,
      minSr: args.minSr,
      maxRatio: args.maxRatio,
      maxTtft: args.maxTtft,
      minTps: args.minTps,
      minSample: args.minSample,
      onlyQualified: true,
      userId: kv.userId || undefined
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
        '。可以在右侧栏「A6API 渠道」面板里点「刷新榜单」重试；如果一直失败，检查网络或代理是否能访问 a6api.com。'
    });
    return;
  }

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
