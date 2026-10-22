# Claude++ Session Stats

用户已批准沿用 Codex++ Session Stats 的方案并直接实现。

## 验收条件

- 输入框下方显示 turns、steps、TPS、累计 Token、Cache hit；不显示上下文。
- 统计条不增加输入框容器高度，不把输入框向上推。
- 按当前会话精确绑定日志，切换会话后不显示旧统计；未知或歧义绑定不猜测。
- 日志只读，消息按响应 ID 去重，忽略工具返回和注入消息的轮次。
- 用户后续批准最小改动的日志估算方案：TPS 显示 `≈ N tok/s`，时间戳或输出用量不足时显示 `—`。
- 配齐 Inject/Uninject，CheckOnly 不改配置；只移除本源码对应的 junction。

## 已批准的宿主差异

- Claude 输入总量 = 普通输入 + 缓存创建 + 缓存读取；不能复用 Codex 输入公式。
- Claude 日志位于 CLAUDE_CONFIG_DIR（默认用户目录 .claude）下的 projects。
- 用户后续批准用最近响应的输出 tokens 除以上一条用户消息或工具返回至该响应的日志时间差；
  包含请求等待和网络耗时，以 `≈` 明示估算；不采用 OpenTelemetry，不新增采集服务或改写 Claude 配置。
- Claude 的渲染器无 require，需要打包渲染器代码；保留 main/renderer 生命周期划分。
- 若已有会话接口不足，可补最小只读桥接以精确绑定 Desktop ID 与日志 UUID。
- 实际实现使用 Claude 已持久化的账户/组织会话元数据完成映射，无需修改核心 SDK。
- Claude 没有确认可用的 Codex composer 标记，统计条使用固定定位并跟随唯一可见输入框边界，保持不占布局的约束。

## 实施与验证

- [x] 解析器及去重、缺失数据、缓存口径测试。
- [x] 只读增量日志读取，追加、截断、替换、半行和会话隔离测试。
- [x] 宿主会话绑定与渲染生命周期，切换、延迟回复和卸载测试。
- [x] Inject/Uninject 及隔离目录内安装卸载测试。
- [x] 构建产物、manifest 校验、独立评审、本机日志只读验证。
- [ ] 安装后确认真实 Claude 界面的输入框识别和显示位置；本轮未获 UI 自动化授权，未执行界面操作。

用户后续已授权将 Codex 和 Claude 两边的 Session Stats 发布到 GitHub，并更新各自 Store。
发布需通过完整测试及 manifest / bundle 校验，并将 Store 固定到发布提交的完整 SHA；不重启用户的 Claude。

## Remote Control 扩展（2026-10-22）

用户在接收端调查之后批准“按之前的方案”实现 Claude++ Remote Control stats，尽量只改 tweak。
此前 v0.1.0 发布已完成；本次先实现和验证，用户确认远控读取成功后授权发布 v0.2.0。

- 延续 Codex++ 的主进程固定脚本桥接、调用方主 frame 校验、身份关联和 stop 清理。
- 已批准的宿主差异：Claude 通过已同步原始事件提供用量，不能沿用 Codex 的远端文件 RPC。
  使用现有页面登录态只读访问 Code sessions 详情及 events 分页，识别明确的 bridge 类型，复用现有 metrics。
- 组织标识来自当前编辑器所属的 React 账户 Context；不读取认证令牌，也不改 SDK 或运行时。
- 计入用户输入和主模型响应；同一响应的流事件/最终快照去重，跳过子代理及合成消息。
  缺失 usage 和时间戳保持未知；TPS 不使用接收时间或 result 汇总代替。
- 累计范围为同步历史；分页未完成、接口错误或身份不明时不报告完整总量。
- 保留五字段、居中固定定位、Inject/Uninject；无上下文指示，无远端安装步骤。
- 验证覆盖：分页/重连、缺字段、原始流事件去重、组织/会话切换、主 frame 限制、停止清理及本地回归。
- 静态协议证据：官方缓存 shared-m-0 的 sS/Jz/JZ、shared-19 的 nV、shared-m-4 的 ZA/KT；
  账户 Provider 的 value 包含 activeOrganization。真实登录/设备认证与远控数值尚需用户端验收。
- 本地验收：119 项测试通过，bundle/manifest/安装入口校验通过，独立评审发现的尾游标和流事件顺序问题已修复并补回归。
  Inject CheckOnly 确认安装仍指向本源码 junction；Claude++ 核心工作区保持干净，未重启应用。

### 远控底栏未显示的修复

- 真实运行诊断确认组织 Provider 在第 470 层，原先 120 层上限未能找到；调整为有环检测的 512 层有界遍历。
- 详情与历史串行读取会触发原先 2.5 秒总超时；后台批次改为 15 秒，页面桥接最多等待 750ms 后返回已确认状态，后续轮询继续复用同一读取。
- 深层 Provider、慢速历史、生成脚本的响应时限与定时器清理均已补回归；临时诊断已移除。
- 运行日志已确认远控统计条挂载在可见区域，并成功分页读取原始事件；热加载正常，无需重启 Claude。

## v0.2.0 发布验收

- 2026-10-22 23:58:03（Asia/Shanghai）实际运行记录为 `Remote Control history ready; usageComplete=true; tpsAvailable=true`。
- 清理诊断前的日志还确认历史末尾完成后继续接收增量事件；不把仅启动/挂载当成用量读取成功。
- 用户已明确授权验证通过后发布 GitHub Release，并更新 Claude++ Store 的完整提交 SHA。
- 本地 122 项测试、manifest/bundle 校验及远端 Windows/Linux CI 为发布验证；不改 Claude++ 核心版本或其他 Store 条目。
