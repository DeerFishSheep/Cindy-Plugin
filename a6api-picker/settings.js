// 设置页：登录态的长期管理（浏览器同步 / 粘贴 Cookie / 账号密码 / 退出）。
// 与面板共用 bridge.js。Cookie 明文只在输入框 → /secrets 之间路过：不进 /kv、
// 不进 BroadcastChannel；密码只经 BroadcastChannel → main.js → worker 一次，不落盘。
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
    for (const id of ['#syncBtn', '#saveBtn', '#clearBtn', '#passBtn']) $(id).disabled = on;
    $('#syncBtn').textContent = on ? '处理中…' : '同步浏览器登录';
    $('#saveBtn').textContent = on ? '处理中…' : '保存并验证';
    $('#passBtn').textContent = on ? '处理中…' : '账号密码登录';
  }

  function request(method, params, timeout) {
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
    if (state.loggedIn) {
      dot.className = 'dot ok';
      node.textContent =
        '已登录' +
        (state.cookieTail ? '（Cookie 尾号 ' + state.cookieTail + '）' : '') +
        (state.userId ? ' · 用户 ID ' + state.userId : '') +
        (state.tokenId ? ' · 固定用令牌 ' + state.tokenId : '') +
        '。固定/禁用与余额可用。';
    } else {
      dot.className = 'dot';
      node.textContent = '未登录。当前面板使用公开接口：能看榜单、能收藏渠道，但没有固定状态，也不能固定/禁用渠道。';
    }
  }

  async function refresh() {
    try {
      renderStatus(await request('panel/state', {}, 30000));
    } catch {
      renderStatus(null);
    }
  }

  async function sync() {
    if (busy) return;
    setBusy(true);
    setMsg('正在读取本机 Chrome / Edge / Brave 的 a6api 登录态。第一次可能弹 macOS 钥匙串授权。');
    try {
      const r = await request('login/browser', {}, 90000);
      if (!r.ok) throw new Error(r.error || r.message || '读取失败');
      if (r.mode === 'sync') {
        setMsg('已从 ' + (r.source || '浏览器') + ' 同步：用户 ID ' + r.userId + '，令牌 ' + (r.tokenCount || 0) + ' 个。', 'ok');
      } else {
        setMsg(r.reason || '已打开 a6api 登录页，登录后回到这里点一次「同步浏览器登录」。', '');
      }
      await refresh();
    } catch (err) {
      setMsg(
        '同步失败：' + String((err && err.message) || err) +
          '。请在浏览器登录 a6api.vip 后重试，或用「手动粘贴 Cookie」/「账号密码登录」。',
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
      // 明文只走这一次 PUT /secrets；随后让 worker 用宿主注入的那份验证。
      await bridge.saveCookie(value);
      const r = await request('login/cookie', {}, 60000);
      $('#cookie').value = '';
      if (r.ok) {
        setMsg('已登录：用户 ID ' + (r.userId || '?') + '。', 'ok');
      } else {
        setMsg('Cookie 已保存，但验证失败：' + (r.error || r.message || '未知错误') + '。确认 Cookie 没抄错。', 'err');
      }
      await refresh();
    } catch (err) {
      setMsg('保存失败：' + String((err && err.message) || err), 'err');
    } finally {
      setBusy(false);
    }
  }

  async function passwordLogin() {
    if (busy) return;
    const username = $('#user').value.trim();
    const password = $('#pass').value;
    if (!username || !password) {
      setMsg('账号和密码都要填。', 'err');
      return;
    }
    setBusy(true);
    setMsg('正在用账号密码登录…');
    try {
      const r = await request('login/password', { username, password }, 90000);
      $('#pass').value = '';
      if (!r.ok) throw new Error(r.error || r.message || '登录失败');
      setMsg('登录成功' + (r.userId ? '：用户 ID ' + r.userId : '') + '。', 'ok');
      await refresh();
    } catch (err) {
      setMsg('登录失败：' + String((err && err.message) || err), 'err');
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    if (busy) return;
    setBusy(true);
    try {
      if (bridge.clearCookie) await bridge.clearCookie();
      await request('logout', {}, 30000);
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
  $('#passBtn').addEventListener('click', passwordLogin);
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
