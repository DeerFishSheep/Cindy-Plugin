# i-have-adhd

把 ADHD 友好的输出规则注入 Cindy 的**每一轮会话**。规则原文来自
[ayghri/i-have-adhd](https://github.com/ayghri/i-have-adhd)（MIT），
本插件移植自 [NecromanAlbert/dsh-i-have-adhd](https://github.com/NecromanAlbert/dsh-i-have-adhd)（MIT）。

## 为什么不是"插件系统提示词段"

dsh 有 `ctx.systemPrompt.section()`，Cindy 没有。核对过 Cindy 0.1.120 的宿主实现：

| 机制 | 能否全局注入提示词 |
|---|---|
| ghost.json 字段白名单（48 个） | 无 systemPrompt 类字段 |
| 插件钩子 | 只有 `will-user-message` / `will-assistant-message`（消息级） |
| 插件花名册 `getGhostRosterPrompt()` | 宿主自拼 `id/name/command/recall`，插件无法写入，且前后带"这不是指令"护栏 |
| 捆绑 Skill | 需模型主动加载，非默认开 |
| **`~/.pi/agent/AGENTS.md`** | **宿主作为全局上下文源注入每一轮，会复制进每个会话的 configHome** ✅ |

所以本插件走最后一条：把规则作为**受管段**写进那个文件。

## 工作方式

```
插件启用
  → main.js（浏览器沙箱，无 fs）
  → node/worker.cjs（真 Node 进程，有完整 fs）
  → 往 ~/.pi/agent/AGENTS.md 追加受管段
       <!-- i-have-adhd:begin (managed by the i-have-adhd plugin) -->
       ...10 条规则...
       <!-- i-have-adhd:end -->
  → 宿主每轮读取该文件 → 所有会话生效
```

**关闭时逐字节还原**：实测 md5 与原文完全一致，不留空行或残留。

## 文件

```
i-have-adhd/
├── ghost.json       身份卡（schemaVersion 3）
├── main.js          电子脑：BroadcastChannel 桥 + 工具 + 首启自动写入
├── settings.html    设置页（浅/深色自适应，无自定义配色）
├── settings.js      开关 + 状态展示
├── assets/icon.png  256×256
└── node/
    ├── worker.cjs   JSON-RPC stdio；托管写入/抽走 AGENTS.md 受管段
    └── rules.md     规则原文（与上游 DEFAULT_PROMPT 逐字一致，1310 字节）
```

## 已验证

worker 层用真实 `AGENTS.md`（12,781 B）跑过：

- 初始 status → `enabled:false`
- enable → 14,184 B，`changed:true`
- 再 enable ×2 → `changed:false`（幂等，不叠加）
- disable → 12,781 B，**md5 与原文一致，逐字节还原**
- 文件不存在时 enable → 从零创建；disable → 文件清除
- 标记损坏（有 begin 无 end）→ 自愈，不产生重复段落，用户内容保留

语法检查：`main.js` / `settings.js` / `node/worker.cjs` 全部 `node --check` 通过。
manifest 对着宿主的 48 字段白名单校验通过，无未知字段、无必填缺失。

## 未验证（需装机后确认）

- `ghost_forge_pack` / `ghost_forge_install` 在当前环境未暴露，安装需你手动导入
  `.cindy` 或在有 forge 工具的环境打包
- 宿主 `fs-request` / `node.request` 在真实沙箱中的返回结构，代码按官方文档写的
  容错分支（`res.ok !== true` 统一走错误路径）
- 设置页 BroadcastChannel 与电子脑的实际握手时序

## 关闭方式

三种都行，效果一样（拔出受管段 + 还原原文）：

1. 插件设置页 → 关掉开关
2. 对话里说「关掉 adhd 模式」
3. 停用/卸载插件（fs data 随之回收，AGENTS.md 里的段仍在，需用前两种收尾）

## License

MIT。上游技能 MIT，Ayoub Ghriss。
