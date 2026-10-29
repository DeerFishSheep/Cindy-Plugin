# a6api-picker（Cindy 插件）

把 Pi-Desktop(Cordis) 的 `a6api-dsh-plugin` 转写成 Cindy 插件：右侧栏常驻页签里筛选
A6API 渠道、按五项评分排名、对比两家、固定/禁用渠道、看余额。核心抓取与评分算法
原样复用源项目的 `lib/core.mjs`，只把落盘目录从 `~/.dsh` 改成 Cindy 的存储契约。

## 一句话结论

**能转。** 面板、公开榜单、登录态榜单、浏览器 Cookie 同步、令牌、余额、当前固定渠道都已在
本机实测通过；唯一不能照搬的是「Host 注册 HTTP 端点」这个 DSH 专属形态，已换成 Cindy 的
`BroadcastChannel + 随包 Node worker`。**没有在 Cindy 里安装运行过**（本次任务禁止安装），
宿主沙箱内的 `curl` / `security` / `sqlite3` 子进程能力按官方文档属于完整 Node 权限，
但未在安装后的环境里二次验证——这是最大的剩余风险。

## 能力对照

| 原能力 | 现状 | 说明 |
|---|---|---|
| 拉公开渠道数据（免登录） | ✅ 保留 | worker 里 `curl` + Chrome UA，实测 191 条 / 5s |
| 五项评分、综合/性价比排序 | ✅ 保留 | `core.mjs` 算法与权重一行未改 |
| 品牌/模型/令牌筛选 | ✅ 保留 | 面板下拉 + 筛选表单 |
| 登录态接口（固定状态、令牌、余额） | ✅ 保留 | Cookie 由 Cindy 保险库保管，宿主按方法注入 worker |
| 从本机 Chrome/Edge/Brave 同步 Cookie | ✅ 实测可用 | 读 Cookies SQLite + 钥匙串解密 + Local Storage 取 userId；实测 `Chrome/Default`、用户 18506、2 个令牌 |
| 手动粘贴 Cookie + userId | ✅ 保留 | 面板/设置页直接 `PUT /secrets`，不经过对话或 BroadcastChannel |
| 固定渠道 | ✅ 保留 | 面板里选令牌后固定；**没有**给 AI 开放固定工具 |
| 禁用渠道 | ✅ 保留 | 面板里两段式确认，防误点 |
| 查看余额 | ✅ 保留 | `/api/user/self` + `/api/status`，60 秒轮询 |
| 对比两家渠道 | ✅ 重写 | 原 React 弹层 → 原生 DOM，含 8 项指标与胜负条 |
| 商家详情（五项拆解） | ✅ 重写 | 原生 DOM 弹层 |
| 账号密码登录 `/login/password` | ⚠️ 降级 | 源项目有端点但面板没暴露；本插件只保留浏览器同步 + 粘贴 Cookie，未提供密码登录 UI |
| DSH 的 `/api/dsh-a6api/*` HTTP 端点 | ❌ 不可用 | Cindy 插件没有「注册本地 HTTP 路由」能力，改为 JSON-RPC worker |
| 输入框旁悬浮按钮 | ❌ 形态不同 | Cindy 侧栏页签（`panel.position: "right"`），宿主负责标题/关闭/最大化 |
| 数据写 `~/.dsh/*.json` | ❌ 改为宿主契约 | 见下表 |

## 架构

```
panel.html / panel.js ──┐
settings.html/js ───────┴─ BroadcastChannel('a6api-picker') ─→ main.js（电子脑）
                                                                  │ cindy.node.request
                                                                  ▼
                                                        node/worker.cjs（完整 Node 权限）
                                                                  │ child_process: curl
                                                                  ▼
                                                            a6api.com
```

- 面板和设置页都在 Cindy 沙箱里，不能直连网络；所有请求经 `main.js` 转给随包 worker。
- 面板打开时先 `fetch('cindy-ghost://a6api-picker/wake')` 叫醒电子脑，再按 `reqId` 每 700ms 重发，
  直到收到 `rpc-reply`。电子脑按 `reqId` 去重并回放 120 秒内的结果。
- Cookie 不经过面板广播：面板/设置页直接 `PUT /secrets/a6api_cookie`；worker 收到的
  `request.cindy.secrets.a6api_cookie` 由宿主动态注入。浏览器同步是唯一例外：worker 读到的
  Cookie 经 `main.js` 直接写入保险库，不回面板。

## 数据落盘（不写 `~/.dsh`）

| 数据 | 位置 | 说明 |
|---|---|---|
| Cookie | Cindy 保险库（`node.secretBindings.a6api_cookie`） | 只写；`/secrets` 回查最多看到尾 4 位 |
| userId、令牌选择、筛选条件 | 插件 `/kv` | 非敏感配置 |
| 上次榜单快照 | `fs root:'data'` 的 `last.json` | 重开面板立即恢复 |
| Chrome Cookies 临时拷贝、模型列表缓存 | 系统临时目录 `cindy-a6api-picker-<uid>/` | `core.mjs` 支持 `A6API_DATA_DIR`；卸载/重启可丢 |

`core.mjs` 与源项目的差异只有 4 处（`diff` 共 35 行）：`CRED_DIR`/`CRED_FILE`、Cookies 临时文件、
模型缓存路径改读 `A6API_DATA_DIR`，以及为临时目录补一次 `mkdirSync`。抓取、评分、筛选、
登录解析等算法未改。

## 实测证据

### 1）worker 直连（公开 + 登录态）

```sh
node dev/probe-worker.mjs
```

真实输出的关键片段（Cookie 已脱敏）：

