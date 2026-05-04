# 第 8 章：衍生子智能体

## 智能的乘法效应

单个智能体（Agent）固然强大。它可以读取文件、编辑代码、运行测试、搜索网页，并对结果进行缜密推理。但在单次会话中，单个 Agent 能做的事情存在硬性天花板：上下文窗口会逐渐填满，任务分支会延展至需要不同专业能力的方向，而工具执行的串行本质也会演变为性能瓶颈。解决之道并非换用更大的模型，而是引入更多的智能体。

Claude Code 的子智能体（Sub-agent）系统允许模型主动请求支援。当父智能体遇到适合委托的任务时——例如一次不应污染主对话历史的代码库检索、一次需要对抗性思维的验证检查、一组可以并行推进的独立修改——它就会调用 `Agent` 工具。这一调用会衍生出一个子智能体：一个完全独立的 Agent，拥有属于自己的对话循环、专属的工具集、独立的权限边界以及专用的中止控制器（AbortController）。子智能体完成其任务并返回最终结果。父智能体永远看不到子智能体内部的逐步思考过程，只能看到其交付的最终输出。

这绝非一项单纯图省事的便利功能，而是支撑整个系统高阶能力的架构基石——从并行文件探索，到“协调者-工作者（Coordinator-Worker）”层级体系，再到多智能体群体团队（Swarm）。这一切均流经两个核心文件：定义模型交互界面的 `AgentTool.tsx`，以及实现生命周期管理的 `runAgent.ts`。

背后的设计挑战十分艰巨。子智能体既需要足够的上下文以胜任工作，又不能承载过多无用信息以至于白白浪费 Token。它需要足够严苛以保障安全的权限边界，同时又必须具备足够的灵活性以发挥效用。它需要完善的生命周期管理，必须清理其触及的每一项外部资源，而无需调用方刻意牢记清理细节。最关键的是，所有这些机制必须能普适于形态各异的智能体阵列——从轻量、快速、只读且运行在 Haiku 上的搜索专家，到昂贵、严谨、由 Opus 驱动且在后台执行对抗性测试的验证智能体。

本章将完整追踪从模型的“我需要帮助”到孕育出完全可运转的子智能体的全过程。我们将剖析模型所见的工具定义、构建执行环境的十五步生命周期、六种内置智能体类型及其各自的优化目标、允许用户自定义智能体的 Frontmatter 系统，以及从中沉淀出的系统设计原则。

关于术语的补充说明：在全书中，“父智能体（Parent）”是指调用 `Agent` 工具的智能体，“子智能体（Child）”是指被衍生出的智能体。父智能体通常（但并不总是）处于顶层的 REPL Agent。在协调者模式下，协调者衍生出的工作者（Worker）属于子智能体。在嵌套场景中，子智能体自身还可以进一步衍生孙智能体——整个生命周期机制完全递归适用。

工具编排层涵盖了跨越 `tools/AgentTool/`、`tasks/`、`coordinator/`、`tools/SendMessageTool/` 和 `utils/swarm/` 的大约 40 个文件。本章重点关注衍生机制——即 AgentTool 定义与 runAgent 生命周期。后续章节将进一步探讨运行时机制：进度追踪、结果检索以及多智能体协同模式。

---

## AgentTool 工具定义

`AgentTool` 以 `"Agent"` 名称注册，同时保留了遗留别名 `"Task"`，以向后兼容旧版转录记录（transcripts）、权限规则与 Hook 配置。它通过标准的 `buildTool()` 工厂函数构建，但其 Schema 的动态化程度远超系统中其他任何工具。

### 输入 Schema

输入 Schema 通过 `lazySchema()` 延迟构建——我们在第 6 章中曾见识过这种模式，它将 Zod 编译推迟到首次使用之时。它分为两个层级：基础 Schema，以及扩展了多智能体和隔离参数的完整 Schema。

基础字段始终存在：

| 字段 | 类型 | 是否必填 | 用途 |
|-------|------|----------|---------|
| `description` | `string` | 是 | 任务的简短摘要（3-5 个词） |
| `prompt` | `string` | 是 | 提供给该智能体的完整任务描述 |
| `subagent_type` | `string` | 否 | 指定使用的专业智能体类型 |
| `model` | `enum('sonnet','opus','haiku')` | 否 | 为该智能体覆盖指定模型 |
| `run_in_background` | `boolean` | 否 | 是否以异步后台方式启动 |

完整 Schema 增加了多智能体参数（当集群功能激活时）以及环境隔离控制项：

| 字段 | 类型 | 用途 |
|-------|------|---------|
| `name` | `string` | 使智能体具备可通过 `SendMessage({to: name})` 进行寻址的名称 |
| `team_name` | `string` | 衍生的团队上下文 |
| `mode` | `PermissionMode` | 为衍生的队友指定的权限模式 |
| `isolation` | `enum('worktree','remote')` | 文件系统隔离策略 |
| `cwd` | `string` | 工作目录的绝对路径覆盖 |

多智能体字段启用了在第 9 章和后续内容中涵盖的群体模式：具名智能体在并发运行的同时，能够通过 `SendMessage({to: name})` 彼此互发消息。隔离字段则保障了文件系统层面的安全：worktree 隔离会创建一个临时的 git worktree，使智能体在仓库的独立副本上开展工作，防止多个智能体同时对同一代码库操作时引发编辑冲突。

该 Schema 尤为独特之处在于它**受特性开关（Feature Flags）动态塑形**：

```typescript
// 伪代码 — 说明受特性门控约束的 Schema 模式
inputSchema = lazySchema(() => {
  let schema = baseSchema()
  if (!featureEnabled('ASSISTANT_MODE')) schema = schema.omit({ cwd: true })
  if (backgroundDisabled || forkMode)    schema = schema.omit({ run_in_background: true })
  return schema
})
```

当分叉（Fork）实验激活时，`run_in_background` 会从 Schema 中彻底消失，因为在该分支路径下所有衍生都强制为异步。当后台任务被禁用时（通过 `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`），该字段同样会被剔除。当 KAIROS 特性开关关闭时，`cwd` 会被略去。模型永远不会看到它无法使用的字段。

这是一个精妙却至关重要的架构抉择。Schema 不仅用于数据校验——它更是**呈献给模型的操作指南**。Schema 中的每个字段都会在模型阅读的工具定义中得到清晰说明。将模型不应使用的字段从 Schema 中彻底剥离，远比在 Prompt 中反复告诫“不要使用此字段”要有效得多。模型根本无法滥用它看不见的东西。

### 输出 Schema

输出是一个带有可辨识联合（Discriminated Union）的类型，对外公开两种变体：

- `{ status: 'completed', prompt, ...AgentToolResult }` —— 同步执行完成，附带智能体的最终产出
- `{ status: 'async_launched', agentId, description, prompt, outputFile }` —— 后台启动确认凭据

虽然内部还存在另外两个变体（`TeammateSpawnedOutput` 和 `RemoteLaunchedOutput`），但它们被排除在导出的 Schema 之外，以便在外部构建中进行死代码消除（Dead Code Elimination）。当对应的特性标志被禁用时，打包器会剔除这些变体及其关联的代码路径，从而缩减发行二进制包的体积。

`async_launched` 变体特别引人注目的一点在于它包含了 `outputFile` 路径——智能体执行完成后的结果将被写入该文件。这使得父智能体（或任何其他消费者）能够轮询或监听该文件以获取结果，从而提供了一条能够跨越进程重启的文件系统级通信通道。

### 动态 Prompt

`AgentTool` 的 Prompt 由 `getPrompt()` 动态生成，并具备高度的环境感知能力。它会根据可用智能体列表自适应调整（内联列出或作为附件提供，以避免破坏 Prompt 缓存）、根据分叉机制是否激活适时调整（附加“何时分叉”的操作指南）、根据会话是否处于协调者模式进行精简（协调者系统 Prompt 已经覆盖了使用说明），并参考订阅层级。非专业版（Non-pro）用户还会收到一条关于并发启动多个智能体的限制说明。

