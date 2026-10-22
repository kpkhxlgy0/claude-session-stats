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
