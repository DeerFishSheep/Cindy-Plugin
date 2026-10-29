// 本地预览用的假桥：数据来自 dev/capture.mjs 真实抓取，不再联网。
// 只由生成的 dev/preview.html 加载；正式包不含这个文件。
//
// 方法名与 main.js 的 RPC 一致（search/run、fav/list、fav/set、fav/refresh …），
// 收藏用内存实现 —— 这样在无宿主环境里也能点星标、切收藏页、点收藏页的「刷新」。
(function () {
  const sample = window.__A6API_SAMPLE__ || {};
  const qs = new URLSearchParams(location.search);
  const mode = qs.get('mode') || 'auth';
  const data = mode === 'public' ? sample.public : sample.auth || sample.public;
  const filters = sample.filters || {};
  const hasCookie = mode !== 'public' && Boolean(sample.userId);
  let listener = function () {};

  const ranking = (data && Array.isArray(data.ranking) ? data.ranking : []).slice();
  const valueRanking = (data && Array.isArray(data.valueRanking) ? data.valueRanking : []).slice();

  // 收藏按模型名分组，和 main.js 的 favorites.json 同构。
  const favStore = {};
  const favModel = filters.model || 'deepseek-v4.1-flash';
  const seed = [];
  if (ranking[0]) seed.push({ channelId: ranking[0].id, addedAt: Date.now(), snapshot: ranking[0], down: false });
  if (ranking[5]) seed.push({ channelId: ranking[5].id, addedAt: Date.now(), snapshot: ranking[5], down: false });
  if (ranking[2]) seed.push({ channelId: ranking[2].id, addedAt: Date.now(), snapshot: ranking[2], down: true });
  favStore[favModel] = seed;

  function items(model) {
    return favStore[model || favModel] || [];
  }

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
    request: function (method, params) {
      const p = params || {};
      if (method === 'search/run') {
        return Promise.resolve({ ...data, ok: true, algo: 75 });
      }
      if (method === 'last/get') {
        return Promise.resolve(data ? { ok: true, params: filters, data: { ...data, algo: 75 }, ts: Date.now() } : { ok: true, data: null });
      }
      if (method === 'session/get') {
        return Promise.resolve({
          ok: true,
          loggedIn: hasCookie,
          userId: hasCookie ? sample.userId : null,
          tokenId: hasCookie && sample.tokens && sample.tokens[0] ? sample.tokens[0].id : null
        });
      }
      if (method === 'balance/get') {
        return Promise.resolve(sample.balance ? { ok: true, balance: sample.balance } : { ok: false, error: '未登录' });
      }
      if (method === 'pin/current') return Promise.resolve({ ok: true, pinned: sample.pinned || null });
      if (method === 'tokens/list') {
        return Promise.resolve({ ok: true, tokens: sample.tokens || [], tokenId: sample.tokens && sample.tokens[0] ? sample.tokens[0].id : null });
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
      if (method === 'status/get') return Promise.resolve({ ok: true, reachable: true });
      if (method === 'filters/get') return Promise.resolve({ ok: true, filters: null });
      if (method === 'filters/save') return Promise.resolve({ ok: true });
      if (method === 'fav/list') return Promise.resolve({ ok: true, model: p.model || favModel, items: items(p.model) });
      if (method === 'fav/set') {
        const model = p.model || favModel;
        const id = Number(p.channelId);
        const rest = items(model).filter(function (x) { return Number(x.channelId) !== id; });
        if (p.on !== false) rest.push({ channelId: id, addedAt: Date.now(), snapshot: p.snapshot || null, down: false });
        favStore[model] = rest;
        return Promise.resolve({ ok: true, model: model, items: rest });
      }
      if (method === 'fav/refresh') {
        const model = p.model || favModel;
        const byId = new Map((p.rows || []).map(function (r) { return [Number(r.id), r]; }));
        favStore[model] = items(model).map(function (item) {
          const fresh = byId.get(Number(item.channelId));
          return fresh
            ? { ...item, snapshot: fresh, down: false, refreshedAt: Date.now() }
            : { ...item, down: true, refreshedAt: Date.now() };
        });
        return Promise.resolve({ ok: true, model: model, items: favStore[model] });
      }
      if (method === 'login/browser') {
        return Promise.resolve({ ok: true, mode: 'sync', userId: sample.userId, tokenCount: (sample.tokens || []).length, source: 'dev' });
      }
      if (method === 'login/cookie' || method === 'login/password' || method === 'logout' || method === 'config/save') {
        return Promise.resolve({ ok: true, userId: sample.userId });
      }
      return Promise.resolve({ ok: false, error: 'dev bridge: ' + method });
    }
  };

  window.addEventListener('load', function () {
    setTimeout(function () { listener({ type: 'main-ready' }); }, 50);

    // 截图/调试用：?mode=value 切性价比，?tab=fav 切收藏，?dialog=compare 打开对比，
    // ?theme=dark 模拟宿主暗色。
    if (qs.get('theme') === 'dark') {
      document.documentElement.dataset.theme = 'dark';
    }
    if (mode === 'value' || qs.get('mode') === 'value') {
      setTimeout(function () {
        const btn = document.querySelector('[data-k="value"]');
        if (btn) btn.click();
      }, 500);
    }
    if (qs.get('tab') === 'fav') {
      setTimeout(function () {
        const btn = document.querySelector('[data-k="fav"]');
        if (btn) btn.click();
      }, 700);
    }
    const dialog = qs.get('dialog');
    if (dialog) {
      setTimeout(function () {
        const selector = '.row-acts button[title*="对比"]';
        const btn = document.querySelector(selector);
        if (btn) btn.click();
      }, 900);
    }
  });
})();