基于附件的智能体列表尤其值得关注。代码库注释提及，舰队级别“约 10.2% 的 cache_creation 缓存构建 Token”是由动态工具描述引起的。将智能体列表从工具描述迁移至附件消息，使工具描述本身得以保持静态。这样一来，挂载 MCP 服务器或加载插件就不会破坏后续每一次 API 调用的 Prompt 缓存。

对于任何使用包含动态内容工具定义的系统而言，这种模式都极其值得吸收借鉴。Anthropic API 会缓存 Prompt 前缀——包括系统 Prompt、工具定义和对话历史——并在后续共享相同前缀的请求中重用已缓存的计算结果。如果工具定义在 API 调用之间发生变动（例如新增了智能体或连接了 MCP 服务器），整个缓存都会失效。将易变内容从工具定义（属于已缓存前缀的一部分）挪到附件消息（附加在已缓存部分之后），既能保全缓存命中率，又能将完整信息如实传递给模型。

理解了工具定义后，我们现在可以追踪当模型实际调用该工具时所发生的一切。

### 特性门控

子智能体系统拥有整个代码库中最复杂的特性门控逻辑。至少有十二个特性开关和 GrowthBook 实验协同控制着哪些智能体可用、哪些参数在 Schema 中展示，以及走哪条执行代码路径：

| 特性门控 | 控制范围 |
|-------------|----------|
| `FORK_SUBAGENT` | 分叉智能体执行路径 |
| `BUILTIN_EXPLORE_PLAN_AGENTS` | Explore（探索）与 Plan（规划）智能体 |
| `VERIFICATION_AGENT` | Verification（验证）智能体 |
| `KAIROS` | `cwd` 覆盖，助手模式强制异步 |
| `TRANSCRIPT_CLASSIFIER` | 交接分类，`auto` 模式覆盖 |
| `PROACTIVE` | 前瞻式模块集成 |

每个门控要么利用 Bun 的死代码消除系统采用 `feature()`（编译期生效），要么借助 GrowthBook 的 `getFeatureValue_CACHED_MAY_BE_STALE()`（运行时 A/B 测试）。编译期门控在构建过程中直接进行字符串替换——当 `FORK_SUBAGENT` 为 `'ant'` 时，完整的分叉代码路径会被打包；当其为 `'external'` 时，该路径可能会被彻底剔除。GrowthBook 门控则支持在线实验：例如 `tengu_amber_stoat` 实验可以 A/B 测试移除 Explore 和 Plan 智能体是否会改变用户行为，而完全无需发布新的二进制版本。

### call() 决策树

在真正调用 `runAgent()` 之前，`AgentTool.tsx` 中的 `call()` 方法会引导请求穿过一棵决策树，以决定衍生*何种*智能体以及*如何*衍生：

```
1. 是否为队友衍生？（team_name 与 name 均已设定）
   是 -> spawnTeammate() -> 返回 teammate_spawned
   否 -> 继续向下

2. 解析生效的智能体类型（effective agent type）
   - 提供了 subagent_type -> 直接采用
   - 省略了 subagent_type 且 fork 已启用 -> undefined（走分叉路径）
   - 省略了 subagent_type 且 fork 已禁用 -> "general-purpose"（默认通用型）

3. 是否为分叉路径？（effectiveType === undefined）
   是 -> 递归分叉守卫检查 -> 采用 FORK_AGENT 定义

4. 从 activeAgents 列表中解析智能体定义
   - 根据权限拒绝规则过滤
   - 根据 allowedAgentTypes 过滤
   - 若未找到或被拒绝则抛出异常

5. 检查所需的 MCP 服务器（若处于待定状态最多等待 30 秒）

6. 解析隔离模式（参数优先级高于智能体定义）
   - "remote" -> teleportToRemote() -> 返回 remote_launched
   - "worktree" -> createAgentWorktree()
   - null -> 普通模式执行

7. 决定同步还是异步
   shouldRunAsync = run_in_background || selectedAgent.background ||
                    isCoordinator || forceAsync || isProactiveActive

8. 组装 Worker 工具池

9. 构建系统 Prompt 与 Prompt 消息

10. 执行（异步 -> registerAsyncAgent + 触发后台生命周期；同步 -> 逐步迭代 runAgent）
```

第 1 步至第 6 步是纯粹的路由调度——此时尚未创建任何智能体。真正的生命周期始于 `runAgent()`，同步路径直接对其进行迭代，而异步路径则将其包装在 `runAsyncAgentLifecycle()` 中。

将路由逻辑收敛在 `call()` 而非 `runAgent()` 中有其深层次原因：`runAgent()` 是一个纯粹的生命周期函数，它对队友概念、远程智能体或分叉实验一无所知。它只接收已解析就绪的智能体定义并忠实执行。至于应当解析*哪一个*定义、*如何*隔离智能体，以及*是否*以异步方式运行，这些决策均属于更上层的职责。这种关注点分离使得 `runAgent()` 具备极高的可测试性与复用性——它既可以从正常的 AgentTool 路径调用，也可以在恢复后台智能体时从异步生命周期包装器中调用。

第 3 步中的分叉守卫尤为值得关注。分叉子智能体在其工具池中保留了 `Agent` 工具（为了与父智能体维持 byte-identical 字节完全一致的工具定义以命中缓存），但递归分叉将是毁灭性的灾难。系统设立了两道守卫以防范递归：`querySource === 'agent:builtin:fork'`（设定在子智能体的上下文选项中，在 autocompact 自动压缩后依然存活）以及 `isInForkChild(messages)`（作为后备手段扫描对话历史中的 `<fork-boilerplate>` 标签）。这种“双重保险（belt and suspenders）”设计确保了主守卫快速可靠，而后备守卫则能在 querySource 未被透传的极端边缘场景下力挽狂澜。

---

## runAgent 生命周期

`runAgent.ts` 中的 `runAgent()` 是一个驱动子智能体整个生命周期的异步生成器函数。随着智能体开展工作，它不断产出 `Message` 对象。所有的子智能体——分叉智能体、内置智能体、自定义智能体、协调者工作者——无一例外均流经这一个统一的函数。该函数大约有 400 行代码，其中的每一行都有其存在的严谨理由。

函数签名展现了该问题空间的复杂性：

```typescript
export async function* runAgent({
  agentDefinition,       // 属于哪种智能体
  promptMessages,        // 要向其交代什么
  toolUseContext,        // 父智能体的执行上下文
  canUseTool,           // 权限回调函数
  isAsync,              // 后台异步还是前台阻塞？
  canShowPermissionPrompts,
  forkContextMessages,  // 父智能体的历史记录（仅限分叉）
  querySource,          // 溯源追踪
  override,             // 系统 Prompt、AbortController、Agent ID 等覆盖项
  model,                // 调用方传入的模型覆盖
  maxTurns,             // 轮数上限
  availableTools,       // 预先组装好的工具池
  allowedTools,         // 权限作用域范围
  onCacheSafeParams,    // 用于后台摘要的回调
  useExactTools,        // 分叉路径：完全复用父智能体工具
  worktreePath,         // 隔离目录
  description,          // 可读的任务描述
  // ...
}: { ... }): AsyncGenerator<Message, void>
```

多达十七个参数。每一个参数都代表了生命周期必须兼容的一个维度的变数。这绝非过度工程，而是一个函数同时兼顾分叉智能体、内置智能体、自定义智能体、同步智能体、异步智能体、worktree 隔离智能体和协调者工作者的自然结果。倘若采用替代方案，写出七个逻辑重复的生命周期函数，代码维护将沦为噩梦。

`override` 对象尤为关键——它是分叉智能体和恢复执行的智能体用来向生命周期注入预计算值（系统 Prompt、AbortController、Agent ID）的“逃生通道”，避免在生命周期内部重复派生。

以下是具体的十五个步骤。

### 步骤 1：模型解析

```typescript
const resolvedAgentModel = getAgentModel(
  agentDefinition.model,                    // 智能体声明的偏好
  toolUseContext.options.mainLoopModel,      // 父智能体的模型
  model,                                    // 调用方覆盖（来自输入）
  permissionMode,                           // 当前权限模式
)
```

