# a6api-picker（Cindy 插件）

把 Pi-Desktop 的 `pi-a6api` 0.3.10（`/Users/lyy/Documents/deepseek-harness/default-workspace/pi-plugin/pi-a6api`，
本次唯一权威源）移植成 Cindy 插件。面板界面、抓取/评分算法、收藏模型、登录通道全部
对齐上游；只把「PI 宿主专有」的几处换成 Cindy 契约。

## 一句话结论

上游能做的，这个插件都能做：公开榜、登录态榜、两条榜（综合 / 性价比）、全部筛选条件、
`¥/亿` 成本、收藏（含快照 / 未在榜 / 刷新）、固定、禁用、两家对比、复制榜单、余额、
品牌与模型列表、三路登录。**没有在 Cindy 里安装运行过**（本次任务禁止安装，`.cindy`
由用户自己打），宿主侧 `curl` / `sqlite3` / `security` 子进程与保险库注入只在本机
Node 里按同一协议模拟验证过。

## 功能对照（逐条对上游）

| 上游能力（pi-a6api 0.3.10） | 状态 | 说明 |
|---|---|---|
| `search` 拉 6 页 × 100 条、并发翻页 | ✅ 已实现 | `node/core.mjs` 原样，worker `search/run` |
| 筛选：缓存命中 / 成功率 / 倍率 / TTFT / TPS / 样本数 / 仅保真 | ✅ 已实现 | 面板表单与工具参数都齐；`guaranteedOnly` 走保真池 |
| 两个榜：综合分 + 性价比 | ✅ 已实现 | `ranking` 与 `valueRanking`（`byValue` 乘法模型）都在返回里 |
| 算钱 `¥x.xx/亿`，按各渠道 24h 缓存命中率拆分 | ✅ 已实现 | `costCnyPer100MInput` / `workloadCost` 未改 |
| 固定渠道（需登录态） | ✅ 已实现 | `pin/set`，面板行内「固定」+ 已固定 chip |
| 禁用渠道（两段式确认） | ✅ 已实现 | `disable/channel` |
| 对比两家渠道（8 项指标、胜负条） | ✅ 已实现 | 面板「对比」弹窗，固定那家默认在左 |
| 复制榜单 | ✅ 已实现 | 失败时退回 `execCommand`（沙箱 iframe 的 clipboard 可能被拒） |
| 收藏：行尾 ☆/★、收藏页签、按模型名+渠道 ID 存、快照、未在榜标红、刷新覆盖、切模型重拉 | ✅ 已实现 | `fav/list`、`fav/set`、`fav/refresh`，落 `favorites.json` |
| 登录：浏览器同步 / 粘贴 Cookie / 账号密码 | ✅ 已实现 | `login/browser`、`login/cookie`、`login/password`；三路都在面板登录弹窗与设置页 |
| 余额、品牌列表、模型列表 | ✅ 已实现 | `balance/get`、`brands/list`、`models/list` |
| 面板顶栏状态（圆点/余额/登录）、错误提示、loading | ✅ 已实现 | 与上游标记一致；圆点用 `status/get` 补了一次可达性探测 |
| `a6api.reveal`（悬浮球唤出侧栏） | ⚠️ 形态不同 | Cindy 没有桌面悬浮球，面板由宿主页签承载，插件没有「唤起自己面板」的 API；命令 `$渠道` 即入口 |
| `widget.html` 桌面悬浮球 | ❌ 不移植 | PI 专有形态。Cindy 用 `panel.position: "right"` 的右侧栏页签 + `$渠道` 命令 |
| 数据写 `~/.pi-desktop/...`、`~/.dsh/...` | ❌ 改为宿主契约 | 见「数据落盘」 |

## API 对照（上游 `a6api.*` → 本插件 RPC → 实现位置）

| 上游通道 | 本插件 RPC | 谁实现 |
|---|---|---|
| `a6api.search` | `search/run` | worker（core.collect + slim + valueRanking），main 写 `last.json` |
| `a6api.balance` | `balance/get` | worker |
| `a6api.brands` | `brands/list` | worker |
| `a6api.models` | `models/list` | worker |
| `a6api.last` | `last/get` | main（`fs root:'data'` 的 `last.json`，带算法版本校验） |
| `a6api.session` | `session/get` | main（`/kv`；带 `tokenId` 时写回） |
| `a6api.login` | `login/browser` | worker `session/import` + main 保险库/`/kv`；失败开登录页并每 2 秒重试，最多 5 分钟 |
| `a6api.login.cookie` | `login/cookie` | worker 验证（注入的 Cookie）+ main 写 `userId` |
| `a6api.login.password` | `login/password` | worker `core.loginWithPassword` + main 存 Cookie 到保险库 |
| `a6api.logout` | `logout` | main（清保险库 + `/kv`） |
| `a6api.tokens` | `tokens/list` | worker + main 选默认令牌 |
| `a6api.pin.current` | `pin/current` | worker |
| `a6api.pin` | `pin/set` | worker |
| `a6api.disable` | `disable/channel` | worker |
| `a6api.status` | `status/get` | worker 探测可达性 + main 合并登录态 |
| `a6api.reveal` | — | 不适用：Cindy 无悬浮球，面板唤起由宿主/`$渠道` 负责 |
| `a6api.fav.list` | `fav/list` | main（`favorites.json`） |
| `a6api.fav.set` | `fav/set` | main |
| `a6api.fav.refresh` | `fav/refresh` | main |

