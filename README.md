# Session Stats for Claude++

在 Claude Desktop 的本地 Code 会话输入框下方显示：

```text
24 turns · 412 steps · ≈ 42 tok/s    176.7M tok · Cache hit 99%
```

不显示上下文占用。统计条居中显示在输入框下方，独立于输入框的正常布局，不增加其高度。

## 安装和卸载

需要 Windows 和已安装的 Claude++ 0.3.6 或更新版本。
在 Claude++ 的 Tweak Store 中搜索 **Session Stats** 并安装。Store 固定到审核过的完整提交 SHA。

源码：[kpkhxlgy0/claude-session-stats](https://github.com/kpkhxlgy0/claude-session-stats)。
版本：[v0.1.0](https://github.com/kpkhxlgy0/claude-session-stats/releases/tag/v0.1.0)。

也可以使用 PowerShell 7 运行仓库根目录的脚本，然后重新启动 Claude：

```powershell
pwsh -NoProfile -File .\Inject-ClaudePlusPlus.ps1
```

只检查当前状态、不修改文件和配置：

```powershell
pwsh -NoProfile -File .\Inject-ClaudePlusPlus.ps1 -CheckOnly
pwsh -NoProfile -File .\Uninject-ClaudePlusPlus.ps1 -CheckOnly
```

卸载：

```powershell
pwsh -NoProfile -File .\Uninject-ClaudePlusPlus.ps1
```

Inject 在 `%APPDATA%\claude-plusplus\tweaks\com.kpk.session-stats` 建立指向本目录的 junction 并启用此 tweak。
Uninject 禁用此 tweak，只移除指向本目录的 junction，保留源码；已经存在的 Store 实体安装只启用或禁用，不覆盖或删除。
指向其他源码的链接及无关目录会阻止操作。其他 tweak 设置和 safeMode 保持原值；safeMode 开启时，本 tweak 不会加载。
脚本不会自动退出或重启 Claude。

`index.js` 已包含可直接加载的 renderer 代码，安装无需下载开发依赖。

## 统计口径

| 字段 | 含义 |
| --- | --- |
| Turns | 当前主会话的用户输入轮次，按 promptId 去重，旧记录退回 uuid；不计工具返回、系统注入和子代理分支 |
| Steps | 当前主会话的模型响应次数，按 message.id / requestId 去重；同一响应的重复记录和累计快照不会重复累加 |
| Token | 累计普通输入 + 缓存写入 + 缓存读取 + 输出 |
| Cache hit | 累计缓存读取 ÷ 累计总输入；缺字段或分母为零时显示 `—` |
| TPS | 最近响应的输出 tokens ÷ 从上一条用户消息或工具返回到该响应的日志时间差；以 `≈` 标记估算值 |

Token 采用日志提供的用量，不按可见文本长度估算。模型代理或转发服务若缺失 usage 字段，相应指标显示 `—`。
累计 Token 是各次模型请求的总用量，重复读取的缓存也会累计，因此可能远大于单次上下文窗口。

TPS 仅使用现有日志，无需 OpenTelemetry、代理或额外采集服务。分子采用同一响应去重后的累计输出用量，
分母包含请求等待、思考和网络耗时；工具返回后重新计时，因此不把返回之前的工具执行间隔算给下一次响应。
多条内容块取同一响应的最晚日志时间。缺少起止时间或输出用量、时间倒序或不足 100ms 时显示 `—`；
新用户消息或工具结果到来时先清空旧速度。该值是响应平均速度估算，不代表服务端纯生成速度。

## 数据和会话范围

- 仅匹配 `app://localhost/epitaxy/local_<uuid>` 和 `https://claude.ai/epitaxy/local_<uuid>` 本地 Code 会话。
- 主进程使用 Claude 的 userData 目录，读取 `claude-code-sessions/<账户>/<组织>/<local_id>.json` 中的精确映射；兼容没有组织层的布局。
- 检查记录的 sessionId 与请求一致，cliSessionId 有效，且不存在其他账户中的同名记录。缺失或歧义时显示 `—`。
- 增量读取 `$env:CLAUDE_CONFIG_DIR\projects\<项目>\<cliSessionId>.jsonl`；环境变量未设置时使用用户目录下的 `.claude`。
- 日志索引最长缓存 15 秒，新日志可能需要等待下一次索引刷新。文件追加、截断、替换会重新计算或增量更新。
- 会话日志、认证信息和 Claude 设置均不写入；IPC 只返回数值统计与关联标识，不传输会话正文。
- 普通 Chat、Cowork、远程 Code 和子代理独立统计不在本版本范围内。

## 界面兼容与验证范围

渲染器按当前页面唯一可见的编辑器及相邻操作按钮识别输入框，不依赖 React 私有数据。
统计条居中显示在输入框下方的权限与模型操作栏空白处；没有可用操作栏或中央空间不足时，居中放在其下方。
随滚动、窗口尺寸和页面变化重新定位，切换会话后拒绝旧请求的返回结果。
若发现多个可见编辑器、未知页面或隐藏输入框，则不挂载统计条。停用时移除 DOM、监听和定时器。

已用本机 Claude Desktop 3.1623.0.0 的三个真实会话验证文件映射和完整用量解析。
自动化界面测试使用模拟 DOM；真实 Claude 界面的输入框识别、底部留白和最终显示位置仍需安装后验收。

## 开发

```powershell
npm ci
npm run build
npm test
npm run validate
```

修改 `src/renderer.cjs` 后运行 build 更新 `index.js`。Claude++ 的 renderer 环境没有 Node require，发布入口因此内嵌 renderer；main 仍加载 `src/main.cjs`。
`src/session-map.cjs` 负责 Desktop 到日志的映射，`src/session-store.cjs` 负责只读增量加载，`src/metrics.cjs` 负责统计。

本项目沿用 [Codex++ Session Stats](https://github.com/kpkhxlgy0/session-stats) 的五项显示、增量读取和安装脚本设计，
保留其 MIT 许可；Claude 的数据口径、会话映射及 renderer 打包单独适配。