解析链路的优先级为：**调用方覆盖 > 智能体定义 > 父智能体模型 > 系统默认**。`getAgentModel()` 函数负责处理特殊值，例如 `'inherit'`（直接继承父智能体使用的模型）以及受 GrowthBook 门控控制的特定智能体类型覆盖。例如，针对外部用户，Explore 智能体默认采用 Haiku——这是最便宜、最快速的模型，非常适合每周被调用 3400 万次的只读搜索专家。

这一顺序至关重要：调用方（父智能体模型）可以通过在工具调用中传入 `model` 参数，覆盖智能体定义的默认偏好。这允许父智能体在遇到极其复杂的搜索任务时将原本廉价的智能体升格为能力更强的模型，或者在任务简单时降级昂贵的模型。但智能体定义自带的模型是基准默认值，而非盲目继承父级——一个 Haiku Explore 智能体不应该仅仅因为没有人显式指定，就意外继承了父级的 Opus 模型。

理解模型解析链极为重要，因为它确立了贯穿整个生命周期的一个核心设计原则：**显式覆盖优于声明，声明优于继承，继承优于默认。** 这项原则同样支配着权限模式、AbortController 和系统 Prompt 的决策。这种内在一致性赋予了系统极高的可预测性——只要理解了一条解析链，就能通晓全部。

### 步骤 2：创建 Agent ID

```typescript
const agentId = override?.agentId ? override.agentId : createAgentId()
```

Agent ID 遵循 `agent-<hex>` 的格式，其中十六进制部分源自 `crypto.randomUUID()`。名义类型（Branded Type）`AgentId` 在类型系统层面防止了意外的字符串混淆。override 分支专门服务于恢复执行的智能体，使它们能够保留原始 ID 以维持转录历史的连续性。

### 步骤 3：准备上下文

分叉智能体与全新智能体在此处分道扬镳：

```typescript
const contextMessages: Message[] = forkContextMessages
  ? filterIncompleteToolCalls(forkContextMessages)
  : []
const initialMessages: Message[] = [...contextMessages, ...promptMessages]

const agentReadFileState = forkContextMessages !== undefined
  ? cloneFileStateCache(toolUseContext.readFileState)
  : createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE)
```

对于分叉智能体，父智能体的全部对话历史会被克隆至 `contextMessages` 中。但这里有一道关键过滤器：`filterIncompleteToolCalls()` 会剔除任何缺少对应 `tool_result` 块的 `tool_use` 块。如果没有这道过滤，API 会因为对话格式不合规而直接拒绝请求。当父智能体在分叉发生的瞬间恰好处于工具执行中途（已发出 tool_use 但结果尚未返回）时，这种情况便会出现。

文件状态缓存（file state cache）遵循相同的分叉或全新模式。分叉子智能体会获得父智能体缓存的浅拷贝（它们已经“知晓”哪些文件已被读取）。全新智能体则从空缓存启动。克隆属于浅拷贝——文件内容字符串通过引用共享，并不会复制内存。这对于内存控制至关重要：一个拥有 50 个文件缓存的分叉子智能体不会复制 50 份文件内容，而仅仅复制了 50 个指针。底层的 LRU 淘汰机制是独立的——各个缓存根据各自的访问模式独立执行淘汰。

### 步骤 4：剔除 CLAUDE.md

像 Explore 和 Plan 这样的只读智能体，在其定义中设置了 `omitClaudeMd: true`：

```typescript
const shouldOmitClaudeMd =
  agentDefinition.omitClaudeMd &&
  !override?.userContext &&
  getFeatureValue_CACHED_MAY_BE_STALE('tengu_slim_subagent_claudemd', true)
const { claudeMd: _omittedClaudeMd, ...userContextNoClaudeMd } = baseUserContext
const resolvedUserContext = shouldOmitClaudeMd
  ? userContextNoClaudeMd
  : baseUserContext
```

CLAUDE.md 文件包含了关于提交信息格式、PR 规范、Lint 规则和编码标准的项目专属指引。一个只读的搜索智能体完全不需要这些内容——它不能提交代码、不能创建 PR，更不能编辑文件。父智能体拥有完整上下文并将负责解读搜索结果。在此处剔除 CLAUDE.md，每周能在整个系统舰队中节省数十亿个 Token——如此庞大的总体成本缩减，足以证明引入条件上下文注入的复杂度是完全值得的。

同样，Explore 和 Plan 智能体还会从系统上下文中剔除 `gitStatus`。会话启动时捕获的 git status 快照可能高达 40KB，并且已被明确标记为陈旧状态。如果这些智能体确实需要 git 信息，它们完全可以自行运行 `git status` 获取最新数据。

这些绝不是过早优化。在每周 3400 万次 Explore 衍生的规模下，每一个不必要的 Token 都会复合累积成可观的账单成本。安全熔断开关（`tengu_slim_subagent_claudemd`）默认设为 true，但如果剔除操作引发了回归问题，可以通过 GrowthBook 随时在线关闭。

### 步骤 5：权限隔离

这是整个流程中最微妙繁复的步骤。每个智能体都会获得一个定制的 `getAppState()` 包装函数，将其权限配置覆盖叠加到父级的状态之上：

```typescript
const agentGetAppState = () => {
  const state = toolUseContext.getAppState()
  let toolPermissionContext = state.toolPermissionContext

  // 覆盖权限模式，除非父智能体处于 bypassPermissions、acceptEdits 或 auto 模式
  if (agentPermissionMode && canOverride) {
    toolPermissionContext = {
      ...toolPermissionContext,
      mode: agentPermissionMode,
    }
  }

  // 针对无法展示 UI 的智能体自动拒绝弹窗提示
  const shouldAvoidPrompts =
    canShowPermissionPrompts !== undefined
      ? !canShowPermissionPrompts
      : agentPermissionMode === 'bubble'
        ? false
        : isAsync
  if (shouldAvoidPrompts) {
    toolPermissionContext = {
      ...toolPermissionContext,
      shouldAvoidPermissionPrompts: true,
    }
  }

  // 划定工具允许规则的作用域
  if (allowedTools !== undefined) {
    toolPermissionContext = {
      ...toolPermissionContext,
      alwaysAllowRules: {
        cliArg: state.toolPermissionContext.alwaysAllowRules.cliArg,
        session: [...allowedTools],
      },
    }
  }

  return { ...state, toolPermissionContext, effortValue }
}
```

这里交织着四项截然不同的关注点：

**权限模式级联（Permission mode cascade）。** 如果父智能体处于 `bypassPermissions`、`acceptEdits` 或 `auto` 模式，父智能体的模式始终享有最高优先权——子智能体定义绝不能削弱这一信任级别。否则，将应用智能体定义的 `permissionMode`。这防止了当用户为当前会话明确设定了宽松模式时，自定义智能体反向降级安全性。

**规避交互提示（Prompt avoidance）。** 后台智能体无法向用户展示权限交互对话框——因为它们没有附加终端界面。因此 `shouldAvoidPermissionPrompts` 被设为 `true`，促使权限系统在遇到需要提权时自动拒绝而非卡住阻塞。唯一的例外是 `bubble`（冒泡）模式：这类智能体将提示上浮到父级的终端展示，因此无论处于同步还是异步状态，它们都可以正常弹出提示。

**自动化检查顺序（Automated check ordering）。** 能够展示提示的后台智能体（冒泡模式）会设置 `awaitAutomatedChecksBeforeDialog`。这意味着分类器和权限 Hook 会先行运行；只有在自动化判定无果时才会打扰用户。对于后台工作而言，多花一秒钟等待分类器做出判断是完全可接受的——绝不应无谓地打扰用户。

**工具权限作用域划定（Tool permission scoping）。** 当传入 `allowedTools` 时，它会彻底替换会话级别的允许规则。这防止了父智能体已获得的授权泄漏给受限智能体。但 SDK 级别的权限（源自 `--allowedTools` CLI 参数）则予以保留——它们代表了宿主集成应用程序明确的安全基线策略，理应普适生效。

### 步骤 6：工具解析

```typescript
const resolvedTools = useExactTools
  ? availableTools
  : resolveAgentTools(agentDefinition, availableTools, isAsync).resolvedTools
```

分叉智能体使用 `useExactTools: true`，直接原封不动地透传父智能体的工具数组。这不仅仅是出于便利——更是为了**缓存优化**。不同的工具定义会序列化出不同的内容（不同的权限模式会生成不同的工具元数据），而工具块中的任何细微差异都会导致 Prompt 缓存失效。分叉子智能体必须拥有字节完全一致（byte-identical）的前缀。

