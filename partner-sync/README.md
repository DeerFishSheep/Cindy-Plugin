# partner-sync（伙伴同步）

把 A 伙伴的 Soul 或某几条记忆复制到 B 伙伴。右侧栏面板操作。

## 为什么不是官方 API

Cindy 0.1.126 的 `cindy.companions.*` 只有查看和回答，没有 Soul / 记忆读写；
手册写明「不能改伙伴设置」。但 Node 工作进程有完整本机文件权限，伙伴数据就是
本地文件，所以这个插件直接读写文件。

```
~/Library/Application Support/Cindy/owners/<owner>/bots/<botId>/
├── SOUL.md                      人设
└── memories/
    ├── MEMORY.md                索引
    ├── <type>_<slug>.md         单条记忆
    └── fts.db                   搜索索引
```

宿主每次初始化记忆库时会自动重建 `MEMORY.md` 和 `fts.db`（`MemoryStore.init()`），
所以插件只负责写记忆文件，索引由宿主兜底；插件也会同步更新 `MEMORY.md` 让它在
本次会话里立即可见。

## 功能

- **伙伴列表**：扫 `bots/*`，名字取自主库 `bot_profiles.display_name`
- **Soul**：预览源 Soul，整份覆盖目标；覆盖前自动备份为 `SOUL.md.bak-<时间戳>`
- **记忆**：逐条勾选，追加到目标；正文完全相同的自动跳过
- **备份**：面板里可查看并恢复目标伙伴的历史 Soul

源伙伴永远不动。

## 文件

```
partner-sync/
├── ghost.json       清单（右侧栏面板 + 一个查询工具）
├── main.js          面板 ↔ worker 的桥；工具 partner_sync_list
├── ui2.html / ui2.js  右侧栏面板界面
├── node/worker.cjs  伙伴读写（真 Node，完整 fs）
└── assets/icon.png
```

## 已验证

- `partners/list` 返回 Cindy / Robby / Sami 三个伙伴，名字、Soul 字节数、记忆条数与磁盘一致
- 记忆同步：写入成功、`MEMORY.md` 追加到对应 type 分组、重复同步 skipped
- Soul 同步：覆盖前生成备份，恢复后 md5 与原文一致
- 宿主沙箱内 `partner_sync_list` 工具调用成功

## 注意

- 直接改文件依赖 Cindy 的本地存储布局；Cindy 大版本升级后若路径变了，`worker.cjs`
  顶部的 `APP_DIR` 需要跟着改。
- 正在运行的伙伴不会热加载新 Soul，下一次任务/会话才生效。
