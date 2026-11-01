// Cindy 电子脑：把 Agent 的 tool-call 转给随包 Node worker，再把结果交回去。
//
// 这里刻意做得很薄。搜索的实质逻辑（27 个引擎、回退链、冷却、去重）全在
// node/extensions/free-search/engine.mjs 里，是上游 DDDMUC/dsh-free-search 的
// 原样代码，一行没改。这个文件只负责三件事：读设置页存的链路配置、把工具名和
// 参数递给 worker、把 worker 的正文交回聊天。
//
// 关于 API Key：不走宿主凭证库。宿主的 /secrets 是只写的——能告诉你有没有配、
// 尾号是什么，但永远读不回值。27 个引擎挤在一个凭证里就没法做逐行配置。
// 所以 key 由 worker 存在插件自己的数据目录（0600），设置页经 BroadcastChannel
// 让 worker 逐条读写。这样每个引擎能单独设置、单独清除、单独显示尾号。

const DEFAULT_TIMEOUTS = {
  web_search: 60000,
  web_fetch: 20000,
  platform_search: 30000,
  video_search: 30000,
  weather: 20000,
  free_search_test: 120000,
};

/** 读设置页存的配置；读不到就用 worker 里的默认值。 */
async function readSettings() {
  try {
    const response = await fetch("/kv");
    if (!response.ok) return {};
    const cfg = await response.json();
    return cfg && typeof cfg === "object" ? cfg : {};
  } catch {
    return {};
  }
}

function fail(callId, errorCode, message) {
  return cindy.send({ type: "tool-result", callId, ok: false, errorCode, message });
}

cindy.onHostMessage(async function (msg) {
  if (msg.type !== "tool-call") return;

  if (DEFAULT_TIMEOUTS[msg.tool] === undefined) {
    await fail(
      msg.callId,
      "UNKNOWN_TOOL",
      `免费联网搜索插件不认识工具 "${msg.tool}"。可用的是：${Object.keys(DEFAULT_TIMEOUTS).join(", ")}。`,
    );
    return;
  }

  const settings = await readSettings();

  let response;
  try {
    response = await cindy.node.request({
      method: "search/run",
      callId: msg.callId,
      params: {
        tool: msg.tool,
        args: msg.args ?? {},
        // worker 会把这份配置合到它自己的默认值上，多传几个键是安全的。
        settings,
      },
      timeoutMs: DEFAULT_TIMEOUTS[msg.tool],
    });
  } catch (error) {
    await fail(
      msg.callId,
      "NODE_REQUEST_FAILED",
      `搜索进程没能启动：${error?.message ?? error}。如果是刚安装，先重试一次；仍然失败就在插件页停用再启用这个插件。`,
    );
    return;
  }

  if (!response.ok) {
    await fail(
      msg.callId,
      "NODE_REQUEST_FAILED",
      `搜索进程返回失败：${response.message || "(没有说明)"}。可以在插件设置页点「实测全部」看看哪个引擎现在还活着。`,
    );
    return;
  }

  const result = response.result ?? {};

  if (result.ok === false) {
    // 引擎全挂、或某个引擎单独失败——都是业务失败。把 worker 的原话给模型，
    // 它自己会决定要不要换关键词重试。不当作工具错误，免得中断整轮。
    await cindy.send({
      type: "tool-result",
      callId: msg.callId,
      ok: true,
      result: { content: result.content || "搜索没有返回结果。", isError: true },
    });
    return;
  }

  await cindy.send({
    type: "tool-result",
    callId: msg.callId,
    ok: true,
    result: {
      content: result.content || "(空结果)",
      ...(result.detail ? { details: result.detail } : {}),
    },
  });
});

// ── 设置页的请求 ───────────────────────────────────────────────────────────
//
// 设置页没有 callId，不能直接让 worker 干活。它通过 BroadcastChannel 把请求
// 广播过来，这里转给 worker，结果再广播回去。没有 callId 的 node.request
// 不弹授权卡、不随 tool-call 回收，适合这种用户主动点的短操作。
//
// 两类请求走同一条路：worker-call（逐引擎 key 读写）和 engine-test-request
// （实测引擎）。

