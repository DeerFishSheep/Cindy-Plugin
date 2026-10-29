// 本地预览用的假桥：数据来自 dev/capture.mjs 真实抓取，不再联网。
// 只由生成的 dev/preview.html 加载；正式包不含这个文件。
(function () {
  const sample = window.__A6API_SAMPLE__ || {};
  const mode = new URLSearchParams(location.search).get('mode') || 'auth';
  const data = mode === 'public' ? sample.public : sample.auth || sample.public;
  const filters = sample.filters || {};
  const hasCookie = mode !== 'public' && Boolean(sample.userId);
  let listener = function () {};

  window.__A6API_TEST_BRIDGE__ = {
    live: false,
    wake: function () {},
    onEvent: function (fn) {
      listener = fn;
      return function () { listener = function () {}; };
    },
    saveCookie: function () { return Promise.resolve({ ok: true }); },
    clearCookie: function () { return Promise.resolve({ ok: true }); },
    secretStatus: function () { return Promise.resolve({ saved: hasCookie, tail: null }); },
    request: function (method) {
      if (method === 'panel/state') {
        return Promise.resolve({
          ok: true,
          hasCookie: hasCookie,
          cookieTail: null,
          userId: hasCookie ? sample.userId : null,
          tokenId: hasCookie && sample.tokens && sample.tokens[0] ? sample.tokens[0].id : null,
          last: data ? { params: filters, data: data, ts: Date.now() } : null
        });
      }
      if (method === 'balance/get') {
        return Promise.resolve(sample.balance ? { ok: true, balance: sample.balance } : { ok: false, error: '未登录' });
      }
      if (method === 'pin/current') {
        return Promise.resolve({ ok: true, pinned: sample.pinned || null });
      }
      if (method === 'tokens/list' || method === 'session/probe') {
        return Promise.resolve({
          ok: true,
          loggedIn: hasCookie,
          userId: sample.userId,
          tokens: sample.tokens || [],
          tokenCount: (sample.tokens || []).length
        });
      }
      if (method === 'brands/list') {
        return Promise.resolve({
          ok: true,
          brands: ['DeepSeek', 'OpenAI', 'Zhipu', 'Alibaba', 'tencent', 'Doubao', 'MiniMax', 'XIAOMI', 'Google', 'xAI']
        });
      }
      if (method === 'models/list') {
        return Promise.resolve({ ok: true, models: ['deepseek-v4.1-flash', 'deepseek-v4-flash', 'deepseek-v4-pro'] });
      }
      if (method === 'config/save' || method === 'session/logout') {
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve({ ok: false, error: 'dev bridge: ' + method });
    }
  };

  window.addEventListener('load', function () {
    setTimeout(function () { listener({ type: 'main-ready' }); }, 50);

    // 截图/调试用：?mode=value 切性价比，?dialog=detail|compare 自动打开弹层，
    // ?theme=dark 模拟宿主暗色变量。
    const params = new URLSearchParams(location.search);
    if (params.get('theme') === 'dark') {
      const root = document.documentElement;
      root.style.setProperty('--panel-bg', '#15171c');
      root.style.setProperty('--surface', '#1c2027');
      root.style.setProperty('--text-primary', '#e6eaf0');
      root.style.setProperty('--border-default', 'rgba(255,255,255,.14)');
      root.style.setProperty('--input-bg', 'rgba(255,255,255,.06)');
      root.style.setProperty('--msg-scrollbar', 'rgba(255,255,255,.3)');
    }
    if (params.get('mode') === 'value') {
      setTimeout(function () {
        const btn = document.querySelector('[data-mode="value"]');
        if (btn) btn.click();
      }, 900);
    }
    const dialog = params.get('dialog');
    if (dialog) {
      setTimeout(function () {
        const selector = '.row-actions button[data-action="' + dialog + '"]';
        const btn = document.querySelector(selector);
        if (btn) btn.click();
      }, 1000);
    }
  });
})();
