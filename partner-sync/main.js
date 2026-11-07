// 伙伴同步 — 电子脑：面板 ↔ 随包 Node worker 的桥。
//
// panel.html --BroadcastChannel--> main.js --cindy.node.request--> node/worker.cjs
// 实质读写全在 worker（真 Node 进程，能访问伙伴目录）。

const CHANNEL = 'partner-sync';

async function callWorker(method, params) {
  let response;
  try {
    response = await cindy.node.request({ method, params: params || {}, timeoutMs: 30000 });
  } catch (error) {
    return { ok: false, error: 'Node 工作进程没能启动：' + String((error && error.message) || error) };
  }
  if (!response || response.ok !== true) {
    return { ok: false, error: (response && response.message) || 'Node 工作进程没有响应' };
  }
  const result = response.result;
  if (!result || typeof result !== 'object') {
    return { ok: false, error: 'Node 工作进程返回了非预期结果' };
  }
  return result;
}

async function handleRpc(method, params) {
  const known = [
    'partners/list',
    'partners/soul',
    'partners/memories',
    'memories/delete',
    'sync/soul',
    'sync/memories',
    'sync/backups',
    'sync/restore'
  ];
  if (!known.includes(method)) return { ok: false, error: '未知方法：' + method };
  return callWorker(method, params);
}

// ── Agent 工具 ─────────────────────────────────────────────────────────────

cindy.onHostMessage(async (msg) => {
  if (msg.type !== 'tool-call') return;

  if (msg.tool !== 'partner_sync_list') {
    await cindy.send({
      type: 'tool-result',
      callId: msg.callId,
      ok: false,
      errorCode: 'UNKNOWN_TOOL',
      message: '这个插件只提供 partner_sync_list；同步操作在右侧栏「伙伴同步」面板里做。'
    });
    return;
  }

  const r = await callWorker('partners/list', {});
  if (!r.ok) {
    await cindy.send({
      type: 'tool-result',
      callId: msg.callId,
      ok: false,
      errorCode: 'NODE_REQUEST_FAILED',
      message: r.error || '读取伙伴列表失败'
    });
    return;
  }

  const content = r.partners
    .map((p) => '- ' + p.name + '：Soul ' + p.soulBytes + ' 字节，' + p.memoryCount + ' 条记忆')
    .join('\n');
  await cindy.send({
    type: 'tool-result',
    callId: msg.callId,
    ok: true,
    result: { content: content || '没有找到伙伴。' }
  });
});

// ── BroadcastChannel 桥 ────────────────────────────────────────────────────

const channel = new BroadcastChannel(CHANNEL);
const replies = new Map();

channel.onmessage = async (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;

  if (data.type === 'rpc' && data.reqId) {
    // 面板会重发同一个 reqId 直到收到回执；结果直接回放，避免重复写。
    const prev = replies.get(data.reqId);
    if (prev && Date.now() - prev.ts < 120000) {
      channel.postMessage(prev.payload);
      return;
    }
    const payload = {
      type: 'rpc-reply',
      reqId: data.reqId,
      ...(await handleRpc(String(data.method || ''), data.params || {}))
    };
    replies.set(data.reqId, { ts: Date.now(), payload });
    channel.postMessage(payload);
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