对于普通智能体，`resolveAgentTools()` 会应用分层过滤机制：
- `tools: ['*']` 意味着所有工具可用；`tools: ['Read', 'Bash']` 表示仅限这些工具；
- `disallowedTools: ['Agent', 'FileEdit']` 会将对应工具从工具池中剔除；
- 内置智能体与自定义智能体拥有不同的基础禁用工具集；
- 异步智能体还会经过 `ASYNC_AGENT_ALLOWED_TOOLS` 的专项过滤。

最终结果是每种智能体类型都能精准看到其应当持有的工具。Explore 智能体绝对无法调用 FileEdit。Verification 智能体绝对无法调用 Agent（严禁验证者发起递归衍生）。自定义智能体相比内置智能体拥有更为严格的默认黑名单。

### 步骤 7：系统 Prompt

```typescript
const agentSystemPrompt = override?.systemPrompt
  ? override.systemPrompt
  : asSystemPrompt(
      await getAgentSystemPrompt(
        agentDefinition, toolUseContext,
        resolvedAgentModel, additionalWorkingDirectories, resolvedTools
      )
    )
```

分叉智能体通过 `override.systemPrompt` 接收父智能体预渲染好的系统 Prompt。这是从 `toolUseContext.renderedSystemPrompt` 透传过来的——即父智能体在最近一次 API 调用中所使用的完全一致的字节串。若重新调用 `getSystemPrompt()` 进行计算，结果可能会产生分歧：GrowthBook 特性可能在父智能体调用与子智能体启动的间隙完成了从冷启动到热状态的转换。系统 Prompt 中哪怕仅仅出现一个字符的差异，都会让整个 Prompt 缓存前缀毁于一旦。

对于常规智能体，`getAgentSystemPrompt()` 会调用该智能体定义的 `getSystemPrompt()` 函数，随后注入运行环境细节——绝对路径、Emoji 使用指引（Claude 在某些语境下有滥用 Emoji 的倾向）以及特定模型的指导说明。

### 步骤 8：AbortController 隔离

```typescript
const agentAbortController = override?.abortController
  ? override.abortController
  : isAsync
    ? new AbortController()
    : toolUseContext.abortController
```

短短三行代码，涵盖了三种精妙的行为逻辑：

- **Override（覆盖）**：用于恢复执行的后台智能体或特殊的生命周期管理，享有最高优先级。
- **异步智能体获得全新的、未挂钩的独立控制器**。当用户按下 Escape 键时，父智能体的 AbortController 会被触发。异步智能体应当在此种情况下幸存——它们是用户主动选择委托出去的后台工作。独立的控制器确保它们能在后台持续运转。
- **同步智能体共享父级的控制器**。按下 Escape 键会同时终止父子双方。因为子智能体此时正在阻塞父智能体；如果用户意图叫停，那必然是希望全盘停止。

这是那种事后看来显而易见、但一旦处理失当就会引发灾难的设计抉择。如果异步智能体在父级中止时一同被杀，用户每次按 Escape 键打断以追问一个补充问题时，后台智能体就会丢失全部进度。反之，如果同步智能体忽略了父级的中止信号，用户就会绝望地对着卡住的终端束手无策。

### 步骤 9：Hook 注册

```typescript
if (agentDefinition.hooks && hooksAllowedForThisAgent) {
  registerFrontmatterHooks(
    rootSetAppState, agentId, agentDefinition.hooks,
    `agent '${agentDefinition.agentType}'`, true
  )
}
```

智能体定义可以在 Frontmatter 中声明自己的 Hook（PreToolUse、PostToolUse 等）。这些 Hook 通过 `agentId` 严格限制在该智能体的生命周期作用域内——它们仅在该智能体触发工具调用时激活，并且在智能体终止时在 `finally` 块中被自动清理。

`isAgent: true` 标志（最后一个 `true` 参数）会将 `Stop` 类型的 Hook 转换为 `SubagentStop` Hook。子智能体触发的是 `SubagentStop` 而非顶层的 `Stop`，这种自动转换确保了 Hook 能够在正确的生命周期事件发生时准确命中。

安全性在此处至关重要。当 Hook 启用了 `strictPluginOnlyCustomization` 策略时，系统只会注册插件、内置以及策略配置所定义的智能体 Hook。用户自行控制的智能体（源自 `.claude/agents/`）的 Hook 会被静默忽略。这有效防御了恶意或配置不当的智能体定义注入旨在绕过安全控制的特权 Hook。

### 步骤 10：技能预加载 (Skill Preloading)

```typescript
const skillsToPreload = agentDefinition.skills ?? []
if (skillsToPreload.length > 0) {
  const allSkills = await getSkillToolCommands(getProjectRoot())
  // 解析名称，加载内容，前置拼接到 initialMessages
}
```

智能体定义可以在 Frontmatter 中指定 `skills: ["my-skill"]`。解析过程尝试三种匹配策略：精确匹配、以该智能体的插件名称为前缀（例如 `"my-skill"` 变为 `"plugin:my-skill"`），以及针对带有插件命名空间的技能进行 `":skillName"` 的后缀匹配。这三种匹配策略确保无论智能体作者使用的是全限定名称、简写名称还是插件相对名称，技能引用都能平滑解析。

加载就绪的技能会被包装为用户消息，前置拼接到智能体的对话历史开头。这意味着智能体在看到实际的任务 Prompt 之前，就已经“阅读”了其技能指导规范——这与主 REPL 中斜杠命令（slash commands）所使用的底层机制如出一辙，被巧妙复用于自动化的技能注入。当指定了多个技能时，技能内容通过 `Promise.all()` 并行并发加载，从而最大化减少启动延迟。

### 步骤 11：MCP 初始化

```typescript
const { clients: mergedMcpClients, tools: agentMcpTools, cleanup: mcpCleanup } =
  await initializeAgentMcpServers(agentDefinition, toolUseContext.options.mcpClients)
```

智能体可以在 Frontmatter 中声明属于自己的 MCP 服务器，与父级的客户端形成增量叠加。系统支持两种声明形式：

- **按名称引用**：`"slack"` 查找现有的 MCP 配置并获取一个共享且带有内存记忆化（memoized）的客户端。
- **内联定义**：`{ "my-server": { command: "...", args: [...] } }` 创建一个全新的客户端，并在智能体生命周期结束时予以清理。

仅有新创建的（内联）客户端才会被自动清理。共享客户端在父级作用域中被记忆化缓存，其生命周期独立于子智能体。这一区分防止了某个子智能体意外拆除其他智能体或父智能体仍在使用的共享 MCP 连接。

MCP 初始化发生在 Hook 注册与技能预加载*之后*、但在上下文创建*之前*。这一执行顺序不可颠倒：MCP 工具必须在 `createSubagentContext()` 将工具快照归入智能体选项之前，被完整合并到工具池中。颠倒这些步骤将导致智能体要么拿不到 MCP 工具，要么拿到后无法进入其工具池。

### 步骤 12：创建上下文

```typescript
const agentToolUseContext = createSubagentContext(toolUseContext, {
  options: agentOptions,
  agentId,
  agentType: agentDefinition.agentType,
  messages: initialMessages,
  readFileState: agentReadFileState,
  abortController: agentAbortController,
  getAppState: agentGetAppState,
  shareSetAppState: !isAsync,
  shareSetResponseLength: true,
  criticalSystemReminder_EXPERIMENTAL:
    agentDefinition.criticalSystemReminder_EXPERIMENTAL,
  contentReplacementState,
})
```

`utils/forkedAgent.ts` 中的 `createSubagentContext()` 负责组装全新的 `ToolUseContext`。关键的隔离决策如下：

