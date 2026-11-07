document.getElementById('mark').textContent = '脚本已执行';
var ch = new BroadcastChannel('partner-sync');
var seq = 0;
var pending = {};
function wake() { try { fetch('cindy-ghost://partner-sync/wake'); } catch (e) {} }
ch.onmessage = function (e) {
  var d = e.data;
  if (!d || d.type !== 'rpc-reply' || !pending[d.reqId]) return;
  var p = pending[d.reqId];
  delete pending[d.reqId];
  clearInterval(p.t);
  clearTimeout(p.d);
  p.resolve(d);
};
function request(method, params) {
  var reqId = Date.now().toString(36) + '-' + (++seq);
  return new Promise(function (resolve, reject) {
    var job = { resolve: resolve };
    function send() {
      try { ch.postMessage({ type: 'rpc', reqId: reqId, method: method, params: params || {} }); } catch (e) {}
    }
    job.t = setInterval(send, 700);
    job.d = setTimeout(function () {
      delete pending[reqId];
      clearInterval(job.t);
      reject(new Error('插件没有响应'));
    }, 20000);
    pending[reqId] = job;
    wake();
    send();
  });
}
function call(m, p) {
  return request(m, p).then(function (r) {
    if (r.ok === false) throw new Error(r.error || '操作失败');
    return r;
  });
}
function $(id) { return document.getElementById(id); }
function setMsg(t, kind) {
  var el = $('msg');
  el.textContent = t || '';
  el.className = kind ? kind : '';
}
function normalize(t) { return String(t || '').replace(/\s+/g, '').trim(); }
function kb(n) { return n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B'; }

var partners = [];
var memories = [];
var dstHashes = {};
var dstTitles = {};
var dstMemories = [];
var soulText = '';
var busy = false;
var srcId = '';
var dstId = '';

// ── 伙伴选择器 ─────────────────────────────────────────────────────────────

function avatarNode(p) {
  if (p.avatarSrc) {
    var img = document.createElement('img');
    img.className = 'combo-avatar';
    img.src = p.avatarSrc;
    img.alt = '';
    return img;
  }
  var d = document.createElement('span');
  d.className = 'combo-avatar letter';
  d.textContent = String(p.name || '?').slice(0, 1);
  return d;
}

function closeCombos() {
  var els = document.querySelectorAll('.combo.open');
  for (var i = 0; i < els.length; i++) els[i].classList.remove('open');
}

function findPartner(id) {
  for (var i = 0; i < partners.length; i++) if (partners[i].id === id) return partners[i];
  return null;
}

function buildCombo(el, list, currentId, onPick) {
  el.innerHTML = '';
  el.classList.remove('open');
  var current = findPartner(currentId) || list[0] || null;
  if (current && list.indexOf(current) === -1) current = list[0] || null;

  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'combo-btn';
  if (current) {
    btn.appendChild(avatarNode(current));
    var nm = document.createElement('span');
    nm.className = 'combo-name';
    nm.textContent = current.name;
    btn.appendChild(nm);
    var ct = document.createElement('span');
    ct.className = 'combo-count';
    ct.textContent = current.memoryCount + ' 条';
    btn.appendChild(ct);
  }
  var caret = document.createElement('span');
  caret.className = 'combo-caret';
  caret.textContent = '▾';
  btn.appendChild(caret);
  btn.onclick = function (ev) {
    ev.stopPropagation();
    var wasOpen = el.classList.contains('open');
    closeCombos();
    if (!wasOpen) el.classList.add('open');
  };

  var listEl = document.createElement('div');
  listEl.className = 'combo-list';
  list.forEach(function (item) {
    var row = document.createElement('div');
    row.className = 'combo-item' + (current && item.id === current.id ? ' active' : '');
    row.appendChild(avatarNode(item));
    var text = document.createElement('div');
    text.className = 'combo-text';
    var n = document.createElement('div');
    n.className = 'combo-name';
    n.textContent = item.name;
    var c = document.createElement('div');
    c.className = 'combo-count';
    c.textContent = item.memoryCount + ' 条记忆';
    text.appendChild(n);
    text.appendChild(c);
    row.appendChild(text);
    row.onclick = function (ev) {
      ev.stopPropagation();
      closeCombos();
      onPick(item.id);
    };
    listEl.appendChild(row);
  });

  el.appendChild(btn);
  el.appendChild(listEl);
}

function renderCombos() {
  var dstList = [];
  for (var i = 0; i < partners.length; i++) {
    if (partners[i].id !== srcId) dstList.push(partners[i]);
  }
  buildCombo($('srcCombo'), partners, srcId, onSrcPick);
  buildCombo($('dstCombo'), dstList, dstId, onDstPick);
}

function onSrcPick(id) {
  srcId = id;
  var dstList = [];
  for (var i = 0; i < partners.length; i++) {
    if (partners[i].id !== srcId) dstList.push(partners[i]);
  }
  var keep = false;
  for (var j = 0; j < dstList.length; j++) if (dstList[j].id === dstId) keep = true;
  if (!keep) dstId = dstList.length ? dstList[0].id : '';
  renderCombos();
  setMsg('');
  renderSoul();
  loadMem();
  loadDstMemories();
  updateButtons();
}

function onDstPick(id) {
  dstId = id;
  renderCombos();
  setMsg('');
  loadDstMemories();
  updateButtons();
}

// ── 数据 ───────────────────────────────────────────────────────────────────

function updateButtons() {
  var n = document.querySelectorAll('#list input:checked').length;
  var same = srcId && srcId === dstId;
  var btn = $('syncMem');
  btn.textContent = n ? '同步选中的 ' + n + ' 条记忆' : '同步选中的记忆';
  btn.disabled = busy || n === 0 || same;
  $('syncSoul').disabled = busy || same || !soulText;
}

function renderSoul() {
  if (!srcId) return;
  call('partners/soul', { botId: srcId }).then(function (r) {
    soulText = r.text || '';
    $('soulSize').textContent = kb(r.bytes || 0);
    $('soulPreview').textContent = soulText;
    updateButtons();
  }).catch(function (e) {
    soulText = '';
    $('soulSize').textContent = '';
    setMsg(String(e.message || e), 'err');
    updateButtons();
  });
}

function loadMem() {
  if (!srcId) return;
  call('partners/memories', { botId: srcId }).then(function (r) {
    memories = r.memories || [];
    renderAll();
  }).catch(function (e) {
    memories = [];
    renderAll();
    setMsg(String(e.message || e), 'err');
  });
}

function loadDstMemories() {
  if (!dstId) { dstMemories = []; renderAll(); return; }
  call('partners/memories', { botId: dstId }).then(function (r) {
    dstMemories = r.memories || [];
    renderAll();
  }).catch(function () {
    dstMemories = [];
    renderAll();
  });
}

/** 按正文或标题配对：各自独有 + 双方都有。 */
function pairMemories() {
  var used = {};
  var srcOnly = [];
  var common = [];
  for (var i = 0; i < memories.length; i++) {
    var m = memories[i];
    var hit = null;
    for (var j = 0; j < dstMemories.length; j++) {
      var d = dstMemories[j];
      if (used[d.file]) continue;
      if (d.hash === m.hash || normalize(d.title) === normalize(m.title)) { hit = d; break; }
    }
    if (hit) { used[hit.file] = true; common.push({ src: m, dst: hit }); }
    else srcOnly.push(m);
  }
  var dstOnly = [];
  for (var k = 0; k < dstMemories.length; k++) {
    if (!used[dstMemories[k].file]) dstOnly.push(dstMemories[k]);
  }
  return { srcOnly: srcOnly, dstOnly: dstOnly, common: common };
}

function memRow(m, opts) {
  // 可勾选的用 label，点整行就能切换；只读的用 div。
  var div = document.createElement(opts.checkable ? 'label' : 'div');
  div.className = 'item' + (opts.checkable ? '' : ' ro');

  if (opts.checkable) {
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = m.file;
    cb.addEventListener('change', updateButtons);
    div.appendChild(cb);
  }

  var body = document.createElement('div');
  body.className = 'item-body';
  var title = document.createElement('div');
  title.className = 'item-title';
  var nameEl = document.createElement('span');
  nameEl.className = 'title-text';
  nameEl.textContent = m.title || m.file;
  title.appendChild(nameEl);

  let pre = document.createElement('pre');
  pre.className = 'mem-body';
  pre.hidden = true;
  pre.textContent = m.body || '';

  let toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'toggle mem-toggle';
  toggle.textContent = '展开';
  toggle.onclick = function (ev) {
    ev.preventDefault();
    ev.stopPropagation();
    pre.hidden = !pre.hidden;
    toggle.textContent = pre.hidden ? '展开' : '收起';
  };
  title.appendChild(toggle);

  let armed = false;
  let del = document.createElement('button');
  del.type = 'button';
  del.className = 'toggle mem-del';
  del.textContent = '删除';
  del.onclick = function (ev) {
    ev.preventDefault();
    ev.stopPropagation();
    if (!armed) {
      armed = true;
      del.textContent = '确认删除';
      del.classList.add('danger');
      setTimeout(function () {
        if (armed) { armed = false; del.textContent = '删除'; del.classList.remove('danger'); }
      }, 3000);
      return;
    }
    armed = false;
    del.disabled = true;
    del.textContent = '删除中…';
    call('memories/delete', { botId: opts.partnerId, file: m.file }).then(function () {
      setMsg('已删除「' + (m.title || m.file) + '」', 'ok');
      load();
    }).catch(function (e) {
      setMsg(String(e.message || e), 'err');
      del.disabled = false;
      del.textContent = '删除';
      del.classList.remove('danger');
    });
  };
  title.appendChild(del);

  body.appendChild(title);
  if (m.description) {
    var desc = document.createElement('div');
    desc.className = 'item-desc';
    desc.textContent = m.description;
    body.appendChild(desc);
  }
  body.appendChild(pre);
  div.appendChild(body);
  return div;
}

function renderCol(box, list, opts) {
  box.innerHTML = '';
  if (!list.length) {
    var p = document.createElement('div');
    p.className = 'empty';
    p.textContent = opts.empty || '无';
    box.appendChild(p);
    return;
  }
  for (var i = 0; i < list.length; i++) {
    box.appendChild(memRow(list[i], opts));
  }
}

function renderAll() {
  var p = pairMemories();
  var sp = findPartner(srcId);
  var dp = findPartner(dstId);
  var sn = sp ? sp.name : '—';
  var dn = dp ? dp.name : '—';

  $('srcColHead').textContent = '源 · ' + sn + ' · ' + p.srcOnly.length + ' 条独有';
  $('dstColHead').textContent = '目标 · ' + dn + ' · ' + p.dstOnly.length + ' 条独有';
  renderCol($('list'), p.srcOnly, { checkable: true, partnerId: srcId, empty: '没有独有的记忆' });
  renderCol($('dstList'), p.dstOnly, { checkable: false, partnerId: dstId, empty: '没有独有的记忆' });

  var showCommon = p.common.length > 0;
  $('commonHead').hidden = !showCommon;
  $('commonSect').hidden = !showCommon;
  $('commonCount').textContent = p.common.length + ' 条';
  $('commonSrcHead').textContent = '源 · ' + sn;
  $('commonDstHead').textContent = '目标 · ' + dn;
  var left = [];
  var right = [];
  for (var i = 0; i < p.common.length; i++) {
    left.push(p.common[i].src);
    right.push(p.common[i].dst);
  }
  renderCol($('commonSrcList'), left, { checkable: false, partnerId: srcId });
  renderCol($('commonDstList'), right, { checkable: false, partnerId: dstId });

  updateButtons();
}

function load() {
  setMsg('加载中…');
  call('partners/list').then(function (r) {
    partners = r.partners || [];
    if (partners.length < 2) {
      srcId = partners.length ? partners[0].id : '';
      dstId = '';
      renderCombos();
      renderAll();
      setMsg('至少需要两个伙伴才能同步');
      return;
    }
    var keepSrc = srcId && findPartner(srcId);
    srcId = keepSrc ? srcId : partners[0].id;
    var dstList = [];
    for (var i = 0; i < partners.length; i++) {
      if (partners[i].id !== srcId) dstList.push(partners[i]);
    }
    var keepDst = false;
    for (var j = 0; j < dstList.length; j++) if (dstList[j].id === dstId) keepDst = true;
    dstId = keepDst ? dstId : dstList[0].id;
    renderCombos();
    setMsg('');
    renderSoul();
    loadMem();
    loadDstMemories();
  }).catch(function (e) { setMsg(String(e.message || e), 'err'); });
}

// ── 事件 ───────────────────────────────────────────────────────────────────

document.addEventListener('click', closeCombos);

$('toggleSoul').onclick = function () {
  var pre = $('soulPreview');
  pre.hidden = !pre.hidden;
  this.textContent = pre.hidden ? '展开' : '收起';
};
$('checkAll').onclick = function () {
  var els = document.querySelectorAll('#list input:not(:disabled)');
  for (var i = 0; i < els.length; i++) els[i].checked = true;
  updateButtons();
};
$('checkNone').onclick = function () {
  var els = document.querySelectorAll('#list input');
  for (var i = 0; i < els.length; i++) els[i].checked = false;
  updateButtons();
};
$('syncSoul').onclick = function () {
  if (!srcId || !dstId || srcId === dstId) { setMsg('源和目标不能相同', 'err'); return; }
  busy = true;
  updateButtons();
  setMsg('同步中…');
  call('sync/soul', { srcId: srcId, dstId: dstId }).then(function (r) {
    setMsg('Soul 已同步，人设版本 v' + r.version + '，原文件备份为 ' + r.backup, 'ok');
  }).catch(function (e) {
    setMsg(String(e.message || e), 'err');
  }).then(function () {
    busy = false;
    updateButtons();
  });
};
$('syncMem').onclick = function () {
  var els = document.querySelectorAll('#list input:checked');
  var files = [];
  for (var i = 0; i < els.length; i++) files.push(els[i].value);
  if (!srcId || !dstId || srcId === dstId) { setMsg('源和目标不能相同', 'err'); return; }
  if (!files.length) { setMsg('先勾选记忆', 'err'); return; }
  busy = true;
  updateButtons();
  setMsg('同步中…');
  call('sync/memories', { srcId: srcId, dstId: dstId, files: files }).then(function (r) {
    var parts = ['新增 ' + r.added.length + ' 条'];
    if (r.skipped.length) parts.push('跳过重复 ' + r.skipped.length + ' 条');
    if (r.failed.length) parts.push('失败 ' + r.failed.length + ' 条');
    setMsg(parts.join('，'), r.failed.length ? 'err' : 'ok');
    for (var i = 0; i < els.length; i++) els[i].checked = false;
    load();
  }).catch(function (e) {
    setMsg(String(e.message || e), 'err');
  }).then(function () {
    busy = false;
    updateButtons();
  });
};

load();