```
## 1. 无登录态拉公开数据
{ "ok": true, "total": 191, "fetched": 191, "kept": 9, "scope": "public", ... }

## 3. 用宿主注入的 Cookie 走登录态接口
{ "ok": true, "total": 187, "fetched": 187, "kept": 9, "scope": "auth", "loggedIn": true, ... }

## 4. 余额（只读）
{ "ok": true, "balance": { "cny": 34.62, "usd": 4.7418, "quota": 2370924, ... } }

## 2. 从本机浏览器同步登录态
{ "ok": true, "cookie": "<redacted 678 chars>", "userId": 18506,
  "source": "Chrome/Default", "tokenCount": 2, ... }

耗时 15.3s
```

### 2）面板渲染（用上面真实抓取的数据）

```sh
node dev/capture.mjs
# 生成 dev/sample.js（真实数据）与 dev/preview.html（由 panel.html 自动生成）
python3 -m http.server 8799 --bind 127.0.0.1
# 只走公开数据（未登录）主链路：
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
  --disable-gpu --no-sandbox --window-size=460,1000 --virtual-time-budget=6000 \
  --dump-dom "http://127.0.0.1:8799/dev/preview.html?mode=public"
```

DOM 里实际出现（公开模式）：

```
未登录 · 公开数据
综合排名 · 共 9 条 · 接口 191 / 达标 9 · 未登录
class="row-item" × 9
| 1 | 78.6 | #234 | Supplier ID 77 | …
| 2 | 77.4 | #678 | Supplier ID 77 | …
| 3 | 73.4 | #4676 | Supplier ID 996 | …
```

登录模式同样跑过：`已登录 · 用户 18506`、`余额 ¥34.60`、`综合排名 · 共 9 条 · 接口 187 / 达标 9`。
截图见 `dev/screenshots/public-none.png`（公开榜单）、`public-detail.png`（评分拆解）、
`public-compare.png`（两家对比）。这三张都是**未登录公开数据**，不含账号信息；
本地预览图只是验证渲染，不是宿主安装后的截图。

截图确认了点：登录状态/余额、筛选表单、9 条榜单、固定/禁用/详细/对比、当前固定渠道与令牌下拉；
暗色变量下同样可读（本地用 `?theme=dark` 模拟）。`dev/` 只是本地验证工具，不进 `.cindy`。

## 打包与安装

本环境没有 `ghost_forge_pack` 工具（pi worker 只提供文件/命令工具），所以 `.cindy` 由
`dev/pack.py` 按官方包结构（zip 根目录放 `ghost.json`）生成，并用 `dev/validate.mjs`
逐条核对文档里的硬约束。**这不是 Forge 校验过的包**，装之前宿主还会做一次真实校验；
如果宿主拒装，把错误码发回来即可按提示修 manifest。

```sh
node dev/validate.mjs
python3 dev/pack.py
# 产物：a6api-picker/a6api-picker-1.0.0.cindy
```

装法：Cindy → 插件页 → 导入本地 `.cindy`，或把文件拖进 Cindy 窗口；首次安装会列出权限
（Node 本机权限、私有数据目录、一个 A6API Cookie 凭证），确认后启用。启用后在任意对话的
右侧栏「+」里打开「A6API 渠道」页签。也可以 `$渠道` 点名。

## 权限与风险

- 声明 `node`：worker 是完整 Node 进程，能读写当前用户文件、起子进程（`curl` / `security` /
  `sqlite3`）、联网。这是绕开 a6api CDN TLS 指纹与读取本机浏览器登录态的必要代价。
- 声明 `fs: true`：只用于 `root:'data'` 的榜单快照。
- 声明 `node.secretBindings.a6api_cookie`：明文只在本插件的 worker 内存里出现；不会进
  `/kv`、BroadcastChannel、日志或面板。worker 用完不缓存。
- 自动同步需要 macOS 允许访问 `Chrome Safe Storage` 钥匙串项；第一次可能弹窗。拒绝、浏览器
  加密方式变化、或只登录在 Cindy 内嵌浏览器里时，自动同步会失败，改用手动粘贴 Cookie。
  自动同步路径是 macOS 专用的（Chrome/Edge/Brave 目录 + `security` + `sqlite3`）；Windows/Linux
  未实现，只能手动粘贴 Cookie。
- 禁用渠道在站点侧不可撤销；面板用两段式确认，但仍建议只对确认不用的渠道操作。
- 固定/禁用依赖当前登录用户与令牌；切账号后需要重新同步。

## 目录

```
a6api-picker/
├── ghost.json            # v3 身份卡：panel(position:right)、node、fs、secretBindings、tool
├── main.js               # 电子脑：BroadcastChannel ↔ worker、保险库、/kv、fs data
├── bridge.js             # 面板/设置页共用的小桥（wake + reqId 重发）
├── panel.html/css/js     # 右侧栏面板（原生 DOM）
├── settings.html/css/js  # 登录态管理（同步/粘贴/清除）
├── node/worker.cjs       # JSON-RPC stdio worker
├── node/core.mjs         # 源项目 core.mjs（仅落盘路径改动）
├── assets/icon.png
├── dev/                  # 本地实测/预览/静态校验/打包，不进 .cindy
└── README.md
```

## 与源项目的关系

- 源项目：`/Users/lyy/Documents/deepseek-harness/default-workspace/a6api-dsh-plugin`（只读）。
- 算法与业务事实（CDN 掐 TLS 指纹、必须 Chrome UA、公开接口无固定状态、`new-api-user` 头、
  1 亿成本口径、五项权重）全部沿用源 README 与 `core.mjs`。
- 本仓库只做了宿主形态转写，没有修改源项目任何文件。