- **同步智能体与父级共享 `setAppState`**。状态变更（例如权限批准）对双方立即可见，用户感知到的是统一连贯的状态。
- **异步智能体获得隔离的 `setAppState`**。父级持有的副本对子级的写入充耳不闻（no-op）。但 `setAppStateForTasks` 依然能够触达根 Store——子智能体依然有权更新 UI 所监听的任务状态（进度、完成情况）。
- **双方共享 `setResponseLength`**，以用于全局响应指标追踪。
- **分叉智能体继承 `thinkingConfig`**，以确保向 API 发出的请求保持完全相同的缓存特征。常规智能体则强制设为 `{ type: 'disabled' }`——禁用思考（扩展推理 Token）以严格控制输出成本。父智能体承担昂贵的思考开销，子智能体负责专心执行。

`createSubagentContext()` 在决定哪些关注点应当*隔离*、哪些应当*共享*时展现出了精湛的设计艺术。隔离边界绝非非黑即白的一刀切，而是一组经过严密权衡的共享与隔离通道组合：

| 关注维度 | 同步智能体 | 异步智能体 |
|---------|-----------|-------------|
| `setAppState` | 共享（父级立即可见变更） | 隔离（父级副本为空操作） |
| `setAppStateForTasks` | 共享 | 共享（任务状态必须上报至根状态） |
| `setResponseLength` | 共享 | 共享（性能指标需要全局全貌） |
| `readFileState` | 独立缓存 | 独立缓存 |
| `abortController` | 复用父级控制器 | 独立控制器 |
| `thinkingConfig` | 分叉：继承 / 常规：禁用 | 分叉：继承 / 常规：禁用 |
| `messages` | 独立消息数组 | 独立消息数组 |

`setAppState`（针对异步智能体隔离）与 `setAppStateForTasks`（始终共享）之间的不对称性是一项关键架构抉择。异步智能体不能随意向父级的响应式 Store 推送状态变更——否则会导致父级终端 UI 发生意料之外的跳变或错乱。但智能体又必须能够更新全局任务注册表，因为父级正是据此获知后台智能体何时完成的。这种通道拆分优雅地同时满足了两项诉求。

### 步骤 13：缓存安全参数回调 (Cache-Safe Params Callback)

```typescript
if (onCacheSafeParams) {
  onCacheSafeParams({
    systemPrompt: agentSystemPrompt,
    userContext: resolvedUserContext,
    systemContext: resolvedSystemContext,
    toolUseContext: agentToolUseContext,
    forkContextMessages: initialMessages,
  })
}
```

该回调由后台摘要服务所消费。当异步智能体在后台运行时，摘要服务可以分叉该智能体的对话历史——利用这些完全一致的参数构建出与原请求在字节级别完全相同的 Prompt 前缀——从而在不打扰主对话的前提下周期性生成进度摘要。这些参数之所以被称为“缓存安全（cache-safe）”，是因为它们能够构造出与智能体完全相同的 API 请求前缀，从而最大限度地提高缓存命中率。

### 步骤 14：查询循环 (The Query Loop)

```typescript
try {
  for await (const message of query({
    messages: initialMessages,
    systemPrompt: agentSystemPrompt,
    userContext: resolvedUserContext,
    systemContext: resolvedSystemContext,
    canUseTool,
    toolUseContext: agentToolUseContext,
    querySource,
    maxTurns: maxTurns ?? agentDefinition.maxTurns,
  })) {
    // 转发 API 请求启动事件以进行指标统计
    // 产出附件消息
    // 记录到 sidechain 转录本
    // 向调用方产出可记录的消息
  }
}
```

在第 3 章中介绍的同一个 `query()` 函数在此负责驱动子智能体的对话运转。子智能体生成的消息被产出（yield）回调用方——对于同步智能体，调用方是内联迭代该生成器的 `AgentTool.call()`；对于异步智能体，调用方则是在独立异步上下文中消费该生成器的 `runAsyncAgentLifecycle()`。

每个产出的消息都会通过 `recordSidechainTranscript()` 记录到侧链转录本（sidechain transcript）中——这是为每个智能体独立维护的追加式（append-only）JSONL 文件。这使得断点续传（resume）成为可能：如果会话中途中断，智能体可以完全从转录本中重建。单条消息的写入开销为 $O(1)$，每次仅需追加新消息并记录对前一条 UUID 的引用，以维持链式结构的完整性。

### 步骤 15：清理收尾 (Cleanup)

`finally` 块无论在正常完成、中止还是抛出异常时都会必定执行。它是整个代码库中最全面严谨的资源清理序列：

```typescript
finally {
  await mcpCleanup()                              // 拆除智能体专属的 MCP 服务器连接
  clearSessionHooks(rootSetAppState, agentId)      // 卸载属于该智能体作用域的 Hook
  cleanupAgentTracking(agentId)                    // 清理 Prompt 缓存追踪状态
  agentToolUseContext.readFileState.clear()         // 释放文件状态缓存内存
  initialMessages.length = 0                        // 释放分叉上下文引用（GC 提示）
  unregisterPerfettoAgent(agentId)                 // 注销 Perfetto 性能追踪层级
  clearAgentTranscriptSubdir(agentId)              // 清理转录本子目录映射
  rootSetAppState(prev => {                        // 移除属于该智能体的待办（todo）项
    const { [agentId]: _removed, ...todos } = prev.todos
    return { ...prev, todos }
  })
  killShellTasksForAgent(agentId, ...)             // 强制杀死孤儿 bash 进程
}
```

智能体在其一生中触及的每一个子系统都将在此处被彻底清理。MCP 连接、Hook、缓存追踪、文件状态、Perfetto 跟踪、待办条目以及孤儿 shell 进程无一遗漏。代码中关于衍生数百个智能体的“巨鲸会话（whale sessions）”的注释令人警醒——如果没有这套彻底的清理，每个智能体残留的微小泄露在长时间的繁重会话中累积起来，将演变成致命的内存崩溃压力。

`initialMessages.length = 0` 这一行是对垃圾回收器的手动提示。对于分叉智能体而言，`initialMessages` 持有着父智能体的全部对话历史。将长度置零能够彻底释放这些对象引用，让垃圾收集器能够及时回收内存。在一个拥有 20 万 Token 上下文的会话中衍生出五个分叉子智能体，每个子智能体都会占用数兆字节重复的消息对象。

这为长时间运行的智能体系统的资源管理带来了极为深刻的启示。这里的每个清理步骤都在针对性防御不同类别的泄露：MCP 连接（文件描述符）、Hook（应用状态 Store 中的内存引用）、文件状态缓存（内存中的文件内容字符串）、Perfetto 注册（性能追踪元数据）、待办条目（响应式状态键）以及 shell 进程（操作系统级子进程）。智能体在其生命期内与诸多子系统深度交织，每个子系统都必须在智能体谢幕时收到明确通知。`finally` 块正是所有这些通知集中收拢的唯一场所，而生成器协议从底层保证了它必定得以执行。这就是为什么基于生成器的架构不仅是一种模式上的优雅便利——更是**确保系统正确性的硬性要求**。

### 生成器链 (The Generator Chain)

在检视具体的内置智能体类型之前，有必要退后一步，审视支撑这套体系运转的底层结构模式。整个子智能体系统完全构筑在异步生成器之上。调用链流向如下：

```mermaid
graph TD
    subgraph 同步路径 (Sync Path)
        S1[AgentTool.call] -->|内联迭代| S2[runAgent 生成器]
        S2 -->|yield* query| S3[子智能体 query 循环]
        S3 -->|消息流| S2
        S2 -->|最终结果| S1
        S1 -->|tool_result| S4[父智能体 query 循环]
    end

    subgraph 异步路径 (Async Path)
        A1[AgentTool.call] -->|脱离主流程| A2[runAsyncAgentLifecycle]
        A2 -->|包装| A3[runAgent 生成器]
        A3 -->|yield* query| A4[子智能体 query 循环]
        A1 -->|立即返回凭据| A5[父智能体继续推进]
        A4 -->|执行完成| A6[任务通知]
        A6 -->|注入| A5
    end

    subgraph 分叉路径 (Fork Path)
        F1[AgentTool.call] -->|脱离主流程，强制异步| F2[runAsyncAgentLifecycle]
        F2 -->|包装| F3[runAgent 生成器]
        F3 -->|yield* query 携带\n字节完全一致的前缀| F4[子智能体 query 循环]
        F1 -->|立即返回凭据| F5[父智能体继续推进]
        F4 -->|执行完成| F6[任务通知]
    end
```

