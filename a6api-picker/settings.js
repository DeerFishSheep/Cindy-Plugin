// 设置页：只做登录态的长期管理（同步 / 粘贴 / 清除）。与面板共用 bridge.js，
// Cookie 明文只在输入框 → /secrets 之间路过，不进 /kv、不进 BroadcastChannel。
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const bridge = window.A6Bridge;
  let busy = false;

  function setMsg(text, kind) {
    const node = $('#msg');
    node.textContent = text || '';
    node.className = 'msg' + (kind ? ' ' + kind : '');
  }

  function setBusy(on) {
    busy = on;
    $('#syncBtn').disabled = on;
    $('#saveBtn').disabled = on;
    $('#clearBtn').disabled = on;
    $('#syncBtn').textContent = on ? '处理中…' : '同步浏览器登录';
    $('#saveBtn').textContent = on ? '处理中…' : '保存并验证';
  }

  async function request(method, params, timeout) {
    return bridge.request(method, params || {}, { timeout: timeout || 90000 });
  }

  function renderStatus(state) {
    const dot = $('#dot');
    const node = $('#status');
    if (!state || !state.ok) {
      dot.className = 'dot';
      node.textContent = '读不到登录状态。电子脑可能还没启动，稍等几秒再刷新设置页。';
      return;
    }
    if (state.hasCookie) {
      dot.className = 'dot ok';
      node.textContent =
        '已保存 Cookie' +
        (state.cookieTail ? '（尾号 ' + state.cookieTail + '）' : '') +
        (state.userId ? ' · 用户 ID ' + state.userId : '') +
        '。固定/禁用与余额可用。';
    } else {
      dot.className = 'dot';
      node.textContent = '未登录。当前面板使用公开接口：能看榜单，但没有固定状态，也不能固定/禁用渠道。';
    }
  }

  async function refresh() {
    try {
      const state = await request('panel/state', {}, 30000);
      renderStatus(state);
    } catch (err) {
      renderStatus(null);
    }
  }

  async function sync() {
    if (busy) return;
    setBusy(true);
    setMsg('正在读取本机 Chrome / Edge / Brave 的 a6api 登录态。第一次可能弹 macOS 钥匙串授权。');
    try {
      const r = await request('session/import', {}, 90000);
      if (!r.ok) throw new Error(r.error || r.message || '读取失败');
      setMsg('已从 ' + (r.source || '浏览器') + ' 同步：用户 ID ' + r.userId + '，令牌 ' + (r.tokenCount || 0) + ' 个。', 'ok');
      await refresh();
    } catch (err) {
      setMsg(
        '同步失败：' + String((err && err.message) || err) +
          '。请在浏览器登录 a6api.com 后重试，或用「手动粘贴 Cookie」。',
        'err'
      );
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (busy) return;
    const value = $('#cookie').value.trim();
    if (!value) {
      setMsg('Cookie 是空的。', 'err');
      return;
    }
    setBusy(true);
    setMsg('正在保存并验证…');
    try {
      await bridge.saveCookie(value);
      await request('config/save', { hasCookie: true }, 30000);
      const uid = Number($('#userId').value.trim()) || null;
      if (uid) await request('config/save', { userId: uid }, 30000);
      const probe = await request('session/probe', {}, 60000);
      $('#cookie').value = '';
      if (probe.ok) {
        setMsg('已登录：用户 ID ' + (probe.userId || uid || '?') + '，令牌 ' + (probe.tokens || []).length + ' 个。', 'ok');
      } else {
        setMsg('Cookie 已保存，但验证失败：' + (probe.error || probe.message || '未知错误') + '。确认 Cookie 没抄错。', 'err');
      }
      await refresh();
    } catch (err) {
      setMsg('保存失败：' + String((err && err.message) || err), 'err');
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    if (busy) return;
    setBusy(true);
    try {
      if (bridge.clearCookie) await bridge.clearCookie();
      await request('session/logout', {}, 30000);
      setMsg('已清除登录态，回到公开接口。', 'ok');
      await refresh();
    } catch (err) {
      setMsg('清除失败：' + String((err && err.message) || err), 'err');
    } finally {
      setBusy(false);
    }
  }

  $('#syncBtn').addEventListener('click', sync);
  $('#saveBtn').addEventListener('click', save);
  $('#clearBtn').addEventListener('click', clear);
  $('#toggleBtn').addEventListener('click', () => {
    const box = $('#paste');
    box.hidden = !box.hidden;
  });

  bridge.onEvent((event) => {
    if (event && event.type === 'state-changed') refresh();
  });

  refresh();
})();
