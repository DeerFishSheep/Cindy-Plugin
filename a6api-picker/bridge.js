// 面板 / 设置页共用的小桥：把 BroadcastChannel 请求发给电子脑（main.js）。
// 电子脑是按需拉起的，所以每次请求前先 /wake，然后按 reqId 重发到收到回执。
(function () {
  if (window.A6Bridge) return;

  function createRealBridge() {
    const ID = 'a6api-picker';
    const channel = new BroadcastChannel(ID);
    const pending = new Map();
    const listeners = new Set();
    let seq = 0;

    function wake() {
      try {
        fetch('cindy-ghost://' + ID + '/wake', { cache: 'no-store' }).catch(function () {});
      } catch (e) {}
    }
    wake();

    channel.onmessage = function (event) {
      const data = event.data;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'rpc-reply' && pending.has(data.reqId)) {
        const job = pending.get(data.reqId);
        pending.delete(data.reqId);
        clearInterval(job.timer);
        clearTimeout(job.deadline);
        job.resolve({
          ok: data.ok !== false,
          error: data.error,
          message: data.message,
          ...data
        });
        return;
      }
      for (const fn of listeners) {
        try {
          fn(data);
        } catch (e) {}
      }
    };

    function request(method, params, options) {
      const opts = options || {};
      const timeoutMs = Math.min(Math.max(Number(opts.timeout) || 120000, 3000), 180000);
      const reqId = Date.now().toString(36) + '-' + (++seq);
      return new Promise(function (resolve, reject) {
        const job = { resolve: resolve, timer: null, deadline: null };
        const send = function () {
          try {
            channel.postMessage({ type: 'rpc', reqId: reqId, method: method, params: params || {} });
          } catch (e) {}
        };
        job.timer = setInterval(send, 700);
        job.deadline = setTimeout(function () {
          pending.delete(reqId);
          clearInterval(job.timer);
          reject(new Error('电子脑没有响应（可能正在启动）。稍等几秒再试。'));
        }, timeoutMs);
        pending.set(reqId, job);
        wake();
        send();
      });
    }

    function saveCookie(value) {
      return fetch('/secrets/a6api_cookie', {
        method: 'PUT',
        body: JSON.stringify({ value: String(value) })
      }).then(function (res) {
        if (!res.ok) throw new Error('Cookie 没能写入宿主保险库（HTTP ' + res.status + '）');
        return { ok: true };
      });
    }

    function clearCookie() {
      return fetch('/secrets/a6api_cookie', { method: 'DELETE' }).then(function (res) {
        if (!res.ok) throw new Error('清除 Cookie 失败（HTTP ' + res.status + '）');
        return { ok: true };
      });
    }

    function secretStatus() {
      return fetch('/secrets')
        .then(function (res) { return res.json(); })
        .then(function (list) {
          const hit = Array.isArray(list) ? list.find(function (x) { return x && x.key === 'a6api_cookie'; }) : null;
          return { saved: Boolean(hit && hit.saved), tail: (hit && hit.tail) || null };
        })
        .catch(function () { return { saved: false, tail: null }; });
    }

    function onEvent(fn) {
      listeners.add(fn);
      return function () { listeners.delete(fn); };
    }

    return { request: request, saveCookie: saveCookie, clearCookie: clearCookie, secretStatus: secretStatus, onEvent: onEvent, wake: wake, live: true };
  }

  window.A6Bridge = window.__A6API_TEST_BRIDGE__ || createRealBridge();
})();
