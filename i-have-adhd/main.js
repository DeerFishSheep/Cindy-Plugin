/**
 * i-have-adhd — 电子脑（主逻辑）
 *
 * 宿主把 ~/.pi/agent/AGENTS.md 注入每一轮会话。本插件把 ADHD 输出规则托管到
 * 该文件的一段受管区域（带 begin/end 标记），实现"插件启用即全局生效"。
 *
 * main.js 是浏览器沙箱：没有 fs、没有 Node。落盘一律交给随包 Node worker，
 * 插件根目录由 worker 用 __dirname 自己反推，这一层不需要知道路径。
 *
 * 状态落 fs data（插件私有目录），卸载即随之回收，不留脏状态。
 */

const CHANNEL = 'i-have-adhd';
const STATE_FILE = 'adhd-state.json';

let state = null;

// ── 广播（辅助函数在 BroadcastChannel 桥里定义） ───────────────────────────

// ── fs data（root:'data'，卸载即回收） ──────────────────────────────────────

async function readStateFile() {
  try {
    const res = await cindy.send({ type: 'fs-request', op: 'read', root: 'data', path: STATE_FILE });
    if (!res || res.ok !== true || typeof res.content !== 'string') return null;
    const parsed = JSON.parse(res.content);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

async function writeStateFile(next) {
  try {
    await cindy.send({
      type: 'fs-request',
      op: 'write',
      root: 'data',
      path: STATE_FILE,
      content: JSON.stringify(next, null, 2),
    });
  } catch {
    /* 状态文件写失败不阻塞主流程 */
  }
}

// ── Node worker ─────────────────────────────────────────────────────────────

async function callWorker(method) {
  let response;
  try {
    response = await cindy.node.request({ method, params: {}, timeoutMs: 20000 });
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
  return { ok: true, result };
}

// ── 核心动作 ────────────────────────────────────────────────────────────────

/** 首次运行时：没有状态记录就默认写入一次，实现「装上即生效」 */
async function firstRunApplyIfNeeded(st) {
  if (state) return false;
  const saved = await readStateFile();
  if (saved) {
    state = saved;
    return false;
  }
  if (!st.ok || st.enabled) {
    // 文件里已经有受管段，视为已开启
    state = { enabled: Boolean(st.ok && st.enabled), lastSyncAt: Date.now() };
    await writeStateFile(state);
    return false;
  }
  const res = await apply('enable');
  return res.ok === true;
}

async function statusOnly() {
  const res = await callWorker('adhd/status');
  if (!res.ok) return res;
  return { ok: true, ...res.result };
}

async function apply(action) {
  const res = await callWorker(action === 'enable' ? 'adhd/enable' : 'adhd/disable');
  if (!res.ok) return res;
  state = { enabled: res.result.enabled === true, lastSyncAt: Date.now() };
  await writeStateFile(state);
  broadcast({ type: 'adhd-state', ...res.result });
  return { ok: true, ...res.result };
}

// ── 工具调用 ────────────────────────────────────────────────────────────────

async function handleToolCall(msg) {
  const name = msg.tool;
  const args = msg.args && typeof msg.args === 'object' ? msg.args : {};

  const finish = (text, ok = true) =>
    cindy.send({ type: 'tool-result', callId: msg.callId, ok, result: { content: text } });

  if (name === 'adhd_status') {
    const st = await statusOnly();
    if (!st.ok) return finish(String(st.error), false);
    return finish(
      JSON.stringify({
        adhdMode: st.enabled ? 'on' : 'off',
        contextFile: st.file,
        rulesBytes: st.rulesBytes,
        note: st.enabled
          ? 'ADHD 输出规则已注入每一轮会话。'
          : 'ADHD 规则当前未生效，可在插件设置里打开。',
      })
    );
  }

  if (name === 'adhd_toggle') {
    const want = args.enabled === undefined ? true : Boolean(args.enabled);
    const res = await apply(want ? 'enable' : 'disable');
    if (!res.ok) return finish(String(res.error), false);
    return finish(
      JSON.stringify({
        adhdMode: res.enabled ? 'on' : 'off',
        contextFile: res.file,
        changed: res.changed === true,
      })
    );
  }

  return finish('未知工具: ' + name, false);
}

// ── BroadcastChannel 桥（面板 / 设置页 ↔ 本电子脑） ────────────────────────

const channel = new BroadcastChannel(CHANNEL);
const replies = new Map();

function broadcast(payload) {
  try {
    channel.postMessage(payload);
  } catch {
    /* 广播失败不影响主流程 */
  }
}

async function handleRpc(method, params) {
  switch (method) {
    case 'status': {
      const st = await statusOnly();
      if (!st.ok) return { ok: false, message: st.error };
      return { ok: true, state: st };
    }
    case 'enable': {
      const res = await apply('enable');
      if (!res.ok) return { ok: false, message: res.error };
      return { ok: true, state: res };
    }
    case 'disable': {
      const res = await apply('disable');
      if (!res.ok) return { ok: false, message: res.error };
      return { ok: true, state: res };
    }
    default:
      return { ok: false, message: '未知方法: ' + method };
  }
}

channel.onmessage = async (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;

  if (data.type === 'rpc' && data.reqId) {
    const prev = replies.get(data.reqId);
    if (prev && Date.now() - prev.ts < 120000) {
      channel.postMessage(prev.payload);
      return;
    }
    const payload = { type: 'rpc-reply', reqId: data.reqId, ...(await handleRpc(String(data.method || ''), data.params || {})) };
    replies.set(data.reqId, { ts: Date.now(), payload });
    channel.postMessage(payload);
    if (replies.size > 100) {
      const oldest = [...replies.entries()].sort((a, b) => a[1].ts - b[1].ts).slice(0, replies.size - 100);
      for (const [key] of oldest) replies.delete(key);
    }
    return;
  }

  if (data.type === 'wake') {
    channel.postMessage({ type: 'awake', ts: Date.now() });
  }
};

// ── 宿主消息 ────────────────────────────────────────────────────────────────

cindy.onHostMessage(async (msg) => {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'tool-call') {
    await handleToolCall(msg);
    return;
  }

  if (msg.type === 'event' && msg.name === 'node-status') {
    if (msg.state === 'ready') {
      // worker 就绪：上次是开启状态就补写一次（文件可能被外部删掉）
      const saved = await readStateFile();
      if (saved && saved.enabled === true) await apply('enable');
    }
    broadcast({ type: 'node-status', state: msg.state });
    return;
  }

  if (msg.type === 'event' && msg.name === 'adhd-sync') {
    broadcast({ type: 'adhd-state', ...(await statusOnly()) });
  }
});

// 唤醒时同步一次真实状态，方便设置页/面板直接显示。
(async () => {
  const st = await statusOnly();
  await firstRunApplyIfNeeded(st);
  broadcast({ type: 'adhd-state', ...(await statusOnly()), ready: true });
})();

broadcast({ type: 'main-ready' });