这种基于生成器的架构赋予了系统四项关键能力：

**流式传输（Streaming）。** 消息在系统中以增量方式流动。父智能体（或异步生命周期包装器）能够实时观察产生的每条消息——就地更新进度指示器、转发性能指标、记录转录本——而无需将整个对话先在内存中全量缓冲。

**优雅取消（Cancellation）。** 提前 return 异步迭代器会强制触发 `runAgent()` 中的 `finally` 块。无论智能体是正常完成、被用户主动中止还是遭遇未捕获异常，上述十五步清理逻辑都必定全盘执行。JavaScript 的异步生成器协议在语言层面对此提供了铁律般的保证。

**后台化转换（Backgrounding）。** 运行耗时过长的同步智能体可以在执行中途无缝切换至后台。迭代器可以从前台（`AgentTool.call()` 正在内联迭代之处）移交给异步上下文（由 `runAsyncAgentLifecycle()` 接管）。智能体无需重启——它会直接从暂停的当前进度继续向下执行。

**进度追踪（Progress tracking）。** 每一个被 yield 出来的消息都是一个观测点。异步生命周期包装器正是利用这些观测点来驱动任务状态机更新、计算进度百分比，并在智能体完成时准确生成系统级通知。

---

## 内置智能体类型

内置智能体通过 `builtInAgents.ts` 中的 `getBuiltInAgents()` 进行注册。注册表本身是动态的——具体哪些智能体可用取决于特性开关、GrowthBook 实验以及当前会话的入口点类型。系统内置了六种智能体，各自专为特定类型的工作负载量身优化。

### 通用智能体 (General-Purpose)

当省略了 `subagent_type` 且分叉功能未激活时的默认智能体。拥有完整的工具访问权限，不剔除 CLAUDE.md，所用模型由 `getDefaultSubagentModel()` 确定。它的系统 Prompt 将其定位为一个以交付为导向的得力干将：“彻底完成任务——切勿画蛇添足，但也绝不能留半拉子工程。”其中还包含了搜索策略的指引（先粗筛，再精读）以及文件创建的克制守则（除非任务确有要求，否则绝不轻易新建文件）。

这是最基础的通用工蜂。当模型不清楚具体需要何种专业智能体时，它就会得到一个能完成父智能体除“衍生自己的子智能体”之外所有事情的通用智能体。“除衍生之外”这项限制至关重要：若非如此，通用子智能体就能继续衍生出自己的子智能体，子又生孙，在数秒之内引发指数级扇出（fan-out），瞬间烧光 API 额度预算。`Agent` 工具被列入默认禁用列表有着极为充分的技术考量。

### 探索智能体 (Explore)

只读搜索专家。采用 Haiku（最廉价、响应最迅速的模型）。剔除了 CLAUDE.md 和 git status。其工具池中硬性剥离了 `FileEdit`、`FileWrite`、`NotebookEdit` 和 `Agent`，这种约束不仅在工具定义层面强制生效，还在其系统 Prompt 的 `=== CRITICAL: READ-ONLY MODE ===`（关键：只读模式）小节中得到了严厉强化。

Explore 是系统中优化最激进的内置智能体，因为它是最频繁被衍生的主力——全系统舰队每周衍生高达 3400 万次。它被标记为单次发后即弃的智能体（`ONE_SHOT_BUILTIN_AGENT_TYPES`），这意味着其 Prompt 中省略了 agentId、SendMessage 操作说明和用法尾随注记，每次调用能够节省约 135 个字符。在每周 3400 万次调用的乘数效应下，这 135 个字符每周为系统节省了大约 46 亿个字符的 Prompt Token。

其可用性受 `BUILTIN_EXPLORE_PLAN_AGENTS` 特性开关以及 `tengu_amber_stoat` GrowthBook 实验的双重门控约束，后者用于 A/B 测试移除这些专业智能体对用户行为的影响。

### 规划智能体 (Plan)

软件架构师智能体。拥有与 Explore 相同的只读工具集，但在模型选择上指定为 `'inherit'`（继承父智能体的能力级别）。其系统 Prompt 引导它经历结构严谨的四步流程：理解需求、彻底探索、设计解决方案、细化执行计划。它必须在输出结尾附上“实施关键文件清单（Critical Files for Implementation）”。

Plan 智能体之所以继承父智能体的模型，是因为系统架构设计需要与实际工程编码同等水平的高阶推理能力。你绝不会希望让一个 Haiku 级别的模型去制定那些最终需要 Opus 级别模型落地执行的设计决策。模型能力的错配会导致生成的计划执行方根本无法照办——甚至更糟的是，制定出看似头头道道实则暗藏玄机与漏洞的架构方案，而这些隐患往往只有更高阶的模型在复盘时才能觉察。

其可用性门控与 Explore 相同（`BUILTIN_EXPLORE_PLAN_AGENTS` + `tengu_amber_stoat`）。

### 验证智能体 (Verification)

对抗性测试专家。持有只读工具，模型为 `'inherit'`，**始终在后台运行**（`background: true`），在终端界面中以亮红色醒目标记。其系统 Prompt 是所有内置智能体中最详尽繁复的，大约有 130 行之多。

Verification 智能体最引人入胜的特征在于其“反逃避倾向机制（anti-avoidance programming）”。其 Prompt 明确列举了模型可能找借口回避深入测试的常见托词，并指示其“识别这些借口并反其道而行之”。每一次测试检查都必须包含一个附带真实终端输出的“Command run”代码块——拒绝空谈，拒绝“这应该没问题”。该智能体必须设计至少一处对抗性探测（并发冲突、极限边界、幂等性验证、孤儿资源回收）。而且在汇报失败之前，它必须认真审视该行为是否系刻意设计或已在其他链路得到妥善处理。

`criticalSystemReminder_EXPERIMENTAL` 字段会在每次工具执行结果返回后，强行追加注入一段提醒，反复申明本轮会话仅限验证。这是一道重要的防护栏，防止模型不由自主地从“验证问题”滑向“顺手修复问题”——这种倾向会彻底瓦解独立对抗性验证的核心价值。语言模型往往具备强烈的“乐于助人”倾向，而在绝大多数编程语境下，“助人”意味着“把 Bug 修掉”。Verification 智能体的全部存在意义，恰恰建立在强力抵制这种冲动的基础之上。

`background: true` 意味着 Verification 智能体永远以异步模式脱机运行。父智能体不会干等验证结果——它可以在后台验证探测的同时继续推进业务开发。当验证者结束任务时，一条系统通知会带着测试裁定如期而至。这完美映射了人类世界的代码审查流：开发者绝不会在评审人员审阅 PR 时停下手头所有的工作。

其可用性受 `VERIFICATION_AGENT` 特性开关以及 `tengu_hive_evidence` GrowthBook 实验控制。

### Claude Code 指南智能体 (Claude Code Guide)

专注于解答关于 Claude Code 本身、Claude Agent SDK 以及 Claude API 使用疑问的文档检索智能体。基于 Haiku 运行，以 `dontAsk` 权限模式运转（无需向用户弹出任何授权提示——它仅读取只读文档），并内置了两个写死的官方权威文档 URL。

它的 `getSystemPrompt()` 非常独特，因为它接收了当前的 `toolUseContext`，能够动态注入关于当前项目已配自定义技能、自定义智能体、已配 MCP 服务器、插件命令以及用户偏好设置的最新快照。这使得它在回答“我该如何配置 X？”时，能够建立在精准了解用户已经配置了什么的上下文之上。

当会话入口为 SDK（TypeScript、Python 或 CLI）时，该智能体会被排除，因为 SDK 用户不会询问 Claude Code 该如何使用 Claude Code，他们是在其上搭建属于自己的上层应用。

Guide 智能体是智能体工程设计的一个经典教学范式，因为它是唯一一个系统 Prompt 与用户本地项目配置动态深层绑定的内置智能体。它唯有通晓当前的配置全貌，才能给出精准切中要害的实操建议。这使得它的 `getSystemPrompt()` 逻辑相比其他智能体更为复杂，但这种权衡带来的价值不可估量——一个对用户当前配置两眼一抹黑的文档助手，给出的建议往往不仅平庸，甚至充斥误导。

