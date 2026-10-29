# Cindy 插件：A6API 渠道筛选

按 `pi-plugin/pi-a6api` **0.3.10**（10/27，唯一权威源）把 A6API 渠道筛选移植成 Cindy
插件。源码在 [`a6api-picker/`](a6api-picker/)，`.cindy` 由用户自己打。

逐项对齐上游 README 与 `views/index.html`。

## 状态

- **代码与本地实测**：公开榜（综合 + 性价比）、品牌/模型/余额/令牌/固定态/可达性等只读
  接口、收藏闭环（收 → 读回快照 → 刷新覆盖 → 未在榜 down → 取消）、Agent 工具、
  面板 DOM（星标 / 收藏页签 / 收藏列表 / 未在榜 / 双榜切换）全部跑真实数据通过。
- **未在 Cindy 里安装运行**：任务明确禁止安装；`.cindy` 留给用户打。宿主侧
  `cindy.node.request`、保险库注入、`fs root:'data'` 用同签名假宿主验证。
- 未实跑写操作：`pin/set`、`disable/channel`、`login/password`（原因见插件 README）。

## 装法

Cindy → 插件页 → 导入本地 `.cindy`（或拖进窗口），首次安装确认权限后启用。
之后在任意对话右侧栏「+」打开「A6API 渠道」页签，或输入 `$渠道`。

权限清单：Node 本机权限（起 `curl`、读浏览器登录态）、插件私有数据目录（榜单/收藏）、
一条 A6API Cookie 凭证（宿主保险库，按方法临时注入 worker）。

## 目录

```
a6api-picker/
├── ghost.json          # v3 清单：panel right / fs / command 渠道 / tool / secretBindings
├── main.js             # 电子脑：BroadcastChannel ↔ worker、保险库、/kv、fs data
├── bridge.js           # 面板/设置页共用的 BroadcastChannel 唤醒 + 重发桥
├── panel.html/css/js   # 上游 views/index.html 的忠实移植（只换桥接层）
├── settings.html/js    # 登录态管理：浏览器同步 / 粘贴 Cookie / 账号密码 / 退出
├── node/worker.cjs     # JSON-RPC stdio：search/run、login/*、pin/*、fav 之外的网络面
├── node/core.mjs       # 上游 lib/core.mjs 原样（仅落盘目录走 A6API_DATA_DIR）
└── dev/                # validate / probe-main / capture / test-bridge / pack
```

## 本地复现

```sh
cd a6api-picker
node dev/validate.mjs        # 静态自检
node dev/probe-main.mjs      # 真 main.js + 真 worker + 真网络，跑只读接口与收藏闭环
node dev/capture.mjs         # 生成 dev/preview.html（gitignore）
python3 dev/pack.py          # 可选：自己打 .cindy
```

功能对照表、API 映射、落盘表、未实跑项与风险都在
[`a6api-picker/README.md`](a6api-picker/README.md)。
