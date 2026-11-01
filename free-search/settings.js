// 设置页逻辑。三块：引擎链路（/kv）、搜索默认值（/kv）、逐引擎 API Key
// （经电子脑转给 worker，存在插件自己的数据目录里）。
//
// 引擎元数据在这里复刻一份最小版本（名字 + 一句话说明 + 免 key 与否）。
// 之所以不在运行时从 worker 里取：设置页和 worker 是两个进程，
// 为了几十字节的展示文案来回开进程不划算。真正的引擎清单以 worker 为准，
// 这里只影响界面。

const ENGINES = [
  { id: "exa", name: "Exa", note: "语义搜索，免 key 走 MCP 端点" },
  { id: "tavily", name: "Tavily", note: "为 AI 优化的搜索，有免费额度" },
  { id: "keenable", name: "Keenable", note: "免费搜索 API" },
  { id: "firecrawl", name: "Firecrawl", note: "抓取型搜索，额度有限" },
  { id: "parallel", name: "Parallel", note: "免 key 走 MCP 端点" },
  { id: "bing", name: "Bing", note: "直抓结果页，无需 key" },
  { id: "anysearch", name: "AnySearch", note: "免费搜索 API" },
  { id: "ddg", name: "DuckDuckGo", note: "直抓 HTML 结果页" },
  { id: "ddg-lite", name: "DDG Lite", note: "轻量版，响应更快" },
  { id: "searxng", name: "SearXNG", note: "元搜索，走公共实例" },
  { id: "you", name: "You.com", note: "需要 YDC_API_KEY" },
  { id: "perplexity", name: "Perplexity", note: "答案带引用，需 key" },
  { id: "serpbase", name: "SerpBase", note: "Google 结果代理，需 key" },
  { id: "serply", name: "Serply", note: "Google 结果代理，需 key" },
  { id: "deepseek-official", name: "DeepSeek 官方", note: "官方搜索接口，需 key" },
  { id: "deepseek-tools", name: "DeepSeek Tools", note: "工具版搜索，需 key" },
  { id: "baidu", name: "百度", note: "百度千帆搜索，需 key" },
  { id: "kimi", name: "Kimi", note: "月之暗面搜索，需 key" },
  { id: "aliyun", name: "阿里云", note: "百炼搜索，需 key" },
  { id: "doubao", name: "豆包", note: "火山引擎搜索，需 key" },
  { id: "tinyfish", name: "TinyFish", note: "第三方搜索 API，需 key" },
  { id: "jina", name: "Jina", note: "jina.ai 搜索，需 key" },
  { id: "zhihu_global", name: "知乎 · 全网", note: "知乎全局搜索，需 key" },
  { id: "zhihu_site", name: "知乎 · 站内", note: "知乎站内搜索，需 key" },
];

// 这几个只有显式点名才跑，不进自动链路（会按次计费）。
const EXPLICIT_ONLY = ["openai", "gemini", "claude"];

// 免 key 就能跑的：其它引擎没填 key 时留在界面上但会提示需要 key。
const KEYLESS = new Set([
  "exa", "tavily", "keenable", "firecrawl", "parallel",
  "bing", "anysearch", "ddg", "ddg-lite", "searxng",
]);

const DEFAULT_CHAIN = [
  "exa", "tavily", "keenable", "firecrawl", "parallel",
  "bing", "anysearch", "ddg", "ddg-lite", "searxng",
];

const $ = (sel) => document.querySelector(sel);

let cfg = {};

function chainFromConfig() {
  const saved = Array.isArray(cfg.fallbackOrder) && cfg.fallbackOrder.length
    ? cfg.fallbackOrder
    : DEFAULT_CHAIN;
  const disabled = Array.isArray(cfg.disabledEngines) ? cfg.disabledEngines : [];
  // 界面上列出：已保存的顺序在前，其余引擎排在后面（默认不勾选）。
  const known = ENGINES.filter((e) => !EXPLICIT_ONLY.includes(e.id)).map((e) => e.id);
  const ordered = [...saved.filter((id) => known.includes(id))];
  for (const id of known) if (!ordered.includes(id)) ordered.push(id);
  return ordered.map((id) => ({
    id,
    enabled: saved.includes(id) && !disabled.includes(id),
  }));
}

let workChain = [];

// engineId → { tail, source }，来自 worker 的 keys/list。source 是
// "settings"（本插件设置页配的）/ "env"（环境变量）/ "none"。
let keyState = {};