### 状态栏配置智能体 (Statusline Setup)

专为配置终端状态栏打造的专业智能体。基于 Sonnet 运行，在终端以橙色标示，工具权限被严格限制在仅限 `Read` 和 `Edit`。它精通如何将 shell PS1 转义序列翻译为 shell 命令、如何向 `~/.claude/settings.json` 写入标准配置，以及如何解析和满足 `statusLine` 命令的特定 JSON 输入格式。

这是所有内置智能体中职责范围划定最狭窄的一个——它之所以作为独立智能体存在，是因为终端状态栏配置本身是一套自成一体的封闭领域，具备高度特化的格式语法，若将这些规范揉入通用智能体的上下文中，只会白白增加噪音。它始终可用，不设任何特性门控。

状态栏配置智能体深刻诠释了一条架构设计准则：**有时，一个高度特化的狭义专业智能体，远胜于一个堆砌了海量上下文的通用智能体。** 如果把状态栏文档全盘塞给通用智能体，它或许最终也能配置正确。但其成本必然更为高昂（占用了更大模型的大量 Token）、响应更加迟钝（需要消化庞大的上下文），并且在状态栏冷僻语法与当前代码库任务的交织下更容易产生幻觉与混淆。一个装备了 Read 和 Edit 工具、配备专注系统 Prompt 的专用 Sonnet 智能体，能够以更快、更便宜且更可靠的姿态优雅完成任务。

### Worker 工作者智能体（协调者模式）

该智能体不在 `built-in/` 目录下，而是在协调者模式激活时被动态按需加载：

```typescript
if (isEnvTruthy(process.env.CLAUDE_CODE_COORDINATOR_MODE)) {
  const { getCoordinatorAgents } = require('../../coordinator/workerAgent.js')
  return getCoordinatorAgents()
}
```

在协调者模式下，Worker 智能体会直接替换所有标准的内置智能体。它拥有统一的类型标识 `"worker"`，并享有完整的全套工具访问权限。这种极简化是深思熟虑后的架构抉择——当协调者（Coordinator）负责总揽全局指挥工作者时，协调者拥有定义每个工作者具体职责的最高裁决权。Worker 不再需要 Explore 或 Plan 那样的预设特化；它所需要的是随调随用的极致灵活性，以严格执行协调者下达的任何指令。

---

## 分叉智能体 (Fork Agents)

分叉智能体——即子智能体完整继承父智能体的全部对话历史、系统 Prompt 以及工具数组，以极致榨取 Prompt 缓存红利——是第 9 章的核心研究主题。当模型在调用 Agent 工具时省略了 `subagent_type`，且分叉实验处于开启状态时，分叉路径即被触发。分叉系统中的每一项设计抉择，归根结底都指向同一个核心技术目标：在并行的多个子智能体之间，构建出**在字节级别完全一致的 API 请求前缀**，从而在共享上下文中解锁高达 90% 的缓存费用减免。

---

## 基于 Frontmatter 的 Agent 定义

用户和插件只需在 `.claude/agents/` 目录下放置 Markdown 文件，即可轻松定义自定义智能体。Frontmatter 的 Schema 完整支持了智能体配置的各项维度：

```yaml
---
description: "何时应当调用此智能体"
tools:
  - Read
  - Bash
  - Grep
disallowedTools:
  - FileWrite
model: haiku
permissionMode: dontAsk
maxTurns: 50
skills:
  - my-custom-skill
mcpServers:
  - slack
  - my-inline-server:
      command: node
      args: ["./server.js"]
hooks:
  PreToolUse:
    - command: "echo validating"
      event: PreToolUse
color: blue
background: false
isolation: worktree
effort: high
---

# 我的自定义智能体

你是一个专业智能体，擅长...
```

Markdown 的正文部分将直接化身为智能体的系统 Prompt。Frontmatter 中的各项字段则一对一严丝合缝地映射至 `runAgent()` 所消费的 `AgentDefinition` 接口。`loadAgentsDir.ts` 中的加载流水线会依照 `AgentJsonSchema` 严格校验 Frontmatter，解析其来源类型（用户级、插件级或企业策略级），并将合法智能体注册至可用智能体列表中。

智能体定义共有四种来源，按优先级降序排列如下：

1. **内置智能体（Built-in agents）** —— 固化在 TypeScript 源码中，始终可用（受特性门控约束）
2. **用户智能体（User agents）** —— 存放在 `.claude/agents/` 下的 Markdown 文件
3. **插件智能体（Plugin agents）** —— 通过 `loadPluginAgents()` 动态加载
4. **企业策略智能体（Policy agents）** —— 依据组织策略配置统一下发加载

当模型调用带有 `subagent_type` 的 `Agent` 工具时，系统会对照这一合并列表解析智能体名称，同时结合权限规则（针对 `Agent(AgentName)` 的拒绝规则）以及工具规范中的 `allowedAgentTypes` 进行过滤。如果请求的智能体类型未找到或被权限策略拒绝，该工具调用将以错误告终。

这种设计赋予了组织极强的扩展能力：可以通过插件分发企业专属的自定义智能体（代码审查智能体、安全审计智能体、部署流水线智能体），并让它们与系统内置智能体无缝并肩作战。模型会在同一个注册列表中看到它们，使用完全一致的标准界面，并以完全相同的方式进行任务委托。

基于 Frontmatter 定义智能体的绝妙之处在于它完全无需编写一行 TypeScript 代码。团队的技术主管若想推行一个“PR 审查”智能体，只需撰写一份带有规范 Frontmatter 的 Markdown 文件，将其检入 `.claude/agents/`，在下一次会话中，该智能体便会立刻出现在团队每一位成员的智能体列表中。系统 Prompt 就是 Markdown 文本正文。工具限制、模型偏好和权限模式直接在 YAML 中声明。而背后的 `runAgent()` 生命周期将全权操办后续的一切——相同的十五步流程、相同的资源清理收尾、相同的环境隔离保障。

这也意味着智能体定义可以像普通代码一样，随整个代码库进行严格的版本控制。代码仓库能够承载针对自身技术架构、编码规范和工程工具链量身定制的专属智能体。智能体与业务代码共同进化。当团队决定迁移至新的测试框架时，在引入新框架依赖的同一次 Git 提交中，就能同步更新验证智能体的 Prompt 规则。

这里有一个不容忽视的关键安全考量：**信任边界（Trust Boundary）**。用户级智能体（源自 `.claude/agents/`）属于用户完全受控——当安全策略激活时，其 Hook、MCP 服务器以及工具配置均受制于 `strictPluginOnlyCustomization` 策略的管辖。而插件智能体和企业策略智能体被视为受管理员信任的实体，能够豁免此类限制。内置智能体则属于 Claude Code 二进制包原生自带。系统对每个智能体定义的 `source`（来源）进行精密追踪，使得安全策略能够明察秋毫地甄别“这是用户随手写的”还是“这是企业组织审批通过的”。

`source` 字段绝不仅仅是用来记录日志的元数据——它从底层决定了运行时的真实行为权限。当 MCP 启用了仅限插件策略时，声明了 MCP 服务器的用户级智能体 Frontmatter 会被静默降级忽略（不建立任何 MCP 连接）。当 Hook 启用了仅限插件策略时，用户级智能体的 Frontmatter Hook 同样不会被注册。智能体依然会运转——只是在剥离了未受信扩展能力的安全沙箱下运转。这完美体现了**优雅降级（Graceful Degradation）**的设计哲学：即使高级特权受到安全策略压制，智能体依然能够提供充沛的基础业务价值。

---

## 实践应用：设计智能体类型

内置智能体向我们展示了一套行之有效的智能体设计模式语言。如果你正在构建一套需要衍生子智能体的系统——无论是直接利用 Claude Code 的 AgentTool，还是自研多智能体架构——整个系统设计空间都可以解构为以下五个核心维度。

### 维度 1：它能看到什么？

`omitClaudeMd`、git 状态剔除与技能预加载的协同组合，精准调控着智能体的“认知感知域”。只读智能体应当看到更少的信息（它们无需关心项目提交与代码风格规范）。高度专业的智能体应当看到更多定向信息（通过预加载技能注入深度领域知识）。