const settingsChannel = new BroadcastChannel("free-search");

settingsChannel.onmessage = async (event) => {
  const data = event.data;
  if (!data) return;

  if (data.type === "worker-call") {
    const reply = (payload) =>
      settingsChannel.postMessage({ type: "worker-reply", reqId: data.reqId, ...payload });
    try {
      const response = await cindy.node.request({
        method: String(data.method || ""),
        params: data.params ?? {},
        timeoutMs: 15000,
      });
      if (!response.ok) {
        reply({ ok: false, message: response.message || "worker 没有响应" });
        return;
      }
      reply({ ok: true, result: response.result });
    } catch (error) {
      reply({ ok: false, message: String(error?.message ?? error) });
    }
    return;
  }

  if (data.type !== "engine-test-request") return;

  const reply = (payload) =>
    settingsChannel.postMessage({ type: "engine-test-result", reqId: data.reqId, ...payload });

  try {
    const settings = await readSettings();
    const engine = String(data.engine || "").trim();
    if (!engine) {
      reply({ ok: false, message: "没有指定要测哪个引擎" });
      return;
    }

    const response = await cindy.node.request({
      method: "search/run",
      params: {
        tool: "free_search_test",
        args: { engines: [engine], query: String(data.query || "DeepSeek") },
        settings,
      },
      timeoutMs: 60000,
    });

    if (!response.ok) {
      reply({ ok: false, message: response.message || "worker 没能跑起来" });
      return;
    }

    // worker 的 free_search_test 返回 { detail: { lines, ... } }，单引擎时
    // lines 恰好一条。解析它，把结果拆成结构化字段给界面直接用。
    //
    // 三种兜底：worker 整体报错（result.ok === false）、没给 detail、lines 为空。
    // 任何一种都别让界面拿到 undefined 后崩在 .ok 上。
    if (response.result?.ok === false) {
      reply({ ok: false, message: response.result.content || "worker 报告测试失败" });
      return;
    }
    const detail = response.result?.detail;
    if (!detail || !Array.isArray(detail.lines) || detail.lines.length === 0) {
      reply({ ok: false, message: response.result?.content || "没有拿到测试结果" });
      return;
    }
    reply(parseTestLine(engine, detail.lines[0]));
  } catch (error) {
    reply({ ok: false, message: String(error?.message ?? error) });
  }
};

/**
 * 把 worker 的一行测试报告解析成界面要的字段。
 *
 * worker 的格式：
 *   成功 `- exa: OK (2 条, 748ms, 例: "HELLO | definition...")`
 *   失败 `- exa: FAIL - <原因>`
 *   冷却 `- exa: 冷却中`
 * 解析不出来就原样把整行当失败原因，别让界面白屏。
 */
function parseTestLine(engine, line) {
  if (typeof line !== "string" || !line.trim()) {
    return { ok: false, message: "没有拿到测试结果" };
  }
  const body = line.replace(/^\s*-\s*[^:]+:\s*/, "");

  const ok = body.match(/^OK \((\d+) 条, (\d+)ms(?:, 例: "([\s\S]*)")?\)$/);
  if (ok) {
    return {
      ok: true,
      count: Number(ok[1]),
      ms: Number(ok[2]),
      sample: (ok[3] || "").replace(/"\)$/, "").trim() || null,
    };
  }

  if (body.startsWith("FAIL")) {
    const reason = body.replace(/^FAIL\s*-?\s*/, "").trim();
    return { ok: false, message: reason || `${engine} 没有返回结果` };
  }

  if (body.startsWith("冷却中")) {
    return { ok: false, message: "这个引擎刚失败过，正在冷却，稍后再测" };
  }

  return { ok: false, message: line.trim() };
}