// 每个需要 key 的引擎，key 怎么申请。设置页里点「获取 key」直接跳官方控制台。
const KEY_URLS = {
  tavily: "https://app.tavily.com/home",
  you: "https://api.you.com/",
  perplexity: "https://www.perplexity.ai/settings/api",
  serpbase: "https://serpbase.com/",
  serply: "https://serply.io/",
  "deepseek-official": "https://platform.deepseek.com/api_keys",
  "deepseek-tools": "https://platform.deepseek.com/api_keys",
  baidu: "https://console.bce.baidu.com/qianfan/ais/console/applicationConsole/application",
  kimi: "https://platform.moonshot.cn/console/api-keys",
  aliyun: "https://bailian.console.aliyun.com/",
  doubao: "https://console.volcengine.com/ark",
  tinyfish: "https://www.tinyfish.ai/",
  jina: "https://jina.ai/reader/",
  zhihu_global: "https://developer.zhihu.com/",
  zhihu_site: "https://developer.zhihu.com/",
  exa: "https://dashboard.exa.ai/api-keys",
  keenable: "https://keenable.ai/",
  firecrawl: "https://www.firecrawl.dev/app/api-keys",
  parallel: "https://platform.parallel.ai/",
  anysearch: "https://anysearch.com/",
};

/** 该引擎当前有没有可用 key。 */
function hasKey(engine) {
  const state = keyState[engine];
  return Boolean(state && state.source && state.source !== "none");
}

/** key 按钮上显示的文字。 */
function keyButtonLabel(engine) {
  const state = keyState[engine];
  if (!state || state.source === "none") return "设置 key";
  if (state.tail) return `key …${state.tail}`;
  return "已配置";
}

function renderChain() {
  const list = $("#engineList");
  list.textContent = "";

  workChain.forEach((item, index) => {
    const meta = ENGINES.find((e) => e.id === item.id);
    if (!meta) return;

    const wrapper = document.createElement("div");

    const row = document.createElement("div");
    row.className = "row" + (item.enabled ? "" : " is-off");

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = item.enabled;
    checkbox.onchange = () => {
      item.enabled = checkbox.checked;
      row.className = "row" + (item.enabled ? "" : " is-off");
      setStatus("#orderStatus", "");
    };

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = meta.name;

    const keyless = KEYLESS.has(item.id);
    const tag = document.createElement("span");
    // 有 key 的「需 key」引擎不再标黄——它已经配好了，黄色只留给缺 key 的。
    tag.className = "tag" + (keyless || hasKey(item.id) ? "" : " key");
    tag.textContent = keyless ? "免 key" : hasKey(item.id) ? "已配 key" : "需 key";

    const note = document.createElement("span");
    note.className = "note";
    note.textContent = meta.note;
    note.title = meta.note;

    const move = document.createElement("div");
    move.className = "move";
    const up = document.createElement("button");
    up.className = "icon";
    up.textContent = "↑";
    up.disabled = index === 0;
    up.title = "上移";
    up.onclick = () => {
      [workChain[index - 1], workChain[index]] = [workChain[index], workChain[index - 1]];
      renderChain();
      setStatus("#orderStatus", "");
    };
    const down = document.createElement("button");
    down.className = "icon";
    down.textContent = "↓";
    down.disabled = index === workChain.length - 1;
    down.title = "下移";
    down.onclick = () => {
      [workChain[index + 1], workChain[index]] = [workChain[index], workChain[index + 1]];
      renderChain();
      setStatus("#orderStatus", "");
    };
    move.append(up, down);

    row.append(checkbox, name, tag, note, move);

    if (!EXPLICIT_ONLY.includes(item.id)) {
      // 行内测试：只测这一个引擎，结果直接显示在这一行下面。
      const testButton = document.createElement("button");
      testButton.className = "icon";
      testButton.textContent = "测";
      testButton.title = `单独测试 ${meta.name}，看它现在能不能返回结果`;

      const testLine = document.createElement("div");
      testLine.className = "testline";

      testButton.onclick = async () => {
        // 再点一次收起，避免展开多条占满面板。
        if (testLine.classList.contains("show") && !testButton.disabled) {
          testLine.classList.remove("show");
          return;
        }
        testButton.disabled = true;
        testButton.classList.add("testing");
        testButton.textContent = "…";
        testLine.className = "testline show";
        testLine.textContent = "测试中，最多等十几秒…";

        try {
          const result = await testOneEngine(item.id);
          if (result.ok) {
            testLine.className = "testline show ok";
            testLine.textContent = `✓ ${meta.name} 可用 · ${result.count} 条结果 · ${result.ms}ms`;
            if (result.sample) {
              const sample = document.createElement("span");
              sample.className = "sample";
              sample.textContent = result.sample;
              sample.title = result.sample;
              testLine.append(sample);
            }
          } else {
            testLine.className = "testline show bad";
            testLine.textContent = `✕ ${result.message}`;
          }
        } catch (error) {
          testLine.className = "testline show bad";
          testLine.textContent = `✕ ${error.message}`;
        } finally {
          testButton.disabled = false;
          testButton.classList.remove("testing");
          testButton.textContent = "测";
        }
      };

      // 免 key 的引擎也给 key 按钮：可以用 key 换更高额度，只是不强制。
      const keyButton = document.createElement("button");
      keyButton.className = "icon" + (hasKey(item.id) ? " haskey" : "");
      keyButton.textContent = keyButtonLabel(item.id);
      keyButton.title = "配置这个引擎的 API Key";
      const editor = buildKeyEditor(item.id);
      keyButton.onclick = () => {
        const open = editor.classList.toggle("open");
        keyButton.textContent = open ? "收起" : keyButtonLabel(item.id);
      };

      row.append(testButton, keyButton);
      wrapper.append(row, testLine, editor);
    } else {
      // openai / gemini / claude 按次计费，不进链路也不在这里配 key，
      // 所以整行不显示（本来就在 ENGINES 之外了，这里只是兜底）。
      wrapper.append(row);
    }

    list.append(wrapper);
  });
}

