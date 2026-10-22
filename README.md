# Session Stats for Claude++

在 Claude Desktop 的本地 Code 和 Remote Control 会话输入框下方显示：

```text
24 turns · 412 steps · ≈ 42 tok/s    176.7M tok · Cache hit 99%
```

不显示上下文占用。统计条居中显示在输入框下方，独立于输入框的正常布局，不增加其高度。

## 安装和卸载

需要 Windows 和已安装的 Claude++ 0.3.6 或更新版本。
在 Claude++ 的 Tweak Store 中搜索 **Session Stats** 并安装。Store 固定到审核过的完整提交 SHA。

源码：[kpkhxlgy0/claude-session-stats](https://github.com/kpkhxlgy0/claude-session-stats)。
版本：[v0.2.0](https://github.com/kpkhxlgy0/claude-session-stats/releases/tag/v0.2.0)。

也可以使用 PowerShell 7 运行仓库根目录的脚本：

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
Claude++ 已运行时，源码和构建产物更新会自动热加载，无需重启。脚本不会自动退出或重启 Claude。

`index.js` 已包含可直接加载的 renderer 代码，安装无需下载开发依赖。

## 统计口径

| 字段 | 含义 |
| --- | --- |
| Turns | 当前主会话的用户输入轮次，按 promptId 去重，旧记录退回 uuid；不计工具返回、系统注入和子代理分支 |
| Steps | 当前主会话的模型响应次数，按 message.id / requestId 去重；同一响应的重复记录和累计快照不会重复累加 |
| Token | 累计普通输入 + 缓存写入 + 缓存读取 + 输出 |
| Cache hit | 累计缓存读取 ÷ 累计总输入；缺字段或分母为零时显示 `—` |
| TPS | 最近响应的输出 tokens ÷ 从上一条用户消息或工具返回到该响应的日志时间差；以 `≈` 标记估算值 |

Token 采用日志或 Remote Control 原始同步事件提供的用量，不按可见文本长度估算。
模型代理或转发服务若缺失 usage 字段，相应指标显示 `—`。
累计 Token 是各次模型请求的总用量，重复读取的缓存也会累计，因此可能远大于单次上下文窗口。

TPS 使用现有日志或原始同步时间戳，无需 OpenTelemetry、代理或额外采集服务。分子采用同一响应去重后的累计输出用量，
分母包含请求等待、思考和网络耗时；工具返回后重新计时，因此不把返回之前的工具执行间隔算给下一次响应。
多条内容块取同一响应的最晚日志时间。缺少起止时间或输出用量、时间倒序或不足 100ms 时显示 `—`；
新用户消息或工具结果到来时先清空旧速度。该值是响应平均速度估算，不代表服务端纯生成速度。

## 数据和会话范围

- 本地 Code 匹配 `app://localhost/epitaxy/local_<uuid>` 和 `https://claude.ai/epitaxy/local_<uuid>`。
- 主进程使用 Claude 的 userData 目录，读取 `claude-code-sessions/<账户>/<组织>/<local_id>.json` 中的精确映射；兼容没有组织层的布局。
- 检查记录的 sessionId 与请求一致，cliSessionId 有效，且不存在其他账户中的同名记录。缺失或歧义时显示 `—`。
- 增量读取 `$env:CLAUDE_CONFIG_DIR\projects\<项目>\<cliSessionId>.jsonl`；环境变量未设置时使用用户目录下的 `.claude`。
- 日志索引最长缓存 15 秒，新日志可能需要等待下一次索引刷新。文件追加、截断、替换会重新计算或增量更新。
- 会话日志、认证信息和 Claude 设置均不写入；IPC 只返回数值统计与关联标识，不传输会话正文。
- 普通 Chat、Cowork、云端 Code、SSH 和子代理独立统计不在本版本范围内。

### Remote Control

- 支持 `/epitaxy/session_<id>`，兼容网页形式 `/code/session_<id>`；会话详情必须明确标记为 `bridge`。
- 仅在当前调用方的主页面读取账户 Context 的组织 ID，随后使用页面已有登录态对
  `/v1/code/sessions/{id}` 和 `/events` 发起只读 GET。不读取 Cookie 或认证令牌，不改 Claude++ 核心。
- 按升序分页读取原始事件，之后从服务端游标增量刷新，默认间隔 5 秒。后台读取每批最多 15 秒，
  底栏请求等待最多 750ms 后先返回已确认的状态；历史尚未读全时显示 `—`，不把部分历史当成完整累计值。
- 使用原始 `message.usage` 和 `timestamp`；不采用页面归一化时补入的零值和当前时间。
  流事件与最终响应按消息 ID 去重，result 的会话汇总不重复计入。
- 统计范围是当前 Remote Control 已同步的主会话历史。远端 `/resume` 之前未同步的内容无法补齐，不能视为远端所有日志的总量。
- 会话/组织切换会丢弃旧读取；身份不明确、认证失败或接口变化时不显示远程统计条。
  停用时移除 IPC、页面读取状态和监听，并取消未完成的请求；只向底栏返回数值和会话标识。
- 单页响应限制 8 MiB、累计事件上限 200,000；超过范围时停止显示，避免阻塞页面或显示不完整总量。

## 界面兼容与验证范围

渲染器按当前页面唯一可见的编辑器及相邻操作按钮识别输入框。本地统计不依赖 React 私有数据；
Remote Control 的组织绑定读取 React Context，Claude 前端更新可能需要同步适配。
统计条居中显示在输入框下方的权限与模型操作栏空白处；没有可用操作栏或中央空间不足时，居中放在其下方。
随滚动、窗口尺寸和页面变化重新定位，切换会话后拒绝旧请求的返回结果。
若发现多个可见编辑器、未知页面或隐藏输入框，则不挂载统计条。停用时移除 DOM、监听和定时器。

已用本机 Claude Desktop 3.1623.0.0 的三个真实会话验证文件映射和完整用量解析。
自动化界面测试使用模拟 DOM；真实 Claude 界面的输入框识别、底部留白和最终显示位置仍需安装后验收。
Remote Control 路由、请求头、详情类型和事件分页协议已对照本机缓存的官方前端代码；
已通过真实 Remote Control 运行日志确认组织绑定、认证读取、完整历史加载、完整 usage、可用估算 TPS 和后续增量更新。
自动化测试共 122 项；统计条挂载已获运行状态确认，最终数值仍可与远端日志人工对照。

## 开发

```powershell
npm ci
npm run build
npm test
npm run validate
```

修改 `src/renderer.cjs` 后运行 build 更新 `index.js`。Claude++ 的 renderer 环境没有 Node require，发布入口因此内嵌 renderer；main 仍加载 `src/main.cjs`。
`src/session-map.cjs` 负责 Desktop 到日志的映射，`src/session-store.cjs` 负责只读增量加载，`src/metrics.cjs` 负责统计。
`src/remote-reader.cjs` 在当前页面读取远控历史并复用统计器，`src/remote-bridge.cjs` 负责主 frame 校验与 IPC 清理。

本项目沿用 [Codex++ Session Stats](https://github.com/kpkhxlgy0/session-stats) 的五项显示、增量读取和安装脚本设计，
保留其 MIT 许可；Claude 的数据口径、会话映射及 renderer 打包单独适配。
