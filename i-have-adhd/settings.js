// ADHD 输出 — 设置页逻辑
//
// 设置页是沙箱页：没有 cindy 全局，也没有通用网络直连。
// 与电子脑通信用 BroadcastChannel，宿主会在需要时把 main.js 唤醒。

const CHANNEL = 'i-have-adhd';

const $ = (id) => document.getElementById(id);
const toggle = $('toggle');
const dot = $('dot');
const stateText = $('stateText');
const fileText = $('fileText');
const sizeText = $('sizeText');
const msg = $('msg');
const refresh = $('refresh');

const channel = new BroadcastChannel(CHANNEL);
let reqSeq = 0;
const pending = new Map();
let busy = false;

function showError(text) {
  msg.textContent = text || '';
  msg.classList.toggle('show', Boolean(text));
}

function fmtBytes(n) {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return n + ' B';
  return (n / 1024).toFixed(1) + ' KB';
}

function render(state) {
  const on = Boolean(state && state.enabled);
  toggle.checked = on;
  toggle.disabled = false;
  dot.className = 'dot ' + (on ? 'on' : 'off');
  stateText.textContent = on ? '已开启' : '已关闭';
  fileText.textContent = (state && state.file) || '—';
  sizeText.textContent = state
    ? `${fmtBytes(state.rulesBytes)} 规则` + (state.exists ? ` · 文件共 ${fmtBytes(state.fileBytes)}` : '')
    : '—';
}

function rpc(method, params, timeoutMs = 25000) {
  return new Promise((resolve) => {
    const reqId = `${Date.now()}-${++reqSeq}`;
    const timer = setTimeout(() => {
      pending.delete(reqId);
      resolve({ ok: false, message: '电子脑没有响应，稍后再试一次' });
    }, timeoutMs);
    pending.set(reqId, { resolve, timer });
    channel.postMessage({ type: 'rpc', method, params: params || {}, reqId });
  });
}

channel.onmessage = (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;

  if (data.type === 'rpc-reply' && pending.has(data.reqId)) {
    const entry = pending.get(data.reqId);
    pending.delete(data.reqId);
    clearTimeout(entry.timer);
    entry.resolve(data);
    return;
  }

  // 电子脑推过来的状态（唤醒同步、worker 就绪补写等）
  if (data.type === 'adhd-state' && typeof data.enabled === 'boolean') {
    render(data);
  }
};

async function load() {
  const res = await rpc('status');
  if (res.ok && res.state) {
    render(res.state);
    showError('');
  } else {
    toggle.disabled = false;
    stateText.textContent = '未就绪';
    dot.className = 'dot err';
    showError(res.message || '读取状态失败');
  }
}

toggle.addEventListener('change', async () => {
  if (busy) return;
  busy = true;
  const want = toggle.checked;
  toggle.disabled = true;
  showError('');
  const res = await rpc(want ? 'enable' : 'disable');
  busy = false;
  toggle.disabled = false;
  if (res.ok && res.state) {
    render(res.state);
    showError('');
  } else {
    toggle.checked = !want; // 回滚
    showError(res.message || (want ? '开启失败' : '关闭失败'));
  }
});

refresh.addEventListener('click', async () => {
  refresh.disabled = true;
  await load();
  refresh.disabled = false;
});

// 唤醒电子脑，然后拉一次状态
channel.postMessage({ type: 'wake' });
load();
setTimeout(() => {
  if (toggle.disabled) load();
}, 1200);