/** 某一行的 key 编辑区：一个密码框 + 保存/清除。 */
function buildKeyEditor(engine) {
  const box = document.createElement("div");
  box.className = "keyedit";

  const state = keyState[engine];
  if (state && state.source === "env") {
    const note = document.createElement("p");
    note.className = "hint note";
    note.textContent = "当前用的是环境变量里的 key，在这里保存会覆盖它。";
    box.append(note);
  }

  const line = document.createElement("div");
  line.className = "line";

  const input = document.createElement("input");
  input.type = "password";
  input.placeholder = hasKey(engine) ? "粘贴新 key 以替换，或点清除" : "粘贴 API Key";
  input.autocomplete = "off";
  input.spellcheck = false;

  const save = document.createElement("button");
  save.className = "primary";
  save.textContent = "保存";

  const clear = document.createElement("button");
  clear.textContent = "清除";
  clear.disabled = !(state && state.source === "settings");

  const getKey = document.createElement("button");
  getKey.textContent = "获取 key";
  const url = KEY_URLS[engine];
  if (url) {
    // 主机把外链交给系统浏览器打开，沙箱页不离开 cindy-ghost://
    const link = document.createElement("a");
    link.href = url;
    link.style.textDecoration = "none";
    link.style.color = "inherit";
    link.append(getKey);
    line.append(input, save, clear, link);
  } else {
    line.append(input, save, clear);
  }

  const msg = document.createElement("div");
  msg.className = "msg";

  const say = (text, kind) => {
    msg.textContent = text;
    msg.className = "msg" + (kind ? " status " + kind : "");
  };

  save.onclick = async () => {
    const value = input.value.trim();
    if (!value) {
      say("先粘一个 key 进来", "bad");
      return;
    }
    save.disabled = true;
    try {
      await setEngineKey(engine, value);
      input.value = "";
      say("已保存", "ok");
      await refreshKeys();
      renderChain();
    } catch (error) {
      say(String(error.message), "bad");
    } finally {
      save.disabled = false;
    }
  };

  clear.onclick = async () => {
    clear.disabled = true;
    try {
      await setEngineKey(engine, "");
      say("已清除", "ok");
      await refreshKeys();
      renderChain();
    } catch (error) {
      say(String(error.message), "bad");
      clear.disabled = false;
    }
  };

  box.append(line, msg);
  return box;
}

function setStatus(sel, text, kind) {
  const el = $(sel);
  el.textContent = text;
  el.className = "status" + (kind ? " " + kind : "");
}

async function readConfig() {
  try {
    const response = await fetch("/kv");
    cfg = response.ok ? await response.json() : {};
  } catch {
    cfg = {};
  }
  if (!cfg || typeof cfg !== "object") cfg = {};

  workChain = chainFromConfig();
  renderChain();
  $("#maxResults").value = cfg.maxResults ?? "";
  $("#bingMarket").value = cfg.bingMarket ?? "";
}

async function saveConfig(patch) {
  const next = { ...cfg, ...patch };
  const response = await fetch("/kv", { method: "PUT", body: JSON.stringify(next) });
  if (!response.ok) throw new Error(`保存失败（HTTP ${response.status}）`);
  cfg = next;
  new BroadcastChannel("free-search").postMessage({ type: "settings-changed" });
}

