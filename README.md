# Cindy-Plugin

Cindy 插件源码合集。每个子目录是一个插件，直接装 `.cindy` 包。

## 插件

| 目录 | 插件 | 能做什么 |
|---|---|---|
| [`a6api-picker/`](a6api-picker/) | 免费渠道筛选（A6API 渠道） | 拉 A6API 渠道榜，按稳定性 / 成功率 / 延迟 / 缓存 / 价格评分，收藏与固定渠道 |
| [`free-search/`](free-search/) | 免费联网搜索 | 27 引擎自动回退、站内搜索、视频搜索、天气 |
| [`i-have-adhd/`](i-have-adhd/) | ADHD 输出 | 每轮会话默认输出 ADHD 友好的结构：先给下一步动作、编号清单、结尾给一个两分钟内能做完的动作 |
| [`partner-sync/`](partner-sync/) | 伙伴同步 | 右侧栏列出所有伙伴，预览并复制 Soul 或逐条记忆到另一个伙伴；覆盖前自动备份，记忆按正文去重 |

各插件的能力细节、配置项和装法见各自目录下的 `README.md`。

## 装法

Cindy → 插件页 → 导入对应插件目录里的 `.cindy` 文件（或把文件拖进窗口），
确认首次安装的权限后启用。

`.cindy` 包不进仓库（见 `.gitignore`），要在本地重新打一份的话，用
Cindy 自带的插件打包流程，或见各插件目录里的说明。

## 目录约定

```
<plugin>/
├── ghost.json      # 插件清单：id / 版本 / 入口 / 工具 schema / 权限
├── main.js         # 电子脑：Agent 工具调用 ↔ 随包 worker
├── settings.html   # 设置页（可选）
├── settings.js
├── node/           # 随包 Node 进程与实质逻辑
├── assets/         # 图标等静态资源
└── dev/            # 本机实测脚本，部分产物含账号信息，不入库
```
