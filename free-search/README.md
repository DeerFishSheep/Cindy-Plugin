# free-search（Cindy 插件）

免费联网搜索。给 Agent 一套能自己回退的搜索栈：某个引擎挂了自动换下一个，
不需要用户配 key 也能搜。

搜索实质逻辑在 `node/extensions/free-search/engine.mjs`，是上游
[DDDMUC/dsh-free-search](https://github.com/DDDMUC/dsh-free-search) 的代码。
`main.js` 只是 Cindy 侧很薄的一层：读设置页的链路配置、把工具调用递给随包
Node worker、把正文交回聊天。

## 工具

| 工具 | 作用 |
|---|---|
| `web_search` | 联网搜索，多引擎回退链，只返回链接与摘要 |
| `web_fetch` | 读一个 https 页面的可读正文（剥脚本与标签） |
| `platform_search` | 单平台站内搜索，无需 key |
| `video_search` | 视频搜索（Bing / DDG） |
| `weather` | 实时天气与逐日预报（Open-Meteo） |
| `free_search_test` | 逐个实测引擎可用性，返回状态与耗时 |

`platform_search` 支持的平台：github、v2ex、bilibili、reddit、hn、
stackoverflow、wikipedia、npm、juejin、douban、qiita。

## 引擎

共 27 个。回退链默认：

```
exa → tavily → keenable → firecrawl → parallel → perplexity → serpbase →
serply → deepseek-tools → deepseek-official → you → baidu → kimi → aliyun →
doubao → tinyfish → jina → bing → anysearch → ddg → ddg-lite →
searxng → zhihu_global → zhihu_site
```

免 key 就能跑的：`ddg`、`ddg-lite`、`bing`、`searxng`、`anysearch`。

链路顺序、结果条数、Bing 市场都在设置页里改；改完不用重装。

## 配置

key 不走宿主凭证库，由 worker 存在插件自己的数据目录（权限 `0600`）。
原因：宿主的 `/secrets` 是只写的，能告诉你配没配、尾号是什么，读不回原值；
27 个引擎挤进一个凭证位就没法逐个开关。设置页经 BroadcastChannel 让 worker
逐条读写，所以每个引擎能单独设置、单独清除、单独显示尾号。

## 装法

Cindy → 插件页 → 导入 `free-search-1.0.0.cindy`（或把文件拖进窗口），
确认权限后启用。之后输入 `$搜索`，或直接在对话里说要联网搜。