这里的核心洞见在于：**上下文从来都不是免费的午餐**。系统 Prompt、用户上下文或对话历史中的每一个 Token，都在真金白银地消耗资金预算，并无情侵占着大模型宝贵的工作记忆。Claude Code 之所以在 Explore 智能体中剥离 CLAUDE.md，绝非因为那些指引有害，而是因为它们在此场景下**毫无关联**——而在每周 3400 万次衍生的巨幅体量下，与任务无关的冗余信息会直接演变为基础设施财务账单上惊心动魄的开销。在设计你自己的智能体类型时，务必反复追问：“这个智能体要想做好这项工作，真正必不可少的上下文究竟是什么？”其余一切，能砍尽砍。

### 维度 2：它能做什么？

`tools` 与 `disallowedTools` 字段划定了不可逾越的硬性权限红线。Verification 智能体绝对无法编辑文件。Explore 智能体绝对写不进任何数据。通用智能体能够执行几乎一切操作，除了禁止衍生属于它自己的子智能体。

工具约束承载着双重技术使命：**安全性**（Verification 智能体绝不会因冲动而顺手去“修好”它所发现的 Bug，从而捍卫了其裁决的独立客观）以及**专注度**（手中持有的工具越少，智能体在思考“该用哪个工具”上浪费的心智和轮数就越少）。将工具层面的硬性拦截与系统 Prompt 的明确指引（如 Explore 的 `=== CRITICAL: READ-ONLY MODE ===`）强强联合，构成了**纵深防御（Defense in Depth）**体系——工具在机械层面筑起铜墙铁壁，而 Prompt 则向模型清晰释明了为何要设立这条边界，使模型从根本上断绝了消耗轮数试图绕过约束的念头。

### 维度 3：它如何与用户交互？

`permissionMode` 与 `canShowPermissionPrompts` 配置共同决定了智能体在遭遇敏感操作时究竟是向用户索要权限、直接自动拒绝，还是将确认弹窗冒泡推送到父级的终端。无法打断前台用户的后台智能体，必须要么严格在预先批准的安全边界内作业，要么通过冒泡机制进行协调。

`awaitAutomatedChecksBeforeDialog` 设置是一个极为值得深究的精妙细节。能够弹出提示的后台智能体（冒泡模式）会在真正打扰用户之前，强制等待分类器和权限 Hook 先行完成裁决。这意味着只有在自动化机制确实无法拿准的真正模糊地带，用户才会被偶尔打断。在同时并发运行着五个后台智能体的多智能体系统中，这一细节直接决定了产品体验是令人赏心悦目的高效协作，还是令人抓狂崩溃的弹窗轰炸。

### 维度 4：它与父智能体的关系如何？

同步智能体会阻塞父智能体并共享其响应式状态。异步智能体独立自由运转，持有专属的中止控制器。分叉智能体则完整继承父智能体的全部会话上下文。这一选择同时塑造了最终用户的交互体验（父级是否陷入等待？）以及系统的运行时表现（按 Escape 键究竟会不会连带杀死子级？）。

步骤 8 中关于 AbortController 的架构抉择鲜明地体现了这一点：同步智能体共享父级控制器（Escape 键全杀），异步智能体持有独立控制器（Escape 键只打断父级，子级后台继续）。分叉智能体更进一步——全盘继承父级的系统 Prompt、工具数组与消息历史，以追求 Prompt 缓存共享的最大化。每一种从属关系都对应着清晰的工业场景：同步对应于串行委托（“去把这个搞定，然后我接着干”），异步对应于并行开拓（“你在后台搞这个，我前台继续推进其他事”），而分叉则对应于重上下文委托（“你已经通晓了我所知晓的一切，立刻去把这部分攻克”）。

### 维度 5：它的运行成本如何？

模型的选型、思考配置（thinking config）以及上下文规模共同决定了实际运行成本。廉价的只读工作首选 Haiku。中等强度的任务选配 Sonnet。需要与父智能体具备同等严谨推理深度的任务则采用继承。对于非分叉智能体，直接强行关闭思考能力，以遏制输出 Token 的成本膨胀——父智能体负责支付昂贵的深度思考开销，子智能体聚焦于雷厉风行地执行。

在多智能体系统设计中，经济维度的考量往往容易被视作琐碎细节，但它在 Claude Code 的宏观架构中始终占据着居安思危的核心地位。对于单次调用而言，一个使用 Opus 而非 Haiku 的 Explore 智能体当然能把工作做得漂亮。但在每周 3400 万次调用的汪洋大海中，模型级别的差异会转化为倍增的成本海啸。单次调用为 Explore 省下 135 个字符的单发优化，在宏观层面上直接折算为每周少消耗 46 亿个字符的 Prompt Token。这些绝不是微不足道的雕虫小技——这是决定一款工程产品在商业上能够实现规模化盈利，还是因入不敷出而走向毁灭的生死鸿沟。

### 统一的生命周期

`runAgent()` 生命周期通过其严丝合缝的十五个步骤完整实现了上述五个维度，利用同一套高度模块化的构建积木，为每一种截然不同的智能体类型组装出独特的专属执行环境。其最终呈现出的系统面貌表明，衍生一个子智能体绝非轻率地“再运行一份父智能体的副本”。它是一次**精准划定作用域、严格受控资源消耗且深度隔离的执行环境的受控分娩**——针对手头任务量身定制，并在任务达成之后迅速彻底地清理退场。

其架构的精妙绝伦之处，恰恰在于其极致的高度统一。无论是 Haiku 驱动的只读检索者，还是拥有全套工具访问权和冒泡权限的 Opus 驱动分叉子智能体，它们全部流经这完全相同的十五个步骤。生命周期的步骤本身从不因智能体类型的不同而产生杂乱的分支硬编码——它们完全依赖参数化驱动。模型解析步骤决定了正确的模型；上下文准备步骤匹配了正确的文件状态；权限隔离步骤应用了正确的安全模式。智能体的类型并非固化在控制流的分支逻辑中，而是解耦表达在声明式配置中。这正是该系统具备无限扩展潜力的秘密所在：**新增一个智能体类型仅仅意味着撰写一份声明定义，而完全无需对底层生命周期动一刀一剪。**

### 设计空间总结

六种内置智能体构成了一个层次分明的完整光谱：

| 智能体 | 模型 | 工具集 | 上下文 | 同步/异步 | 设计初衷 |
|-------|-------|-------|---------|------------|---------|
| 通用智能体 (General-Purpose) | 默认 | 全部工具 | 完整上下文 | 均可 | 承担通用任务的常规委托 |
| 探索智能体 (Explore) | Haiku | 仅限只读 | 精简剔除 | 同步 | 极速、廉价的代码库检索 |
| 规划智能体 (Plan) | 继承 | 仅限只读 | 精简剔除 | 同步 | 严谨的软件架构与实施设计 |
| 验证智能体 (Verification) | 继承 | 仅限只读 | 完整上下文 | 始终异步 | 独立的对抗性测试与排错 |
| 指南智能体 (Guide) | Haiku | 读 + 网页 | 动态感知 | 同步 | 官方文档与配置查询 |
| 状态栏配置 (Statusline) | Sonnet | 读 + 编辑 | 极简 | 同步 | 专注终端状态栏专项配置 |

没有任意两个智能体在这五个维度上的选择是完全雷同的。每一个都针对其专属的细分战场进行了极致调优。而 `runAgent()` 生命周期凭借同一套严密的十五个步骤，在智能体定义的参数化驱动下将它们全部驾驭自如。这就是这套架构的工业美感所在：**生命周期是一台通用的万能母机，而智能体定义则是运行在这台母机上的精巧程序。**

下一章我们将深入剖析分叉智能体——这一使大规模并行委托在经济成本上真正具备现实可行性的 Prompt 缓存压榨利器。随后的第 10 章将系统阐述整个编排层的全貌：异步智能体如何通过任务状态机上报实时进展、父智能体如何统一收集最终成果，以及协调者模式如何调度数十个智能体协同作战以攻克宏大目标。如果说本章的核心在于如何*创造*智能体，那么第 9 章就在于如何让它们变得极其*廉价*，而第 10 章则在于如何高效*管理*它们。
