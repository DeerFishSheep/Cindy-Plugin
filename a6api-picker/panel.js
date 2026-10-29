
// Cindy 面板：A6API 渠道筛选。
//
// 界面、标记、class、交互流程全部来自上游 pi-a6api 0.3.10 的 views/index.html，
// 只做了三处形态替换：
//   1. window.pluginBridge.invoke("a6api.*") → BroadcastChannel 桥（见下方 RPC 表）
//   2. 筛选条件从 localStorage 改存插件 /kv（沙箱里不保证持久）
//   3. Cookie 先写宿主保险库再验证；补上账号密码登录入口
//      （上游把这条通道留在 main.js 的 a6api.login.password，UI 没有入口）
(() => {
      "use strict";

      // ── 桥接层（Cindy）─────────────────────────────────────────────────────
      // 上游 PI 版直接调 window.pluginBridge.invoke("a6api.*")。Cindy 面板里没有
      // pluginBridge：请求经 BroadcastChannel 交给电子脑 main.js，再由它调随包
      // Node worker。下面这张表是唯一的形态替换，其余面板逻辑与上游逐行一致。
      const RPC = {
        "a6api.search": "search/run",
        "a6api.balance": "balance/get",
        "a6api.brands": "brands/list",
        "a6api.models": "models/list",
        "a6api.last": "last/get",
        "a6api.session": "session/get",
        "a6api.login": "login/browser",
        "a6api.login.cookie": "login/cookie",
        "a6api.login.password": "login/password",
        "a6api.logout": "logout",
        "a6api.tokens": "tokens/list",
        "a6api.pin.current": "pin/current",
        "a6api.pin": "pin/set",
        "a6api.disable": "disable/channel",
        "a6api.status": "status/get",
        "a6api.fav.list": "fav/list",
        "a6api.fav.set": "fav/set",
        "a6api.fav.refresh": "fav/refresh"
      };

      // PI 的主题是宿主通过 app.getAppearance 给的；Cindy 面板跟随宿主注入的
      // color-scheme（宿主主题），注入不存在时（本地预览）回落系统明暗档。
      const darkQuery = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

      function detectTheme() {
        try {
          const cs = String(getComputedStyle(document.documentElement).colorScheme || "").toLowerCase();
          if (cs.includes("dark")) return "dark";
          if (cs.includes("light")) return "light";
        } catch {}
        return darkQuery && darkQuery.matches ? "dark" : "light";
      }

      const bridge = {
        async invoke(channel, payload) {
          if (channel === "app.getAppearance") return { base: detectTheme() };
          const method = RPC[channel];
          if (!method) throw new Error("未知通道：" + channel);
          return window.A6Bridge.request(method, payload ?? {});
        },
        on(event, fn) {
          if (event !== "appearance:changed") return () => {};
          let timer = null;
          const fire = () => {
            clearTimeout(timer);
            timer = setTimeout(() => fn({ base: detectTheme() }), 30);
          };
          if (darkQuery && darkQuery.addEventListener) darkQuery.addEventListener("change", fire);
          // 宿主切主题会改注入的 style/属性，不一定会触发 matchMedia
          const observer = new MutationObserver(fire);
          observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme", "data-color-scheme"] });
          observer.observe(document.head || document.documentElement, { childList: true, subtree: true, characterData: true });
          return () => {
            clearTimeout(timer);
            if (darkQuery && darkQuery.removeEventListener) darkQuery.removeEventListener("change", fire);
            observer.disconnect();
          };
        }
      };

      const $ = (id) => document.getElementById(id);

      let data = null;          // 最近一次 search 结果
      let view = "score";       // score | value | fav
      let session = null;       // 登录态
      let busy = false;
      let toastTimer = null;
      /** 当前模型的收藏：[{ channelId, snapshot, down }] */
      let favItems = [];
      /** 收藏的渠道 ID 集合，行内快速判断星标亮不亮 */
      let favIds = new Set();

      // ── 基础 ────────────────────────────────────────────────────────────────

      async function invoke(channel, payload) {
        if (!bridge?.invoke) throw new Error("桥不可用：面板要在 Cindy 里打开");
        const r = await bridge.invoke(channel, payload ?? {});
        if (r && r.ok === false && r.error) throw new Error(r.error);
        return r;
      }

      function toast(text, isError) {
        const el = $("toast");
        el.textContent = text;
        el.className = `toast show${isError ? " err" : ""}`;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { el.className = "toast"; }, isError ? 4800 : 1800);
      }

      function msg(text, kind) {
        const el = $("msg");
        el.textContent = text || "";
        el.className = `msg${kind ? " " + kind : ""}`;
      }

      // 原始值口径：ttft 是毫秒，cache / sr24 是百分比的 100 倍
      const sec = (ms) => (ms === null || ms === undefined ? "-" : ms >= 1000 ? (ms / 1000).toFixed(2) + "s" : Math.round(ms) + "ms");
      const pct = (v) => (v === null || v === undefined ? "-" : (v / 100).toFixed(1) + "%");
      const money = (v) => (v === null || v === undefined ? "-" : "¥" + v);

      function el(tag, cls, text) {
        const n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text != null) n.textContent = text;
        return n;
      }

      // ── 主题 ────────────────────────────────────────────────────────────────

      function applyTheme(v) {
        const base = v?.base ?? v?.theme;
        // 只在真的变了才写：MutationObserver 监听 data-theme，写同值会自己触发自己
        if ((base === "dark" || base === "light") && document.documentElement.dataset.theme !== base) {
          document.documentElement.dataset.theme = base;
        }
      }
      async function syncAppearance() {
        try {
          applyTheme(await bridge.invoke("app.getAppearance", {}));
        } catch {
          document.documentElement.dataset.theme =
            window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
        }
      }

      // ── 筛选条件持久化 ──────────────────────────────────────────────────────

      const FILTER_IDS = ["model", "brand", "maxRatio", "minCache", "minSr", "maxTtft", "minTps", "minSample", "guaranteed", "onlyQualified"];
      /** 回填期间不触发自动保存，否则会把半截状态写回去 */
      let restoringFilters = false;
      /** 本地是否读到了上次保存的筛选条件 */
      let savedFiltersLoaded = false;
      /** 保存失败只提醒一次，别每次输入都弹 */
      let filtersSaveWarned = false;

      function readFilters() {
        const out = {};
        for (const id of FILTER_IDS) {
          const node = $(id);
          out[id] = node.type === "checkbox" ? node.checked : node.value.trim();
        }
        return out;
      }

      function writeFilters(saved) {
        if (!saved) return;
        for (const id of FILTER_IDS) {
          const node = $(id);
          if (!node || saved[id] === undefined) continue;
          if (node.type === "checkbox") node.checked = Boolean(saved[id]);
          else node.value = saved[id];
        }
      }

      function saveFilters() {
        // 筛选条件存 Cindy 插件数据目录（ghost-fs data/filters.json），
        // 和 last.json / favorites.json 同一处；localStorage 在沙箱里不保证持久。
        invoke("filters/save", { filters: readFilters() }).catch((error) => {
          if (!filtersSaveWarned) {
            filtersSaveWarned = true;
            toast(`筛选条件没能保存：${error.message}`, true);
          }
        });
      }

      /** 改完就存（拖输入框时防抖），不必等点「开始筛选」。 */
      function bindFilterPersistence() {
        let timer = null;
        const queue = () => {
          clearTimeout(timer);
          timer = setTimeout(() => {
            if (restoringFilters) return;
            saveFilters();
          }, 400);
        };
        for (const id of FILTER_IDS) {
          const node = $(id);
          if (!node) continue;
          const evt = node.type === "checkbox" || node.tagName === "SELECT" ? "change" : "input";
          node.addEventListener(evt, queue);
        }
      }

      async function loadSavedFilters() {
        try {
          const r = await invoke("filters/get");
          if (r && r.filters) {
            restoringFilters = true;
            writeFilters(r.filters);
            restoringFilters = false;
            savedFiltersLoaded = true;
          }
        } catch {}
      }

      // ── 渲染 ────────────────────────────────────────────────────────────────

      function rows() {
        if (view === "fav") {
          // 收藏项用保存的快照渲染；没有快照的（极少数）只显示 ID。
          // 按评分从高到低排 —— 和两个榜一样，第一眼看到的就是最好的。
          return favItems
            .map((it) => ({
              ...(it.snapshot || {}),
              id: it.snapshot?.id ?? it.channelId,
              down: it.down,
            }))
            .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));
        }
        if (!data) return [];
        return view === "value" ? data.valueRanking : data.ranking;
      }

      /** 拉当前模型的收藏。 */
      async function loadFavorites() {
        try {
          const r = await invoke("a6api.fav.list", { model: $("model").value.trim() || undefined });
          favItems = Array.isArray(r.items) ? r.items : [];
        } catch {
          favItems = [];
        }
        favIds = new Set(favItems.map((x) => Number(x.channelId)));
      }

      /** 收藏是按模型存的，模型一变就得重拉；同名不重复拉。 */
      let favModel = null;
      async function syncFavorites() {
        const m = $("model").value.trim();
        if (m === favModel) return;
        favModel = m;
        await loadFavorites();
        renderResult();
      }

      /**
       * 一行的指标串：每一项自带文字标签，扫一眼就知道是什么。
       * 顺序按「成本 → 倍率 → 首字 → 缓存 → 吞吐 → 屏蔽」。
       */
      /** 倍率按站点给的原始值显示，最多 4 位小数；超出的部分直接截断，不四舍五入。 */
      function ratioText(v) {
        if (v == null) return "-";
        const s = String(Number(v));
        const dot = s.indexOf(".");
        return dot > 0 && s.length - dot - 1 > 4 ? s.slice(0, dot + 5) : s;
      }

      function metricLine(r) {
        const money = r.costCny100m == null ? "-" : Number(r.costCny100m).toFixed(2);
        const ratio = ratioText(r.ratio);
        const tps = r.tps == null ? "-" : String(Math.round(Number(r.tps)));
        const blk = r.blk == null ? "-" : String(r.blk);
        return [
          `¥${money}/1亿`,
          `倍率×${ratio}`,
          `首字${sec(r.ttft)}`,
          `缓存${pct(r.cache)}`,
          `吞吐${tps}`,
          `屏蔽${blk}`,
        ].join(" · ");
      }

      /** 分数分档，沿用 DSH 版口径：85 优秀 / 70 良好 / 55 一般 / 40 偏弱 / 其余差。 */
      function gradeOf(v) {
        if (v >= 85) return "g5";
        if (v >= 70) return "g4";
        if (v >= 55) return "g3";
        if (v >= 40) return "g2";
        return "g1";
      }

      /**
       * 行内按钮组：固定 / 禁用 / 对比 —— 和 DSH 版一致，三个都在行上，
       * 不用先展开详情再点。已固定时把「固定」换成绿色 chip。
       */
      function rowActions(r, pinnedId) {
        const box = el("div", "row-acts");
        const isPinned = pinnedId && Number(pinnedId) === Number(r.id);

        if (isPinned) {
          box.append(el("span", "chip", "✓ 已固定"));
        } else {
          const pin = el("button", "pin", "固定");
          pin.title = "把这个模型固定到该渠道";
          pin.onclick = async (ev) => {
            ev.stopPropagation();
            if (busy) return;
            busy = true;
            pin.disabled = true;
            try {
              const out = await invoke("a6api.pin", {
                channelId: r.id,
                model: $("model").value.trim() || undefined,
                tokenId: $("tokenSel").value || undefined,
              });
              toast(`已固定：${out.channelName || out.supplierName || r.id}`);
              // 服务端的固定态要过一会儿才生效，紧跟着查 pin.current 只会拿回旧渠道，
              // 又把按钮盖回去。所以直接用本次结果更新界面，等下次查询再和服务端对齐。
              if (session) session.pinnedChannelId = Number(r.id);
              renderList();
            } catch (error) {
              toast(`固定失败：${error.message}`, true);
            } finally {
              pin.disabled = false;
              busy = false;
            }
          };
          box.append(pin);
        }

        const dis = el("button", "pin dis", "禁用");
        dis.title = "禁用该渠道的这个模型（不可撤销，点两次确认）";
        dis.onclick = async (ev) => {
          ev.stopPropagation();
          // 第一次点只是上膛，3.5 秒内再点一次才真禁用
          if (dis.dataset.armed !== "1") {
            dis.dataset.armed = "1";
            dis.textContent = "确认";
            setTimeout(() => {
              if (dis.dataset.armed === "1") {
                dis.dataset.armed = "0";
                dis.textContent = "禁用";
              }
            }, 3500);
            return;
          }
          dis.disabled = true;
          try {
            await invoke("a6api.disable", {
              channelId: r.id,
              model: $("model").value.trim() || undefined,
            });
            toast(`已禁用：${r.sup || r.id}`);
            await run();
          } catch (error) {
            toast(`禁用失败：${error.message}`, true);
            dis.disabled = false;
          }
        };
        box.append(dis);

        const cmp = el("button", "pin cmp", "对比");
        cmp.title = "与另一个商家对比";
        cmp.onclick = (ev) => {
          ev.stopPropagation();
          openCompare(r);
        };
        box.append(cmp);

        // 收藏：黄色星标，再点取消。存在本地，按「模型 + 渠道 ID」绑定
        const marked = favIds.has(Number(r.id));
        const fav = el("button", `pin fav${marked ? " on" : ""}`, marked ? "★" : "☆");
        fav.title = marked ? "取消收藏" : "收藏这个渠道";
        fav.onclick = async (ev) => {
          ev.stopPropagation();
          const on = !favIds.has(Number(r.id));
          try {
            const out = await invoke("a6api.fav.set", {
              model: $("model").value.trim() || undefined,
              channelId: r.id,
              on,
              snapshot: r,
            });
            favItems = Array.isArray(out.items) ? out.items : [];
            favIds = new Set(favItems.map((x) => Number(x.channelId)));
            toast(on ? "已收藏" : "已取消收藏");
            renderResult();
          } catch (error) {
            toast(`收藏失败：${error.message}`, true);
          }
        };
        box.append(fav);

        return box;
      }

      // ── 商家对比 ────────────────────────────────────────────────────────────

      /**
       * 对比指标，沿用 DSH 版的 8 项：[键, 名称, 方向, 取值, 格式化]。
       * 成功率取 24h 与近期里更差的那个 —— 短期崩过的渠道不该因为 24h 好看就算赢。
       */
      const CMP_ROWS = [
        ["cost", "每亿成本", "low", (r) => r.costCny100m, (v) => `¥${Number(v).toFixed(3)}`],
        ["ratio", "实时倍率", "low", (r) => r.ratio, (v) => ratioText(v)],
        ["ttft", "首字", "low", (r) => r.ttft, (v) => `${(Number(v) / 1000).toFixed(2)}s`],
        ["tps", "吞吐", "high", (r) => r.tps, (v) => String(Math.round(v))],
        ["cache", "缓存率", "high", (r) => r.cache, (v) => `${(Number(v) / 100).toFixed(2)}%`],
        ["stab", "最差桶", "high", (r) => (r.stab == null ? null : r.stab * 100), (v) => String(Math.round(v))],
        [
          "sr",
          "成功率",
          "high",
          (r) => {
            const a = r.sr24 == null ? null : Number(r.sr24);
            const b = r.srr == null ? null : Number(r.srr);
            if (a === null) return b;
            if (b === null) return a;
            return Math.min(a, b);
          },
          (v) => `${(Number(v) / 100).toFixed(2)}%`,
        ],
        ["blk", "屏蔽次数", "low", (r) => r.blk, (v) => `${v} 次`],
      ];

      /** 两者的相对差距；赢的那侧才画条，条长就是这个百分比。 */
      function diffPct(a, b) {
        if (a === null || a === undefined || b === null || b === undefined) return 0;
        const base = Math.max(Math.abs(a), Math.abs(b)) || 1;
        return (Math.abs(a - b) / base) * 100;
      }

      /** 对比弹窗当前选中的左右两家。 */
      let cmpLeft = null;
      let cmpRight = null;

      function pinnedChannelId() {
        return session?.pinnedChannelId ?? null;
      }

      /**
       * 打开对比。左侧默认是当前固定的那家 —— 固定渠道就是你现在的基准；
       * 点的如果正好是固定那家，右侧留空让用户自己挑。
       */
      function openCompare(initRight) {
        const all = rows();
        const pid = pinnedChannelId();
        cmpLeft = pid ? all.find((r) => Number(r.id) === Number(pid)) || null : null;
        cmpRight = cmpLeft && initRight && Number(cmpLeft.id) === Number(initRight.id) ? null : initRight || null;
        renderCompare();
        $("cmpDlg").showModal();
      }

      function renderCompare() {
        const all = rows();
        const box = $("cmpBody");
        box.replaceChildren();

        // 两个下拉：左是对照基准，右是比的对象
        const selBox = el("div", "cmp-sel");
        const makeSel = (current, onPick, placeholder) => {
          const s = document.createElement("select");
          const none = el("option", null, placeholder);
          none.value = "";
          s.append(none);
          for (const r of all) {
            const pinnedMark = Number(r.id) === Number(pinnedChannelId()) ? "（固定中）" : "";
            const o = el("option", null, `#${r.id} ${r.sup || ""}${pinnedMark} 分${r.score ?? 0}`);
            o.value = String(r.id);
            s.append(o);
          }
          s.value = current ? String(current.id) : "";
          s.onchange = () => {
            onPick(all.find((r) => String(r.id) === s.value) || null);
            renderCompare();
          };
          return s;
        };
        selBox.append(
          makeSel(cmpLeft, (r) => { cmpLeft = r; }, "选择对照商家"),
          makeSel(cmpRight, (r) => { cmpRight = r; }, "选择对比对象"),
        );
        box.append(selBox);

        if (!cmpLeft || !cmpRight) {
          box.append(el("p", "cmp-tip", "左右各选一家对比；有固定商家时左侧默认是你固定的那家。"));
          return;
        }

        const L = cmpLeft;
        const R = cmpRight;

        const head = el("div", "dv-head");
        head.append(
          el("span", "dv-name", `#${L.id} ${L.sup || ""}`),
          el("span", "dv-vs", "vs"),
          el("span", "dv-name sec", `#${R.id} ${R.sup || ""}`),
        );
        box.append(head);

        // 胜场统计：只有两边都有值且不相同才计入
        let lw = 0;
        let rw = 0;
        for (const [, , dir, get] of CMP_ROWS) {
          const a = get(L);
          const b = get(R);
          if (a == null || b == null || a === b) continue;
          const win = dir === "high" ? (a > b ? "l" : "r") : (a < b ? "l" : "r");
          if (win === "l") lw += 1;
          else rw += 1;
        }
        const sum = el("div", "dv-sum");
        // 胜场多的一侧绿、少的一侧红，平局两边都不上色
        const lWin = lw > rw;
        const rWin = rw > lw;
        sum.append(
          el("span", `l${lWin ? " win" : rWin ? " lose" : ""}`, `左胜 ${lw}`),
          el("span", "m", `/ ${lw + rw} 项`),
          el("span", `r${rWin ? " win" : lWin ? " lose" : ""}`, `右胜 ${rw}`),
        );
        box.append(sum);

        for (const [, name, dir, get, fmt] of CMP_ROWS) {
          const a = get(L);
          const b = get(R);
          const aOk = a !== null && a !== undefined;
          const bOk = b !== null && b !== undefined;
          let win = "";
          if (aOk && bOk && a !== b) {
            win = dir === "high" ? (a > b ? "l" : "r") : (a < b ? "l" : "r");
          }
          const dp = diffPct(a, b);

          const row = el("div", "dv-row3");

          const trackL = el("div", "dv-track l");
          const barL = el("span", `dv-bar${win === "l" ? " win" : ""}`);
          barL.style.width = `${win === "l" ? dp : 0}%`;
          trackL.append(barL);

          const vL = el("span", `dv-num l${win === "l" ? " win" : ""}`, aOk ? fmt(a) : "-");
          const mid = el("span", "dv-mid", name);
          const vR = el("span", `dv-num r${win === "r" ? " win" : ""}`, bOk ? fmt(b) : "-");

          const trackR = el("div", "dv-track r");
          const barR = el("span", `dv-bar${win === "r" ? " win" : ""}`);
          barR.style.width = `${win === "r" ? dp : 0}%`;
          trackR.append(barR);

          row.append(trackL, vL, mid, vR, trackR);
          // 差异百分比挂在赢的那一侧
          // dv-adv 已并入 mid，这里不再单列
          box.append(row);
        }

      }

      function detailOf(r) {
        const box = el("div", "kv");
        const items = [
          ["渠道 ID", r.id],
          ["供应商", r.sup || "-"],
          ["渠道名", r.ch || "-"],
          ["倍率", `×${ratioText(r.ratio)}`],
          ["稳定性", r.stab == null ? "-" : Number(r.stab).toFixed(2)],
          ["首字延迟", sec(r.ttftRaw)],
          ["吞吐", r.tps ?? "-"],
          ["成功率 24h", pct(r.sr24)],
          ["近期成功率", pct(r.srr)],
          ["缓存命中", pct(r.cache)],
          ["样本数", r.n ?? "-"],
          ["保真", r.auth ? "是" : "否"],
          ["屏蔽次数", r.blk ?? "-"],
          ["路由", r.rtp === "default" ? "默认" : r.rtp || "-"],
        ];
        for (const [k, v] of items) {
          const line = el("span");
          line.append(el("i", null, k), el("b", null, String(v)));
          box.append(line);
        }
        return box;
      }

      function rowEl(r, index, pinnedId) {
        const wrap = el("div", "row");
        const head = el("div", "row-head");

        head.append(el("span", "no", String(index + 1)));
        head.append(el("span", `sc ${gradeOf(r.score ?? 0)}`, String(r.score ?? 0)));

        const body = el("div", "body");
        const nmLine = el("div", "nm-line");
        const nm = el("span", "nm");
        // #渠道ID 永远排最前，保真标记紧跟其后，再接供应商名
        nm.append(el("b", null, `#${r.id}`));
        if (r.auth) nm.append(el("b", "auth-tag", "保真"));
        nm.append(document.createTextNode(r.sup || r.ch || "未知供应商"));
        if (r.down) nm.append(el("b", "down-tag", "未在榜"));
        nmLine.append(nm);
        // 三个操作都排在名字右边，和 DSH 版一致
        nmLine.append(rowActions(r, pinnedId));
        body.append(nmLine);

        body.append(el("div", "mt", metricLine(r)));
        head.append(body);

        head.onclick = () => wrap.classList.toggle("open");
        wrap.append(head);
        // 详情默认收起（折叠规则是 .row.open .detail，必须包这一层）
        const detail = el("div", "detail");
        detail.append(detailOf(r));
        wrap.append(detail);
        return wrap;
      }

      function renderList() {
        const list = $("list");
        list.replaceChildren();
        const all = rows();
        if (!all.length) {
          list.append(el("div", "empty", view === "fav"
            ? "还没有收藏。榜单里点行尾的 ☆ 收一个，收过的渠道会一直留在这里。"
            : "没有符合条件的渠道，放宽一点筛选再试。"));
          return;
        }
        const pinnedId = session?.pinnedChannelId ?? data?.pinnedChannelId ?? null;
        all.forEach((r, i) => list.append(rowEl(r, i, pinnedId)));
      }

      function renderResult() {
        const box = $("resultSect");
        // 收藏页不依赖 search 结果，永远显示
        if (view === "fav") {
          box.hidden = false;
          const down = favItems.filter((x) => x.down).length;
          $("rankSum").textContent = `${favItems.length} 个`;
          $("rankSum").title = down ? `其中 ${down} 个未在当前榜上` : "收藏的渠道";
          renderList();
          return;
        }
        box.hidden = !data;
        if (!data) return;
        // 侧边栏窄，这行只留最关键的两个数；完整信息放 title 里。
        $("rankSum").textContent = `${data.kept}/${data.fetched}`;
        $("rankSum").title = `共 ${data.total} 个渠道，抓到 ${data.fetched} 个，${data.kept} 个合格`;
        renderList();
      }

      function renderHealth() {
        const ok = Boolean(session?.reachable);
        $("health").className = `dot ${session ? (ok ? "on" : "off") : ""}`;
        $("loginBtn").textContent = session?.loggedIn ? "已登录" : "登录";
      }

      // ── 动作 ────────────────────────────────────────────────────────────────

      async function loadSession() {
        try {
          session = await invoke("a6api.session");
        } catch {
          session = null;
        }
        renderHealth();
        if (session?.loggedIn) {
          loadBalance();
          loadTokens();
        }
      }

      /**
       * 余额。fetchBalance 返回的是 { cny, usd, quota, usedCny, requests } 而不是一个数字 ——
       * 之前按 balance.balance / balance.amount 取，永远是 undefined，顶栏于是一直空着。
       */
      async function loadBalance() {
        try {
          const bal = (await invoke("a6api.balance"))?.balance;
          if (!bal) return;
          const node = $("balance");
          if (typeof bal === "number") node.textContent = `余额 ¥${Number(bal).toFixed(2)}`;
          else if (bal.cny != null) node.textContent = `余额 ¥${Number(bal.cny).toFixed(2)}`;
          else if (bal.usd != null) node.textContent = `余额 $${Number(bal.usd).toFixed(2)}`;
          else return;
          if (bal.usedCny != null) {
            node.title = `已用 ¥${Number(bal.usedCny).toFixed(2)} · 请求 ${bal.requests ?? 0} 次`;
          }
        } catch {}
      }

      /**
       * 令牌列表。固定渠道必须带令牌 —— 一个账号下可以有多个令牌分别对应不同的
       * 额度和限速，固定到哪个令牌决定了哪些请求会走这个渠道。
       */
      async function loadTokens() {
        const row = $("tokenRow");
        try {
          const r = await invoke("a6api.tokens");
          const sel = $("tokenSel");
          sel.replaceChildren();
          const list = Array.isArray(r.tokens) ? r.tokens : [];
          if (!list.length) {
            const o = el("option", null, "无令牌");
            o.value = "";
            sel.append(o);
            row.hidden = false;
            return;
          }
          for (const t of list) {
            const o = el("option", null, `${t.name || "令牌"} · ${t.id}`);
            o.value = String(t.id);
            sel.append(o);
          }
          sel.value = String(r.tokenId || list[0].id);
          row.hidden = false;
        } catch {
          row.hidden = true;
        }
      }

      /** 固定状态要从服务端拿，决定哪些行显示「已固定」。 */
      async function refreshPinned() {
        if (!session?.loggedIn) return;
        try {
          const r = await invoke("a6api.pin.current", {
            model: $("model").value.trim() || undefined,
            tokenId: $("tokenSel").value || undefined,
          });
          const id = r?.pinned?.channelId ?? r?.pinned?.channel_id ?? r?.pinned?.row?.id ?? null;
          if (session) session.pinnedChannelId = id;
          renderList();
        } catch {}
      }

      async function run() {
        const f = readFilters();
        if (!f.model) {
          msg("先填模型名，例如 deepseek-v4.1-flash", "err");
          return;
        }
        saveFilters();
        $("run").disabled = true;
        msg("正在拉取渠道数据…");
        const started = Date.now();
        try {
          data = await invoke("a6api.search", {
            model: f.model,
            brand: f.brand,
            guaranteed: f.guaranteed,
            maxRatio: f.maxRatio,
            minCache: f.minCache,
            minSr: f.minSr,
            maxTtft: f.maxTtft,
            minTps: f.minTps,
            minSample: f.minSample,
            onlyQualified: f.onlyQualified,
            tokenId: $("tokenSel").value || undefined,
          });
          const secs = ((Date.now() - started) / 1000).toFixed(1);
          msg(`完成：${data.fetched} 个渠道，${data.kept} 个合格（${secs}s）`, "ok");
          favModel = f.model;      // 收藏按模型存，换了模型星标要重画
          await loadFavorites();
          renderResult();
          refreshPinned();
          loadBalance();       // 顶部「刷新」和「查询渠道」都走 run()，余额一起更新
        } catch (error) {
          msg(`失败：${error.message}`, "err");
        } finally {
          $("run").disabled = false;
        }
      }

      /**
       * 品牌用原生 select（系统级下拉，定位由 OS 负责，不会飘）；
       * 模型用自绘下拉 —— datalist 在 iframe 里按整窗坐标定位，弹出层会跑到很远。
       */
      let modelCache = [];

      async function loadSuggestions() {
        try {
          const [b, m] = await Promise.all([invoke("a6api.brands"), invoke("a6api.models")]);

          const sel = $("brand");
          // 先记住当前选中值：重新填 options 会把它清空
          const keep = sel.value;
          sel.replaceChildren();
          sel.append(new Option("不限", ""));
          for (const x of Array.isArray(b?.brands) ? b.brands : []) {
            const name = typeof x === "string" ? x : x.name ?? x.brand ?? "";
            if (name) sel.append(new Option(name, name));
          }
          sel.value = keep;

          modelCache = (Array.isArray(m?.models) ? m.models : [])
            .map((x) => (typeof x === "string" ? x : x.model ?? x.name ?? ""))
            .filter(Boolean);
        } catch {}
      }

      function renderModelSuggest() {
        const box = $("modelSuggest");
        const q = $("model").value.trim().toLowerCase();
        const list = q ? modelCache.filter((n) => n.toLowerCase().includes(q)) : modelCache;
        box.replaceChildren();
        if (!list.length) {
          box.hidden = true;
          return;
        }
        for (const name of list.slice(0, 80)) {
          const row = el("div", null, name);
          // 用 mousedown 而不是 click：click 之前会先触发 blur，把列表藏掉
          row.onmousedown = (ev) => {
            ev.preventDefault();
            $("model").value = name;
            box.hidden = true;
          };
          box.append(row);
        }
        box.hidden = false;
      }

      $("model").addEventListener("focus", renderModelSuggest);
      $("model").addEventListener("input", renderModelSuggest);
      $("model").addEventListener("blur", () => {
        setTimeout(() => { $("modelSuggest").hidden = true; }, 140);
        // 手动改了模型名，收藏要跟着换
        syncFavorites();
      });

      // ── 登录弹窗 ────────────────────────────────────────────────────────────

      function openLogin() {
        $("loginMsg").textContent = "";
        $("cookieInput").value = "";
        $("userInput").value = "";
        $("passInput").value = "";
        // 已登录时多给一个退出入口，省得去翻设置
        $("logoutBtn").hidden = !session?.loggedIn;
        $("loginDlg").showModal();
      }

      $("loginBtn").onclick = () => (session?.loggedIn ? openLogin() : openLogin());
      $("loginCancel").onclick = () => $("loginDlg").close();

      $("syncLogin").onclick = async () => {
        const btn = $("syncLogin");
        btn.disabled = true;
        $("loginMsg").textContent = "正在读取浏览器登录态…";
        try {
          const r = await invoke("a6api.login");
          if (r.mode === "sync") {
            $("loginMsg").textContent = `同步成功，共 ${r.tokenCount} 个令牌`;
            await loadSession();
            $("loginDlg").close();
            toast("登录成功");
          } else {
            $("loginMsg").textContent = r.reason || "已打开登录页，登录后会自动同步";
            pollLogin(0);
          }
        } catch (error) {
          $("loginMsg").textContent = `失败：${error.message}`;
        } finally {
          btn.disabled = false;
        }
      };

      /**
       * 登录页打开后每 3 秒重试一次，最多 5 分钟。
       * Cindy：电子脑（main.js）可能被宿主回收，光问 session 会永远等不到，
       * 所以每轮都重新发一次 login（它会重新尝试从浏览器同步）。
       */
      function pollLogin(tries) {
        if (tries > 100) return;
        setTimeout(async () => {
          try {
            const r = await invoke("a6api.login");
            if (r?.mode === "sync") {
              await loadSession();
              $("loginMsg").textContent = "已同步登录态";
              await loadBalance();
              $("loginDlg").close();
              toast("登录成功");
              return;
            }
          } catch {}
          pollLogin(tries + 1);
        }, 3000);
      }

      $("cookieSave").onclick = async () => {
        const cookie = $("cookieInput").value.trim();
        if (!cookie) {
          $("loginMsg").textContent = "Cookie 是空的";
          return;
        }
        try {
          // Cindy：Cookie 明文不进 BroadcastChannel —— 先交给宿主保险库，再让 worker
          // 用 node.secretBindings 注入的那份验证并回 userId。
          await bridge.saveCookie(cookie);
          await invoke("a6api.login.cookie");
          $("loginMsg").textContent = "已保存";
          await loadSession();
          $("loginDlg").close();
          toast("登录成功");
        } catch (error) {
          $("loginMsg").textContent = `失败：${error.message}`;
        }
      };

      $("passLogin").onclick = async () => {
        const username = $("userInput").value.trim();
        const password = $("passInput").value;
        if (!username || !password) {
          $("loginMsg").textContent = "账号和密码都要填";
          return;
        }
        const btn = $("passLogin");
        btn.disabled = true;
        $("loginMsg").textContent = "正在用账号密码登录…";
        try {
          const r = await invoke("a6api.login.password", { username, password });
          $("passInput").value = "";
          $("loginMsg").textContent = r?.userId ? "登录成功，用户 ID " + r.userId : "登录成功";
          await loadSession();
          $("loginDlg").close();
          toast("登录成功");
        } catch (error) {
          $("loginMsg").textContent = "失败：" + error.message;
        } finally {
          btn.disabled = false;
        }
      };

      // ── 绑定 ────────────────────────────────────────────────────────────────

      $("run").onclick = run;

      // 换令牌立刻写回后端：重开界面还是这个令牌，固定状态也跟着换
      $("tokenSel").onchange = () => {

        invoke("a6api.session", { tokenId: $("tokenSel").value }).catch(() => {});
        refreshPinned();
      };

      $("cmpClose").onclick = () => $("cmpDlg").close();

      $("copyBtn").onclick = async () => {
        const all = rows();
        if (!all.length) {
          toast("还没有结果", true);
          return;
        }
        const lines = all.map((r, i) => {
          const u = [sec(r.ttft), pct(r.cache), pct(r.sr24), `×${r.ratio ?? "-"}`, `¥${r.costCny100m}/亿`].join(" · ");
          return `${i + 1}. ${r.sup || r.ch || r.id}  ${r.score ?? 0}分  ${u}`;
        });
        const title = `A6API 渠道榜 · ${$("model").value.trim()} · ${view === "value" ? "性价比" : "综合"}`;
        const text = `${title}\n${lines.join("\n")}`;
        try {
          await navigator.clipboard.writeText(text);
          toast("已复制榜单");
        } catch {
          // 沙箱 iframe 里 clipboard 可能被拒，退回旧的选中复制
          try {
            const area = document.createElement("textarea");
            area.value = text;
            area.style.position = "fixed";
            area.style.opacity = "0";
            document.body.append(area);
            area.select();
            const ok = document.execCommand("copy");
            area.remove();
            toast(ok ? "已复制榜单" : "复制失败", !ok);
          } catch {
            toast("复制失败", true);
          }
        }
      };
      $("tokenRefresh").onclick = () => loadTokens();

      $("logoutBtn").onclick = async () => {
        try {
          await invoke("a6api.logout");
          session = null;
          $("tokenRow").hidden = true;
          $("tokenSel").replaceChildren();
          $("balance").textContent = "";
          $("loginDlg").close();
          renderHealth();
          toast("已退出登录");
        } catch (error) {
          toast(`退出失败：${error.message}`, true);
        }
      };
      $("refresh").onclick = run;
      $("seg").onclick = async (ev) => {
        const btn = ev.target.closest("button[data-k]");
        if (!btn) return;
        view = btn.dataset.k;
        for (const b of $("seg").querySelectorAll("button")) b.classList.toggle("active", b === btn);
        // 收藏页才需要「刷新」；榜单页才需要「复制」
        $("favRefresh").hidden = view !== "fav";
        $("copyBtn").hidden = view === "fav";
        if (view === "fav") await loadFavorites();
        renderResult();
      };

      /** 刷新收藏：重新拉该模型的数据，用最新值覆盖快照。 */
      $("favRefresh").onclick = async () => {
        const model = $("model").value.trim();
        if (!model) {
          toast("先填模型名", true);
          return;
        }
        const btn = $("favRefresh");
        btn.disabled = true;
        btn.textContent = "刷新中";
        try {
          // onlyQualified: false —— 收藏的渠道可能已经不达标，但仍在售，要能看到它的最新值
          const fresh = await invoke("a6api.search", { model, onlyQualified: false });
          const merged = [...(fresh.ranking ?? []), ...(fresh.valueRanking ?? [])];
          const seen = new Set();
          const uniq = merged.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
          const out = await invoke("a6api.fav.refresh", { model, rows: uniq });
          favItems = Array.isArray(out.items) ? out.items : [];
          favIds = new Set(favItems.map((x) => Number(x.channelId)));
          const down = favItems.filter((x) => x.down).length;
          toast(down ? `已刷新，${down} 个未在榜` : "已刷新", down > 0);
          renderResult();
        } catch (error) {
          toast(`刷新失败：${error.message}`, true);
        } finally {
          btn.disabled = false;
          btn.textContent = "刷新";
        }
      };

      (async () => {
        await syncAppearance();
        try { bridge?.on?.("appearance:changed", applyTheme); } catch {}
        await loadSavedFilters();
        bindFilterPersistence();
        if (!$("model").value) $("model").value = "deepseek-v4.1-flash";

        await loadSession();
        renderHealth();
        // 上游面板从不调用 status，顶栏圆点因此永远是灰的；这里补一次轻量探测（1 条）。
        invoke("a6api.status")
          .then((s) => {
            if (!session) return;
            session.reachable = Boolean(s?.reachable);
            renderHealth();
          })
          .catch(() => {});
        loadSuggestions();
        // 上次查询结果还在就直接显示，省一次 40 秒的网络往返
        try {
          const last = await invoke("a6api.last");
          if (last?.data) {
            data = last.data;
            // 上次结果的模型不能覆盖用户存下来的筛选条件（否则下次打开会“变回”旧的模型）
            if (last.params?.model && !savedFiltersLoaded) $("model").value = last.params.model;
            renderResult();
            msg(`显示上次结果（${last.data.kept} 个合格）`, "");
            refreshPinned();
          }
        } catch {}
        // 收藏按模型存，模型名确定后再拉，首次打开星标才不会全灰
        await syncFavorites();
      })();
    })();
