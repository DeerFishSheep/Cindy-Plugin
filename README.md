# Cindy 插件：A6API 渠道筛选

把 Pi-Desktop(Cordis) 的 `a6api-dsh-plugin` 转写成 Cindy 插件。源码在
[`a6api-picker/`](a6api-picker/)，打好的包是
[`a6api-picker/a6api-picker-1.0.0.cindy`](a6api-picker/a6api-picker-1.0.0.cindy)。

## 能转 / 打折

**能转。** 公开榜单、登录态榜单、浏览器 Cookie 同步、令牌、余额、当前固定渠道都实测通过；
DSH 的本地 HTTP 端点换成 Cindy 的 `BroadcastChannel + 随包 Node worker`。没有给 AI 开放
固定/禁用工具，避免模型擅自改账号；这两件事留给右侧栏面板里的用户操作。

**未在 Cindy 里安装运行**（任务明确禁止安装），宿主沙箱内的 `curl` / `security` / `sqlite3`
子进程能力按官方文档属于完整 Node 权限，但没有安装后二次验证。详见插件 README 的
「能力对照」「剩余风险」。

## 装法

Cindy → 插件页 → 导入本地 `.cindy`（或把文件拖进 Cindy 窗口），首次安装确认权限后启用。
之后在任意对话的右侧栏「+」里打开「A6API 渠道」页签，或输入 `$渠道`。

权限清单：Node 本机权限（起 `curl`、读浏览器登录态）、插件私有数据目录（榜单快照）、
一条 A6API Cookie 凭证（宿主保险库，按方法临时注入 worker）。

## 本地复现

```sh
cd a6api-picker
node dev/validate.mjs          # 文档硬约束静态自检
node dev/probe-worker.mjs      # 公开数据 + 浏览器登录同步 + 登录态 + 余额（只读）
node dev/capture.mjs           # 抓真实数据并生成 dev/preview.html
python3 dev/pack.py            # 生成 .cindy
```

面板预览、真实输出片段与差异说明都在 [`a6api-picker/README.md`](a6api-picker/README.md)。
