// A6API 渠道面板。纯 DOM，无框架；数据全部经 bridge.js 转给电子脑 →
// node/worker.cjs。面板自己不联网（Cindy 沙箱本来也不允许）。
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const bridge = window.A6Bridge;

  const FILTER_KEY = 'a6api-filters-v3';
  const DEFAULTS = {
    brand: 'DeepSeek',
    model: 'deepseek-v4.1-flash',
    minCache: '80',
    minSr: '95',
    maxRatio: '0.1',
    minSample: '',
    maxTtft: '5',
    minTps: '',
    onlyQualified: true,
    guaranteed: false
  };
  const EDITABLE = ['brand', 'model', 'minCache', 'minSr', 'maxRatio', 'minSample', 'maxTtft', 'minTps'];

  const S = {
    auth: { hasCookie: false, userId: null, tokenId: null },
    balance: null,
    rows: [],
    valueRows: [],
    mode: 'score',
    meta: null,
    pinned: null,
    tokens: [],
    busy: false,
    loginBusy: false,
    pendingDisable: null,
    disableTimer: null,
    filters: loadFilters()
  };

  // ── 小工具 ──────────────────────────────────────────────────────────────

  function loadFilters() {
    try {
      const raw = window.localStorage.getItem(FILTER_KEY);
      const saved = raw ? JSON.parse(raw) : null;
      return saved && typeof saved === 'object' ? { ...DEFAULTS, ...saved } : { ...DEFAULTS };
    } catch (e) {
      return { ...DEFAULTS };
    }
  }

  function saveFilters() {
    try {
      window.localStorage.setItem(FILTER_KEY, JSON.stringify(S.filters));
    } catch (e) {}
  }

  function num(v) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }

  function secTxt(ms) {
    return ms === null || ms === undefined ? '-' : (Number(ms) / 1000).toFixed(2) + 's';
  }

  function pctTxt(v) {
    return ((Number(v) || 0) / 100).toFixed(1) + '%';
  }

  function costTxt(v) {
    return v === null || v === undefined ? '-' : '¥' + Number(v).toFixed(2) + '/1亿';
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function setMsg(text, kind) {
    const node = $('#msg');
    node.textContent = text || '';
    node.className = 'msg' + (kind ? ' ' + kind : '');
  }

  function setLoginMsg(text, kind) {
    const node = $('#loginMsg');
    node.textContent = text || '';
    node.className = 'msg' + (kind ? ' ' + kind : '');
  }

  function showBanner(text) {
    const node = $('#banner');
    node.textContent = text || '';
    node.hidden = !text;
  }

  function setBusy(busy) {
    S.busy = busy;
    const btn = $('#runBtn');
    btn.disabled = busy;
    btn.textContent = busy ? '抓取中…' : '开始筛选';
  }

  function gradeOf(v) {
    if (v >= 85) return ['优秀', 'var(--good)'];
    if (v >= 70) return ['良好', 'var(--accent)'];
    if (v >= 55) return ['一般', 'var(--warn)'];
    if (v >= 40) return ['偏弱', '#d9822b'];
    return ['差', 'var(--bad)'];
  }

  // ── 筛选表单 ────────────────────────────────────────────────────────────

  const FIELD_IDS = ['brand', 'model', 'minCache', 'minSr', 'maxRatio', 'minSample', 'maxTtft', 'minTps'];

  function applyFiltersToUI() {
    for (const id of FIELD_IDS) $('#' + id).value = S.filters[id] === undefined || S.filters[id] === null ? '' : S.filters[id];
    $('#onlyQualified').checked = S.filters.onlyQualified !== false;
    $('#guaranteed').checked = Boolean(S.filters.guaranteed);
  }

  function readFiltersFromUI() {
    const next = {};
    for (const id of FIELD_IDS) next[id] = $('#' + id).value.trim();
    next.onlyQualified = $('#onlyQualified').checked;
    next.guaranteed = $('#guaranteed').checked;
    return next;
  }

  function bindFilters() {
    for (const id of FIELD_IDS) {
      $('#' + id).addEventListener('input', () => {
        S.filters = readFiltersFromUI();
        saveFilters();
        if (id === 'brand') loadModels();
      });
    }
    $('#onlyQualified').addEventListener('change', () => {
      S.filters = readFiltersFromUI();
      saveFilters();
    });
    $('#guaranteed').addEventListener('change', () => {
      S.filters = readFiltersFromUI();
      saveFilters();
    });
    $('#resetBtn').addEventListener('click', () => {
      S.filters = { ...DEFAULTS };
      applyFiltersToUI();
      saveFilters();
      setMsg('已恢复默认筛选条件。', 'ok');
    });
  }

  // ── 数据加载 ────────────────────────────────────────────────────────────

  async function call(method, params, timeout) {
    return bridge.request(method, params || {}, { timeout: timeout || 120000 });
  }

  async function loadBrands() {
    try {
      const r = await call('brands/list', {}, 60000);
      if (!r.ok) return;
      const list = $('#brandList');
      list.textContent = '';
      for (const brand of r.brands || []) {
        const opt = document.createElement('option');
        opt.value = brand;
        list.appendChild(opt);
      }
    } catch (e) {}
  }

  let modelTimer = null;
  function loadModels() {
    clearTimeout(modelTimer);
    modelTimer = setTimeout(async () => {
      const brand = $('#brand').value.trim();
      if (!brand) {
        $('#modelList').textContent = '';
        return;
      }
      try {
        const r = await call('models/list', { brand }, 60000);
        if (!r.ok) return;
        const list = $('#modelList');
        list.textContent = '';
        for (const model of r.models || []) {
          const opt = document.createElement('option');
          opt.value = model;
          list.appendChild(opt);
        }
      } catch (e) {}
    }, 350);
  }

  function setRows(result) {
    if (!result) return;
    S.rows = Array.isArray(result.ranking) ? result.ranking : [];
    S.valueRows = Array.isArray(result.valueRanking) ? result.valueRanking : [];
    S.meta = {
      total: result.total,
      fetched: result.fetched,
      kept: result.kept,
      scope: result.scope,
      ts: result.ts,
      model: result.model
    };
    renderList();
  }

  // ── 渲染 ────────────────────────────────────────────────────────────────

  function renderAuth() {
    const dot = $('#dot');
    dot.className = 'dot ' + (S.auth.hasCookie ? 'ok' : 'off');
    $('#authText').textContent = S.auth.hasCookie
      ? '已登录 · 用户 ' + (S.auth.userId || '?')
      : '未登录 · 公开数据';
    $('#balance').textContent =
      S.auth.hasCookie && S.balance && Number.isFinite(Number(S.balance.cny))
        ? '余额 ¥' + Number(S.balance.cny).toFixed(2)
        : '';
    $('#logoutBtn').style.display = S.auth.hasCookie ? '' : 'none';
    $('#tokenSelect').disabled = !S.auth.hasCookie;
    updatePinStatus();
  }

  function renderTokenSelect() {
    const select = $('#tokenSelect');
    select.textContent = '';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = S.tokens.length ? '（不指定令牌）' : '（没有令牌）';
    select.appendChild(none);
    for (const token of S.tokens) {
      const opt = document.createElement('option');
      opt.value = String(token.id);
      opt.textContent = (token.name || String(token.id)) + ' · ' + token.id;
      select.appendChild(opt);
    }
    select.value = S.auth.tokenId ? String(S.auth.tokenId) : '';
  }

  function updatePinStatus() {
    const node = $('#pinStatus');
    node.textContent = '';
    if (S.pinned) {
      node.append('当前固定 · ');
      const b = el('b', '', '#' + S.pinned.channelId + ' ' + (S.pinned.supplierName || ''));
      node.appendChild(b);
    } else if (S.auth.hasCookie) {
      node.textContent = '当前固定 · 未设置';
    } else {
      node.textContent = '未登录 · 公开数据看不到固定状态';
    }
  }

  function activeRows() {
    return S.mode === 'value' ? S.valueRows : S.rows;
  }

  function renderList() {
    const list = $('#list');
    list.textContent = '';
    const rows = activeRows();
    const label = S.mode === 'value' ? '性价比排序' : '综合排名';

    const parts = [];
    if (rows.length) parts.push(label + ' · 共 ' + rows.length + ' 条');
    if (S.meta) parts.push('接口 ' + S.meta.total + ' / 达标 ' + S.meta.kept);
    if (S.meta && S.meta.scope === 'public') parts.push('未登录');
    $('#summary').textContent = parts.join(' · ');
    $('#copyBtn').disabled = !rows.length;

    if (!rows.length) {
      const empty = el('div', 'empty');
      empty.textContent = S.meta
        ? '没有渠道通过当前筛选。放宽条件或换模型再试。'
        : '还没有榜单。选好模型后点「开始筛选」。';
      list.appendChild(empty);
      return;
    }

    rows.forEach((row, index) => list.appendChild(renderRow(row, index)));
  }

  function renderRow(row, index) {
    const item = el('div', 'row-item');
    item.appendChild(el('span', 'no', String(index + 1)));
    item.appendChild(el('span', 'score', String(row.score)));

    const main = el('div', 'row-main');
    const line = el('div', 'row-line');
    const name = el('div', 'row-name');
    name.appendChild(el('b', '', '#' + row.id));
    name.appendChild(document.createTextNode(row.sup || '(未命名商家)'));
    line.appendChild(name);

    if (row.pinned) line.appendChild(el('span', 'chip', '✓ 已固定'));
    main.appendChild(line);

    const metrics =
      costTxt(row.costCny100m) +
      ' · ' + secTxt(row.ttft) +
      ' · ' + Math.round(Number(row.tps) || 0) +
      ' tok/s · 缓存' + pctTxt(row.cache) +
      ' · 屏蔽' + (Number(row.blk) || 0);
    const metricsNode = el('div', 'row-metrics', metrics);
    metricsNode.title = '1亿输入+25万输出 token 估算成本（人民币） · 首字 · 吞吐 · 24h 缓存命中率 · 被屏蔽次数';
    main.appendChild(metricsNode);

    const actions = el('div', 'row-actions');

    if (!row.pinned) {
      const pinBtn = el('button', '', '固定');
      pinBtn.type = 'button';
      pinBtn.dataset.action = 'pin';
      pinBtn.dataset.id = String(row.id);
      pinBtn.disabled = !S.auth.hasCookie;
      if (!S.auth.hasCookie) pinBtn.title = '固定需要登录';
      actions.appendChild(pinBtn);
    }

    const disBtn = el('button', 'danger', S.pendingDisable === row.id ? '确认禁用' : '禁用');
    disBtn.type = 'button';
    disBtn.dataset.action = 'disable';
    disBtn.dataset.id = String(row.id);
    if (S.pendingDisable === row.id) disBtn.classList.add('confirm');
    disBtn.disabled = !S.auth.hasCookie;
    disBtn.title = S.auth.hasCookie ? '禁用该渠道的这个模型（站点不可撤销）' : '禁用需要登录';
    actions.appendChild(disBtn);

    const detailBtn = el('button', '', '详细');
    detailBtn.type = 'button';
    detailBtn.dataset.action = 'detail';
    detailBtn.dataset.id = String(row.id);
    actions.appendChild(detailBtn);

    const cmpBtn = el('button', '', '对比');
    cmpBtn.type = 'button';
    cmpBtn.dataset.action = 'compare';
    cmpBtn.dataset.id = String(row.id);
    actions.appendChild(cmpBtn);

    main.appendChild(actions);
    item.appendChild(main);
    return item;
  }

  // ── 操作 ────────────────────────────────────────────────────────────────

  async function run() {
    const filters = readFiltersFromUI();
    S.filters = filters;
    saveFilters();

    if (!filters.model) {
      setMsg('先填模型名。可以点品牌输入框展开候选，或直接输入 deepseek-v4.1-flash。', 'err');
      return;
    }

    setBusy(true);
    setMsg('正在抓取 a6api.com…首次通常 5–10 秒。');
    showBanner('');
    try {
      const result = await call(
        'search/run',
        {
          brand: filters.guaranteed ? '' : filters.brand,
          model: filters.model,
          minCache: num(filters.minCache),
          minSr: num(filters.minSr),
          maxRatio: num(filters.maxRatio),
          minSample: num(filters.minSample),
          maxTtft: num(filters.maxTtft),
          minTps: num(filters.minTps),
          onlyQualified: filters.onlyQualified,
          guaranteed: Boolean(filters.guaranteed),
          tokenId: S.auth.tokenId || undefined
        },
        150000
      );
      if (!result.ok) throw new Error(result.error || result.message || '筛选失败');

      setRows(result);
      const tail =
        result.scope === 'public'
          ? '｜未登录，固定状态不可见'
          : (result.ranking || []).some((x) => x.pinned)
            ? '｜已固定 ' + (result.ranking || []).filter((x) => x.pinned).length + ' 个'
            : '';
      setMsg(
        '完成：接口 ' + result.total + ' 条，达标 ' + result.kept + ' 条，参与排名 ' +
          (result.ranking || []).length + ' 条' + tail + '。',
        'ok'
      );
      await refreshPinned();
    } catch (err) {
      setMsg('失败：' + String((err && err.message) || err), 'err');
    } finally {
      setBusy(false);
    }
  }

  function findRow(id) {
    const all = S.rows.concat(S.valueRows);
    const hit = all.find((x) => Number(x.id) === Number(id));
    if (hit) return hit;
    if (S.pinned && S.pinned.row && Number(S.pinned.row.id) === Number(id)) return S.pinned.row;
    return null;
  }

  async function pinChannel(id) {
    if (!S.auth.hasCookie) {
      setMsg('固定渠道需要先登录（同步浏览器登录或粘贴 Cookie）。', 'err');
      return;
    }
    if (!S.auth.tokenId) {
      setMsg('先在下面选一个固定用令牌，再点固定。', 'err');
      return;
    }
    setMsg('正在固定 #' + id + '…');
    try {
      const r = await call('pin/set', {
        channelId: id,
        model: $('#model').value.trim(),
        tokenId: S.auth.tokenId
      }, 60000);
      if (!r.ok) throw new Error(r.error || r.message || '固定失败');
      for (const list of [S.rows, S.valueRows]) {
        for (const row of list) row.pinned = Number(row.id) === Number(r.channelId || id);
      }
      renderList();
      setMsg('已固定 #' + (r.channelId || id) + ' ' + (r.supplierName || ''), 'ok');
      await refreshPinned();
    } catch (err) {
      setMsg('固定失败：' + String((err && err.message) || err), 'err');
    }
  }

  async function disableChannel(id) {
    if (!S.auth.hasCookie) {
      setMsg('禁用渠道需要先登录。', 'err');
      return;
    }
    if (S.pendingDisable !== id) {
      S.pendingDisable = id;
      clearTimeout(S.disableTimer);
      S.disableTimer = setTimeout(() => {
        S.pendingDisable = null;
        renderList();
      }, 5000);
      renderList();
      setMsg('再点一次「确认禁用」：禁用后站点不再向你展示该渠道，且不可撤销。', 'err');
      return;
    }
    clearTimeout(S.disableTimer);
    S.pendingDisable = null;
    try {
      const r = await call('disable/channel', {
        channelId: id,
        model: $('#model').value.trim(),
        tokenId: S.auth.tokenId || undefined
      }, 60000);
      if (!r.ok) throw new Error(r.error || r.message || '禁用失败');
      S.rows = S.rows.filter((x) => Number(x.id) !== Number(id));
      S.valueRows = S.valueRows.filter((x) => Number(x.id) !== Number(id));
      setMsg('已禁用 #' + id + ' 的 ' + ($('#model').value.trim() || '该模型'), 'ok');
      renderList();
      await refreshPinned();
    } catch (err) {
      renderList();
      setMsg('禁用失败：' + String((err && err.message) || err), 'err');
    }
  }

  async function refreshPinned() {
    if (!S.auth.hasCookie) {
      S.pinned = null;
      updatePinStatus();
      return;
    }
    try {
      const r = await call('pin/current', {
        model: $('#model').value.trim(),
        tokenId: S.auth.tokenId || undefined
      }, 60000);
      S.pinned = r.ok && r.pinned ? r.pinned : null;
      if (S.pinned) {
        for (const list of [S.rows, S.valueRows]) {
          for (const row of list) row.pinned = Number(row.id) === Number(S.pinned.channelId);
        }
        renderList();
      }
    } catch (e) {
      S.pinned = null;
    }
    updatePinStatus();
  }

  async function refreshTokens() {
    if (!S.auth.hasCookie) return;
    try {
      const r = await call('tokens/list', {}, 60000);
      if (!r.ok) throw new Error(r.error || r.message || '拿不到令牌');
      S.tokens = r.tokens || [];
      if (!S.auth.tokenId && S.tokens.length) {
        await setToken(String(S.tokens[0].id));
      } else {
        renderTokenSelect();
      }
    } catch (err) {
      setLoginMsg('刷新令牌失败：' + String((err && err.message) || err), 'err');
    }
  }

  async function setToken(value) {
    S.auth.tokenId = value ? Number(value) : null;
    renderTokenSelect();
    try {
      await call('config/save', { tokenId: S.auth.tokenId }, 30000);
    } catch (e) {}
    await refreshPinned();
  }

  async function loadBalance() {
    if (!S.auth.hasCookie) return;
    try {
      const r = await call('balance/get', {}, 60000);
      S.balance = r.ok && r.balance ? r.balance : null;
    } catch (e) {
      S.balance = null;
    }
    renderAuth();
  }

  async function probeSession() {
    try {
      const r = await call('session/probe', {}, 60000);
      if (!r.ok) {
        S.auth.hasCookie = false;
        S.tokens = [];
        renderAuth();
        renderTokenSelect();
        return false;
      }
      S.auth.hasCookie = true;
      S.auth.userId = r.userId || S.auth.userId;
      S.tokens = Array.isArray(r.tokens) ? r.tokens : [];
      if (!S.auth.tokenId && S.tokens.length) {
        S.auth.tokenId = Number(S.tokens[0].id);
        await call('config/save', { tokenId: S.auth.tokenId }, 30000);
      }
      renderAuth();
      renderTokenSelect();
      await loadBalance();
      await refreshPinned();
      return true;
    } catch (e) {
      renderAuth();
      return false;
    }
  }

  async function syncBrowserLogin() {
    S.loginBusy = true;
    $('#syncBtn').disabled = true;
    $('#syncBtn').textContent = '同步中…';
    setLoginMsg('正在读取本机 Chrome / Edge / Brave 的 a6api 登录态。第一次读取可能弹 macOS 钥匙串授权。');
    try {
      const r = await call('session/import', {}, 90000);
      if (!r.ok) throw new Error(r.error || r.message || '读取失败');
      S.auth.hasCookie = true;
      S.auth.userId = r.userId || null;
      S.tokens = Array.isArray(r.tokens) ? r.tokens : [];
      if (!S.auth.tokenId && S.tokens.length) {
        S.auth.tokenId = Number(S.tokens[0].id);
        await call('config/save', { tokenId: S.auth.tokenId }, 30000);
      }
      renderAuth();
      renderTokenSelect();
      setLoginMsg('已从 ' + (r.source || '浏览器') + ' 同步：用户 ID ' + r.userId + '，令牌 ' + (r.tokenCount || S.tokens.length) + ' 个。', 'ok');
      await loadBalance();
      await refreshPinned();
    } catch (err) {
      const text = String((err && err.message) || err);
      setLoginMsg(
        '同步失败：' + text + '。如果钥匙串没授权，可以在浏览器里登录 a6api.com 后用「粘贴 Cookie」；' +
          'Cookie 在开发者工具 → Network → 任意请求 → 请求头 Cookie。',
        'err'
      );
    } finally {
      S.loginBusy = false;
      $('#syncBtn').disabled = false;
      $('#syncBtn').textContent = '同步浏览器登录';
    }
  }

  async function savePastedCookie() {
    const value = $('#cookieInput').value.trim();
    if (!value) {
      setLoginMsg('Cookie 是空的。', 'err');
      return;
    }
    S.loginBusy = true;
    $('#saveCookieBtn').disabled = true;
    setLoginMsg('正在保存并验证 Cookie…');
    try {
      await bridge.saveCookie(value);
      await call('config/save', { hasCookie: true }, 30000);
      const uid = $('#userIdInput').value.trim();
      if (uid) await call('config/save', { userId: Number(uid) || null }, 30000);
      $('#cookieInput').value = '';
      $('#userIdInput').value = '';

      const probe = await call('session/probe', {}, 60000);
      if (probe.ok) {
        S.auth.hasCookie = true;
        S.auth.userId = probe.userId || (uid ? Number(uid) : null);
        S.tokens = Array.isArray(probe.tokens) ? probe.tokens : [];
        renderAuth();
        renderTokenSelect();
        setLoginMsg('已登录：用户 ID ' + (S.auth.userId || '?') + '，令牌 ' + S.tokens.length + ' 个。', 'ok');
        await loadBalance();
        await refreshPinned();
      } else {
        S.auth.hasCookie = true;
        renderAuth();
        setLoginMsg('Cookie 已保存，但验证失败：' + (probe.error || probe.message || '未知错误') + '。公开接口仍可用；要固定/禁用请确认 Cookie 没抄错。', 'err');
      }
    } catch (err) {
      setLoginMsg('保存失败：' + String((err && err.message) || err), 'err');
    } finally {
      S.loginBusy = false;
      $('#saveCookieBtn').disabled = false;
    }
  }

  async function logout() {
    try {
      await bridge.clearCookie();
    } catch (e) {}
    try {
      await call('session/logout', {}, 30000);
    } catch (e) {}
    S.auth = { hasCookie: false, userId: null, tokenId: null };
    S.tokens = [];
    S.pinned = null;
    S.balance = null;
    renderAuth();
    renderTokenSelect();
    renderList();
    setLoginMsg('已退出登录，回到公开接口。', 'ok');
  }

  // ── 详情 / 对比 ─────────────────────────────────────────────────────────

  const PART_DEFS = [
    ['rel', '有效率'],
    ['eff', '价格'],
    ['stab', '稳定性'],
    ['ttft', '首字'],
    ['tps', '吞吐']
  ];

  function openDetail(row) {
    if (!row) return;
    $('#detailTitle').textContent = '#' + row.id + ' ' + (row.sup || '');
    const body = $('#detailBody');
    body.textContent = '';

    const score = Number(row.score) || 0;
    const [grade, color] = gradeOf(score);
    const head = el('div', 'detail-score');
    head.appendChild(el('span', 'big', String(score)));
    const gradeNode = el('span', 'grade', grade);
    gradeNode.style.color = color;
    head.appendChild(gradeNode);
    head.appendChild(el('span', 'detail-sub', '综合分（五项各 20%）'));
    body.appendChild(head);

    const parts = el('div', 'parts');
    for (const [key, label] of PART_DEFS) {
      const value = Number((row.parts || {})[key]) || 0;
      const line = el('div', 'part');
      line.appendChild(el('span', 'part-label', label));
      const track = el('div', 'part-track');
      const bar = el('span', 'part-bar');
      bar.style.width = Math.max(0, Math.min(100, value)) + '%';
      if (value < 0) bar.classList.add('neg');
      track.appendChild(bar);
      line.appendChild(track);
      line.appendChild(el('span', 'part-val', String(value)));
      parts.appendChild(line);
    }
    body.appendChild(parts);

    const grid = el('dl', 'kv-grid');
    const add = (k, v) => {
      const wrap = el('div', 'kv');
      wrap.appendChild(el('dt', '', k));
      wrap.appendChild(el('dd', '', v));
      grid.appendChild(wrap);
    };
    add('渠道 ID', String(row.id));
    add('商家', row.sup || '-');
    add('渠道名', row.ch || '-');
    add('倍率', row.ratio === null || row.ratio === undefined ? '-' : String(row.ratio));
    add('1亿成本', costTxt(row.costCny100m));
    add('首字（近 6 桶）', secTxt(row.ttft));
    add('首字 p50', secTxt(row.ttftRaw));
    add('端到端 p50', secTxt(row.p50));
    add('吞吐', Math.round(Number(row.tps) || 0) + ' tok/s');
    add('近期成功率', pctTxt(row.srr));
    add('24h 成功率', pctTxt(row.sr24));
    add('缓存命中', pctTxt(row.cache));
    add('稳定性', row.stab === null || row.stab === undefined ? '-' : (Number(row.stab) * 100).toFixed(0) + '%');
    add('样本数', String(Number(row.n) || 0));
    add('被屏蔽', String(Number(row.blk) || 0));
    add('保真商家', row.auth ? '是' : '否');
    add('固定状态', row.pinned ? '已固定在这里' : row.ps || '-');
    add('路由', row.rtp || '-');
    body.appendChild(grid);

    $('#detailDlg').showModal();
  }

  const CMP_METRICS = [
    { key: 'score', label: '综合分', better: 'high', fmt: (v) => String(v) },
    { key: 'costCny100m', label: '1亿成本', better: 'low', fmt: (v) => costTxt(v) },
    { key: 'ttft', label: '首字', better: 'low', fmt: (v) => secTxt(v) },
    { key: 'tps', label: '吞吐', better: 'high', fmt: (v) => Math.round(Number(v) || 0) + ' tok/s' },
    { key: 'srr', label: '近期成功率', better: 'high', fmt: (v) => pctTxt(v) },
    { key: 'cache', label: '缓存命中', better: 'high', fmt: (v) => pctTxt(v) },
    { key: 'blk', label: '屏蔽次数', better: 'low', fmt: (v) => String(Number(v) || 0) },
    { key: 'stab', label: '稳定性', better: 'high', fmt: (v) => (Number(v) * 100).toFixed(0) + '%' }
  ];

  function compareRows() {
    const all = S.rows.concat(S.valueRows);
    const seen = new Set();
    const rows = [];
    for (const row of all) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      rows.push(row);
    }
    if (S.pinned && S.pinned.row && !seen.has(S.pinned.row.id)) rows.unshift({ ...S.pinned.row, pinned: true });
    return rows;
  }

  function fillCompareSelect(select, rows, selected) {
    select.textContent = '';
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = '选择渠道…';
    select.appendChild(blank);
    for (const row of rows) {
      const opt = document.createElement('option');
      opt.value = String(row.id);
      opt.textContent = '#' + row.id + ' ' + (row.sup || '') + ' · ' + row.score;
      select.appendChild(opt);
    }
    select.value = selected ? String(selected) : '';
  }

  function openCompare(row) {
    const rows = compareRows();
    if (!rows.length) return;
    // 固定渠道可能不在当前榜单里（或服务端没给完整评分行）；这时左侧退回第一条。
    const pinnedId = S.pinned && S.pinned.channelId ? Number(S.pinned.channelId) : null;
    const left = pinnedId && rows.some((x) => Number(x.id) === pinnedId) ? pinnedId : rows[0].id;
    const right = row && Number(row.id) !== Number(left) ? row.id : (rows.find((x) => Number(x.id) !== Number(left)) || {}).id || '';
    fillCompareSelect($('#cmpLeft'), rows, left);
    fillCompareSelect($('#cmpRight'), rows, right);
    renderCompare();
    $('#compareDlg').showModal();
  }

  function renderCompare() {
    const rows = compareRows();
    const left = rows.find((x) => String(x.id) === $('#cmpLeft').value) || null;
    const right = rows.find((x) => String(x.id) === $('#cmpRight').value) || null;
    const body = $('#cmpBody');
    body.textContent = '';

    if (!left || !right) {
      body.appendChild(el('div', 'empty', '两边各选一个渠道。'));
      return;
    }

    let leftWins = 0;
    let rightWins = 0;
    const rowsWrap = el('div', '');

    for (const metric of CMP_METRICS) {
      const a = Number(left[metric.key]);
      const b = Number(right[metric.key]);
      const va = Number.isFinite(a) ? a : null;
      const vb = Number.isFinite(b) ? b : null;
      const low = metric.better === 'low';

      let leftWin = false;
      let rightWin = false;
      if (va !== null && vb !== null && va !== vb) {
        if (low) {
          leftWin = va < vb;
          rightWin = vb < va;
        } else {
          leftWin = va > vb;
          rightWin = vb > va;
        }
      }
      if (leftWin) leftWins++;
      if (rightWin) rightWins++;

      const row = el('div', 'cmp-row');
      const head = el('div', 'cmp-head');
      const lv = el('div', 'cmp-val l' + (leftWin ? ' win' : ''), metric.fmt(va));
      const label = el('div', 'cmp-label', metric.label + (low ? ' ↓' : ' ↑'));
      const rv = el('div', 'cmp-val' + (rightWin ? ' win' : ''), metric.fmt(vb));
      head.append(lv, label, rv);
      row.appendChild(head);

      // 条形长度表示“好”的程度：越低越好时取倒数，赢家一定更长。
      let ga = 0;
      let gb = 0;
      if (va !== null && vb !== null && va > 0 && vb > 0) {
        if (low) {
          const m = Math.min(va, vb);
          ga = (m / va) * 100;
          gb = (m / vb) * 100;
        } else {
          const m = Math.max(va, vb);
          ga = (va / m) * 100;
          gb = (vb / m) * 100;
        }
      }
      const bars = el('div', 'cmp-bars');
      const lt = el('div', 'cmp-track l');
      const lb = el('span', 'cmp-bar' + (leftWin ? ' win' : ''));
      lb.style.width = Math.max(2, Math.min(100, ga)) + '%';
      lt.appendChild(lb);
      const gap = el('div', 'cmp-gap');
      const rt = el('div', 'cmp-track');
      const rb = el('span', 'cmp-bar' + (rightWin ? ' win' : ''));
      rb.style.width = Math.max(2, Math.min(100, gb)) + '%';
      rt.appendChild(rb);
      bars.append(lt, gap, rt);
      row.appendChild(bars);
      rowsWrap.appendChild(row);
    }

    body.appendChild(rowsWrap);

    const sum = el('div', 'cmp-sum');
    if (leftWins === rightWins) {
      sum.textContent = '两边打平（各赢 ' + leftWins + ' 项）';
    } else if (leftWins > rightWins) {
      sum.append('左侧占优 ');
      sum.appendChild(el('b', 'l', leftWins + ' : ' + rightWins));
    } else {
      sum.append('右侧占优 ');
      sum.appendChild(el('b', 'r', rightWins + ' : ' + leftWins));
    }
    body.appendChild(sum);

    const names = el('div', 'detail-sub');
    names.textContent = '左 #' + left.id + ' ' + (left.sup || '') + '　右 #' + right.id + ' ' + (right.sup || '');
    body.appendChild(names);
  }

  function copyList() {
    const rows = activeRows();
    if (!rows.length) return;
    const label = S.mode === 'value' ? '性价比排序' : '综合排名';
    const lines = [label + ' · ' + (($('#model').value || '').trim())];
    rows.forEach((row, i) => {
      lines.push(
        (i + 1) + '. #' + row.id + ' ' + (row.sup || '') + '  综合 ' + row.score +
          '  成本 ' + costTxt(row.costCny100m) +
          '  首字 ' + secTxt(row.ttft) +
          '  吞吐 ' + Math.round(Number(row.tps) || 0) +
          '  成功率 ' + pctTxt(row.srr) +
          '  缓存 ' + pctTxt(row.cache) +
          '  倍率 ' + row.ratio +
          (row.pinned ? '  ✓已固定' : '')
      );
    });
    const text = lines.join('\n');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => setMsg('榜单已复制。', 'ok'),
        () => fallbackCopy(text)
      );
    } else {
      fallbackCopy(text);
    }
  }

  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      setMsg('榜单已复制。', 'ok');
    } catch (e) {
      setMsg('复制失败：当前环境不允许写剪贴板。', 'err');
    }
    ta.remove();
  }

  // ── 初始化 ──────────────────────────────────────────────────────────────

  function bind() {
    bindFilters();
    $('#runBtn').addEventListener('click', run);
    $('#reloadBtn').addEventListener('click', run);
    $('#copyBtn').addEventListener('click', copyList);

    $('#list').addEventListener('click', (event) => {
      const btn = event.target.closest('button[data-action]');
      if (!btn) return;
      const id = Number(btn.dataset.id);
      if (btn.dataset.action === 'pin') pinChannel(id);
      else if (btn.dataset.action === 'disable') disableChannel(id);
      else if (btn.dataset.action === 'detail') openDetail(findRow(id));
      else if (btn.dataset.action === 'compare') openCompare(findRow(id));
    });

    document.querySelectorAll('[data-mode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        S.mode = btn.dataset.mode;
        document.querySelectorAll('[data-mode]').forEach((x) => {
          const on = x === btn;
          x.classList.toggle('active', on);
          x.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        renderList();
      });
    });

    $('#tokenSelect').addEventListener('change', () => setToken($('#tokenSelect').value));
    $('#tokensBtn').addEventListener('click', refreshTokens);
    $('#syncBtn').addEventListener('click', syncBrowserLogin);
    $('#pasteBtn').addEventListener('click', () => {
      const box = $('#pasteBox');
      box.hidden = !box.hidden;
    });
    $('#saveCookieBtn').addEventListener('click', savePastedCookie);
    $('#logoutBtn').addEventListener('click', logout);

    $('#cmpLeft').addEventListener('change', renderCompare);
    $('#cmpRight').addEventListener('change', renderCompare);
    document.querySelectorAll('[data-close]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const dlg = document.getElementById(btn.dataset.close);
        if (dlg) dlg.close();
      });
    });

    bridge.onEvent((event) => {
      if (!event || typeof event !== 'object') return;
      if (event.type === 'state-changed') probeSession();
      if (event.type === 'node-status' && event.state === 'crashed') {
        showBanner('Node 工作进程退出了。下一次操作会自动重启它；如果连续退出，停用再启用插件。');
      }
      if (event.type === 'main-ready') showBanner('');
    });
  }

  async function init() {
    applyFiltersToUI();
    bind();
    renderAuth();
    renderTokenSelect();

    let state = null;
    try {
      state = await call('panel/state', {}, 30000);
    } catch (err) {
      showBanner('连不上电子脑：' + String((err && err.message) || err) + '。右侧栏里关掉再打开这个页签试试。');
    }

    if (state && state.ok) {
      S.auth.hasCookie = Boolean(state.hasCookie);
      S.auth.userId = state.userId || null;
      S.auth.tokenId = state.tokenId || null;
      if (state.last && state.last.data) {
        setRows(state.last.data);
        const params = state.last.params || {};
        for (const key of EDITABLE) {
          if (params[key] !== undefined && params[key] !== null) S.filters[key] = params[key];
        }
        if (typeof params.onlyQualified === 'boolean') S.filters.onlyQualified = params.onlyQualified;
        if (typeof params.guaranteed === 'boolean') S.filters.guaranteed = params.guaranteed;
        applyFiltersToUI();
        const when = state.last.data.ts ? new Date(state.last.data.ts) : new Date(state.last.ts || Date.now());
        const hhmm = String(when.getHours()).padStart(2, '0') + ':' + String(when.getMinutes()).padStart(2, '0');
        setMsg('已恢复上次结果（' + hhmm + '）。点「刷新榜单」可重新抓取。', 'ok');
      }
      renderAuth();
      renderTokenSelect();
    }

    loadBrands();
    loadModels();

    if (S.auth.hasCookie) {
      await probeSession();
      await loadBalance();
      await refreshPinned();
    }

    setInterval(() => {
      if (!document.hidden && S.auth.hasCookie) loadBalance();
    }, 60000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