$("#saveOrder").onclick = async () => {
  const enabled = workChain.filter((item) => item.enabled).map((item) => item.id);
  if (!enabled.length) {
    setStatus("#orderStatus", "至少要勾一个引擎", "bad");
    return;
  }
  const all = workChain.map((item) => item.id);
  try {
    await saveConfig({
      fallbackOrder: all,
      disabledEngines: all.filter((id) => !enabled.includes(id)),
      provider: enabled[0],
    });
    setStatus("#orderStatus", `已保存，首选 ${enabled[0]}（共 ${enabled.length} 个）`, "ok");
  } catch (error) {
    setStatus("#orderStatus", String(error.message), "bad");
  }
};

$("#saveMisc").onclick = async () => {
  const maxResults = Number($("#maxResults").value);
  try {
    await saveConfig({
      maxResults: Number.isFinite(maxResults) && maxResults > 0 ? Math.min(maxResults, 20) : 8,
      bingMarket: $("#bingMarket").value.trim() || "zh-CN",
    });
    setStatus("#miscStatus", "已保存", "ok");
  } catch (error) {
    setStatus("#miscStatus", String(error.message), "bad");
  }
};

// 设置页没有 tool-call，拿不到 callId，所以不能走 cindy.fetch 那条正路。
// 但设置页和电子脑同源、共用 BroadcastChannel——把请求广播给电子脑，
// 由它转 worker 实测，结果再广播回来。电子脑是按需拉起的，先 wake 它一下。
//
// 走 worker 的 free_search_test 工具并只传一个引擎：它用的就是搜索时那套
// 引擎实现和 key 解析，所以这里的结果和真实搜索一致。
let testReqId = 0;

function testOneEngine(engine, query) {
  return new Promise((resolve, reject) => {
    const reqId = `test-${Date.now()}-${++testReqId}`;
    const channel = new BroadcastChannel("free-search");

    const timer = setTimeout(() => {
      channel.close();
      reject(new Error("电子脑没回音。在对话里搜一次再回来试，或者重启 Cindy。"));
    }, 60000);

    channel.onmessage = (event) => {
      const data = event.data;
      if (!data || data.type !== "engine-test-result" || data.reqId !== reqId) return;
      clearTimeout(timer);
      channel.close();
      // main.js 把测试结果直接平铺在消息上（ok / count / ms / sample / message），
      // 没有额外的 result 包装层。
      if (data.ok) resolve(data);
      else reject(new Error(data.message || "测试失败"));
    };

    // /wake 是幂等的：已经在跑就直接返回。叫不醒也不影响下面的广播，
    // 只是定时器会兜底报错。
    fetch(`cindy-ghost://free-search/wake`).catch(() => {});
    channel.postMessage({ type: "engine-test-request", reqId, engine, query });
  });
}

// ── 逐引擎 key：经电子脑转给 worker 读写 ────────────────────────────────────
//
// 设置页拿不到 worker（不同进程），也没有 callId 走不了 cindy.fetch。
// 但和电子脑同源、共用 BroadcastChannel，所以把请求广播过去、等它回执。
// 电子脑是按需拉起的，先 wake 一次。

function requestWorker(method, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    const reqId = `kv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const channel = new BroadcastChannel("free-search");

    const timer = setTimeout(() => {
      channel.close();
      reject(new Error("电子脑没回音。在对话里搜一次再回来试，或者重启 Cindy。"));
    }, timeoutMs || 15000);

    channel.onmessage = (event) => {
      const data = event.data;
      if (!data || data.type !== "worker-reply" || data.reqId !== reqId) return;
      clearTimeout(timer);
      channel.close();
      if (data.ok) resolve(data.result);
      else reject(new Error(data.message || "操作失败"));
    };

    fetch(`cindy-ghost://free-search/wake`).catch(() => {});
    channel.postMessage({ type: "worker-call", reqId, method, params });
  });
}

async function refreshKeys() {
  try {
    const result = await requestWorker("keys/list", {}, 10000);
    keyState = result?.engines ?? {};
  } catch {
    // 读不到就当作全都没配——界面照样能画，只是看不到尾号。
    keyState = {};
  }
}

async function setEngineKey(engine, value) {
  const result = await requestWorker("keys/set", { engine, value }, 10000);
  if (!result || result.ok !== true) throw new Error(result?.content || "写入失败");
  new BroadcastChannel("free-search").postMessage({ type: "settings-changed" });
}

async function boot() {
  await readConfig();
  await refreshKeys();
  renderChain();
}

boot();