> 收藏为什么不在 worker：Cindy 里只有 main.js（浏览器沙箱）能写 `fs root:'data'`，
> worker 拿不到任何宿主磁盘路径。把它留在 main 是唯一能持久化的位置；算法与上游
> `main.js` 的 `favList/favSet/favRefresh` 逐行对应。

## 数据落盘（不写 `~/.dsh` / `~/.pi-desktop`）

| 数据 | 位置 | 说明 |
|---|---|---|
| Cookie | Cindy 保险库（`node.secretBindings.a6api_cookie`） | 只写；`/secrets` 回查最多看到尾 4 位。按方法临时注入 worker |
| userId / tokenId / 筛选条件 | 插件 `/kv` | 非敏感配置，重开面板/重装不丢 |
| 上次榜单 `last.json`、收藏 `favorites.json` | `fs root:'data'` | 插件私有数据目录；卸载时宿主回收 |
| Chrome Cookies 临时拷贝、cookie jar、模型列表缓存 | 系统临时目录 `a6api-picker-cindy-<uid>/` | `core.mjs` 只改了这一处落盘路径（走 `A6API_DATA_DIR` / `setDataDir()`） |

`core.mjs` 与上游唯一差异：`DATA_DIR` 默认从 `~/.dsh` 改成 `A6API_DATA_DIR` 或系统临时
目录。抓取、评分、筛选、`byValue`、登录解析逐行未改。

## 架构

```
panel.html/panel.js ─┐
settings.html/js ────┴─ BroadcastChannel('a6api-picker') ─→ main.js（电子脑）
                                                              │ cindy.node.request
                                                              ▼
                                                     node/worker.cjs（完整 Node 权限）
                                                              │ child_process: curl
                                                              ▼
                                                        a6api.vip
```

- 面板打开时先 `fetch('cindy-ghost://a6api-picker/wake')` 叫醒电子脑，再按 `reqId` 每 700ms
  重发，直到收到 `rpc-reply`；main 按 `reqId` 去重并回放 120 秒内的结果。
- Cookie 明文不进 BroadcastChannel：面板/设置页直接 `PUT /secrets`，worker 用
  `request.cindy.secrets.a6api_cookie`；浏览器同步是唯一例外（worker → main → 保险库）。
- 账号密码只经 BroadcastChannel → main → worker 这一次，不落盘、不进 `/kv`、不写日志。

## 本地复现

```sh
cd a6api-picker
node dev/validate.mjs        # manifest / 页面 / 红线的静态自检
node dev/probe-main.mjs      # 真 main.js + 真 worker + 真 curl，跑全部只读接口与收藏闭环
node dev/capture.mjs         # 抓真实数据生成 dev/preview.html（gitignore）
# 面板渲染（headless Chrome）
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
  --virtual-time-budget=6000 --dump-dom "file://$PWD/dev/preview.html?tab=fav"
python3 dev/pack.py          # 生成 .cindy（不打也行，用户自己打）
```

`dev/probe-main.mjs` 用假宿主把 main.js 跑在 Node 里：`/kv`、`/secrets`、`fs root:'data'`
和按 `secretBindings` 注入 Cookie 都在内存/临时目录里模拟，网络与解析走真实 worker，
所以主流程是真实数据。输出见 `dev/probe-main.mjs` 的运行结果。

## 未实跑项（如实说明）

| 项 | 原因 |
|---|---|
| `pin/set` 固定渠道 | 会改账号真实路由（写操作），本次只验证只读的 `pin/current` |
| `disable/channel` 禁用渠道 | 上游标注「不可撤销」，不拿真实账号试 |
| `login/password` 账号密码登录 | 需要真实密码；代码路径与 `login/cookie` 共用 `identify()` + 保险库写入 |
| 浏览器登录自动重试（打开登录页那一路） | 本机浏览器已有登录态，同步分支直接成功；开页/轮询分支未触发 |
| 宿主内实际安装运行 | 任务明确禁止安装；`.cindy` 由用户打 |

## 风险

1. **未在 Cindy 宿主内跑过**：`cindy.node.request`、`/secrets` 注入、`fs root:'data'` 的
   行为按官方文档与旧版插件实现，dev 脚本用同签名模拟；真实宿主若有细节差异（例如
   fs 响应结构），最先受影响的是收藏/快照。
2. **worker 需要本机 `curl` / `sqlite3` / `security`**：这是上游 design（Node fetch 会被
   CDN 按 TLS 指纹掐断），Cindy 的 Node 工作进程是完整本机权限，按文档可用。
3. **账号密码登录**把密码交给本地 worker 一次；只发往 a6api.vip 的 `/api/user/login`，
   不落盘，但仍属于「凭据经过插件代码」。
4. **`login/cookie` 的用户 ID**：站点现在要求 `new-api-user` 头，纯 Cookie 调
   `/api/user/self` 会 401。worker 改成先解 session cookie 里的 ID，再用拉令牌列表验证；
   上游 `fetchUserId` 那条老路只在解不出 ID 时兜底。

## 筛选条件持久化（1.1.1）

筛选条件（模型、品牌、倍率上限、缓存/成功率下限、首字、吞吐、样本数、仅保真、只输出达标）存在
**插件数据目录** `ghost-fs data/filters.json`，和 `last.json`（榜单快照）、`favorites.json`（收藏）同一处：

- 改完输入框/勾选框 400ms 防抖后自动 `filters/save`，不必等点「开始筛选」
- 打开面板时 `filters/get` 回填；回填期间不触发自动保存，避免写回半截状态
- 「显示上次结果」不再用 `last.params.model` 覆盖已保存的筛选条件

早期版本存在插件 `/kv`，实测未落库（kv 里只有 userId/tokenId），1.1.1 起改走 ghost-fs。
