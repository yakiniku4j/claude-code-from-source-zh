# 第 6 章：工具 —— 从定义到执行

## 神经系统

第 5 章展示了 Agent 循环 —— 那个负责以流式方式处理模型响应、收集工具调用并将结果回传的 `while(true)`。如果说循环是系统跳动的心脏，那么倘若没有神经系统将“模型想要运行 `git status`”转化为带有权限检查、结果预算与错误处理机制的真实 Shell 命令，心跳本身也将失去意义。

工具系统正是这套神经系统。它涵盖了 40 多个具体工具实现、一个受特性开关（feature-flag）门控的中心化注册中心、一个严密的 14 步执行流水线、一个拥有七种模式的权限解析器，以及一个能够在模型输出完毕之前就提前启动工具执行的流式执行器。

Claude Code 中的每一次工具调用 —— 无论是读取文件、执行 Shell 命令、进行 Grep 检索，还是分派子智能体 —— 都流经同一条流水线。高度的统一性正是其设计精髓所在：无论该工具是内置的 Bash 执行器还是第三方的 MCP 服务端，它都会经过完全相同的模式校验、相同的权限审查、相同的结果预算控制以及相同的错误分类归因。

`Tool` 接口定义了大约 45 个成员。这听起来令人望而生畏，但对于理解系统如何运转而言，真正关键的核心成员只有五个：

1. **`call()`** —— 真正执行工具
2. **`inputSchema`** —— 校验并解析输入参数
3. **`isConcurrencySafe()`** —— 该操作是否可以并行运行？
4. **`checkPermissions()`** —— 该操作是否被允许执行？
5. **`validateInput()`** —— 输入参数在语义层面是否合理？

其余的一切 —— 包括 12 个渲染方法、遥测分析钩子、搜索提示词等 —— 都是为了服务于 UI 展示与遥测监控层。从这五个核心方法入手，其余部分便能迎刃而解。

---

## Tool 接口设计

### 三个类型参数

每一个工具都由三个类型参数进行泛型化约束：

```typescript
Tool<Input extends AnyObject, Output, P extends ToolProgressData>
```

`Input` 是一个承担着双重使命的 Zod 对象 Schema：它一方面用于生成发送给 API 的 JSON Schema（以便模型知晓应当提供哪些参数），另一方面在运行时通过 `safeParse` 对模型的实际响应进行强类型校验。`Output` 是工具执行结果的 TypeScript 返回类型。`P` 是工具在运行期间发出的进度事件类型 —— 例如 BashTool 会发出 stdout 数据块，GrepTool 会发出匹配计数，AgentTool 则会发出子智能体的执行记录（transcripts）。

### buildTool() 与安全闭环默认值 (Fail-Closed Defaults)

没有任何工具定义会直接手工构造一个 `Tool` 对象。每一个工具都必须经过 `buildTool()` 工厂函数，该工厂将工具特有的定义覆盖在一个默认值对象之上：

```typescript
// 伪代码 —— 说明安全闭环默认值模式
const SAFE_DEFAULTS = {
  isEnabled:         () => true,
  isParallelSafe:    () => false,   // 故障闭环 (Fail-closed)：新工具默认串行运行
  isReadOnly:        () => false,   // 故障闭环：默认视为写操作
  isDestructive:     () => false,
  checkPermissions:  (input) => ({ behavior: 'allow', updatedInput: input }),
}

function buildTool(definition) {
  return { ...SAFE_DEFAULTS, ...definition }  // 具体定义覆盖默认值
}
```

在涉及系统安全的关键维度上，这些默认配置被刻意设计为故障闭环（fail-closed，即默认拒绝/默认最安全）。一个新工具如果忘记实现 `isConcurrencySafe`，默认值为 `false` —— 它只能串行执行，绝不并行；如果忘记声明 `isReadOnly`，默认值为 `false` —— 系统一律将其视为具有副作用的写操作；如果忘记实现 `toAutoClassifierInput`，默认返回空字符串 —— 自动模式安全分类器会直接跳过它，这意味着必须由通用权限系统进行人工把关，绝不可能自动绕过。

唯一*未采用*故障闭环的默认值是 `checkPermissions`，它默认返回 `allow`。初看之下这似乎与安全原则相悖，但当你理解了分层权限模型后就会明白：`checkPermissions` 是特定于工具本身的校验逻辑，它在通用权限系统已经评估完规则、Hook 以及基于模式的策略*之后*才会运行。工具在 `checkPermissions` 中返回 `allow` 仅仅代表“我作为工具本身没有特殊的反对意见” —— 它绝不代表授予无限制的通行权。将其按子对象进行分组（如 `options`、以及类似 `readFileState` 的具名字段）既提供了专用接口的良好结构，又避免了在 40 多个调用点中声明、实现和传递五个独立接口类型的冗余仪式感。

### 并发安全性取决于输入内容

函数签名 `isConcurrencySafe(input: z.infer<Input>): boolean` 之所以接收已解析的输入作为参数，是因为同一个工具在面对不同输入时的安全特性截然不同。BashTool 是最典型的代表：`ls -la` 是只读且并发安全的，而 `rm -rf /tmp/build` 则绝非如此。该工具会解析命令行，将每个子命令对照已知安全集合进行分类，只有当命令中的每一个非中性部分均为搜索或只读操作时，才会返回 `true`。

### ToolResult 返回类型

每一个 `call()` 均返回一个 `ToolResult<T>`：

```typescript
type ToolResult<T> = {
  data: T
  newMessages?: (UserMessage | AssistantMessage | AttachmentMessage | SystemMessage)[]
  contextModifier?: (context: ToolUseContext) => ToolUseContext
}
```

`data` 是类型化的输出数据，会被序列化为 API 的 `tool_result` 内容块。`newMessages` 允许工具向对话中注入额外的消息 —— AgentTool 便利用该机制追加子智能体的执行记录。`contextModifier` 是一个可以修改后续工具所使用的 `ToolUseContext` 的函数 —— `EnterPlanMode` 正是通过该机制切换权限模式的。需要注意的是，上下文修改器仅对非并发安全（串行执行）的工具生效；如果你的工具是以并行方式运行的，其修改器将被排队暂存，直到整批并行执行全部完成。

---

## ToolUseContext：上帝对象 (God Object)

`ToolUseContext` 是贯穿每一次工具调用的庞大上下文包裹。它包含了大约 40 个字段。依照任何合理的软件工程定义，它都是一个典型的“上帝对象（god object）”。然而它的存在是因为替代方案更加糟糕。

一个像 BashTool 这样的工具需要访问 abort controller、文件状态缓存、应用状态、消息历史、工具集、MCP 连接以及半打 UI 回调函数。如果将这些作为独立参数一一传递，函数的形参列表将膨胀到 15 个以上。最务实的解法便是采用单一上下文对象，并按关注点进行模块化分组：

**配置信息**（`options` 子对象）：工具集、模型名称、MCP 连接、调试标志等。在查询开始时一次性设定，基本不可变。

**执行状态**：用于取消操作的 `abortController`、用于 LRU 文件缓存的 `readFileState`、保存完整对话历史的 `messages` 等。这些状态在执行过程中会动态变化。

**UI 回调**：`setToolJSX`、`addNotification`、`requestPrompt` 等。仅在交互式（REPL）上下文中连线装配，SDK 与无头模式下保持未定义状态（undefined）。

**智能体上下文**：`agentId`、`renderedSystemPrompt`（用于分叉子智能体的冻结父级提示词 —— 重新渲染可能会因为特性开关预热的差异导致内容分歧，进而击穿缓存）。

`ToolUseContext` 在子智能体中的衍生变体尤其具有启发性。当 `createSubagentContext()` 为子智能体构建上下文时，它在哪些字段共享、哪些字段隔离上做出了深思熟虑的取舍：对于异步智能体，`setAppState` 被替换为空操作（no-op）；`localDenialTracking` 会获得一个崭新的独立对象；而 `contentReplacementState` 则从父级深克隆而来。每一个细微决策背后，都凝结着从生产事故中总结出的宝贵教训。

---

## 工具注册中心

### getAllBaseTools()：单一事实来源

`getAllBaseTools()` 函数返回当前进程中可能存在的所有工具的详尽清单。常驻工具排列在最前面，随后是受特性开关门控的条件引入工具：

```typescript
const SleepTool = feature('PROACTIVE') || feature('KAIROS')
  ? require('./tools/SleepTool/SleepTool.js').SleepTool
  : null
```

来自 `bun:bundle` 的 `feature()` 导入会在打包时完成静态解析。当 `feature('AGENT_TRIGGERS')` 静态求值为 false 时，打包器会彻底消除整个 `require()` 调用 —— 这种死代码消除（DCE）极大地压缩了最终二进制产物体积。

### assembleToolPool()：合并内置工具与 MCP 工具

最终送达模型的工具集合由 `assembleToolPool()` 组装生成：

1. 获取内置工具（经过拒绝规则过滤、REPL 模式隐藏判断以及 `isEnabled()` 检查）
2. 根据拒绝规则过滤 MCP 工具
3. 分别将各个分区按名称字母序排序
4. 拼接组合：内置工具（前缀部分）+ MCP 工具（后缀部分）

这种“先分别排序再拼接”的做法绝非出于代码美学偏好。API 服务器端会在最后一个内置工具之后设置一个 Prompt 缓存断点（prompt-cache breakpoint）。如果在所有工具上进行全局扁平排序，MCP 工具就会穿插进内置工具列表之中；如此一来，增加或删除一个 MCP 工具就会改变内置工具的相对位置，从而直接导致服务器端缓存大面积失效。

---

## 14 步执行流水线

`checkPermissionsAndCallTool()` 函数是将意图转化为实际行动的核心所在。每一次工具调用都必须严格经历以下 14 个步骤。

```mermaid
graph TD
    S1[1. 工具查找 (Tool Lookup)] --> S2[2. 中止检查 (Abort Check)]
    S2 --> S3[3. Zod 模式校验]
    S3 -->|校验失败| ERR1[输入校验错误]
    S3 -->|校验通过| S4[4. 语义校验 (Semantic Validation)]
    S4 -->|校验失败| ERR2[特定于工具的错误]
    S4 -->|校验通过| S5[5. 投机性启动分类器]
    S5 --> S6[6. 输入回填 - 克隆而非就地修改]
    S6 --> S7[7. PreToolUse 钩子]
    S7 -->|Hook 拒绝| ERR3[Hook 拒绝响应]
    S7 -->|Hook 停止| STOP[中止执行流程]
    S7 -->|校验通过| S8[8. 权限决策解析]
    S8 --> S9{9. 权限是否被拒绝？}
    S9 -->|是| ERR4[权限拒绝结果]
    S9 -->|否| S10[10. 工具真正执行]
    S10 --> S11[11. 结果预算控制]
    S11 --> S12[12. PostToolUse 钩子]
    S12 --> S13[13. 追加新消息]
    S13 --> S14[14. 错误分类与遥测]
    S14 --> DONE[工具结果 → 存入对话历史]

    S10 -->|抛出异常| S14

    style ERR1 fill:#f66
    style ERR2 fill:#f66
    style ERR3 fill:#f66
    style ERR4 fill:#f66
    style STOP fill:#f66
```

### 第 1-4 步：校验阶段 (Validation)

**工具查找（Tool Lookup）**：在别名匹配时会回退到 `getAllBaseTools()`，以兼容处理工具曾被重命名的旧会话记录。**中止检查（Abort Check）**：防止在 Ctrl+C 信号传播前已经排队的工具调用产生无谓的计算开销。**Zod 模式校验**：拦截参数类型不匹配问题；对于延迟加载的工具，错误信息中会自动追加先调用 ToolSearch 的提示。**语义校验（Semantic Validation）**：超越基础的 Schema 符合性 —— FileEditTool 会直接拒绝无任何改动的空编辑（no-op edits），BashTool 则会在 MonitorTool 可用时主动拦截独立的 `sleep` 命令。

### 第 5-6 步：准备阶段 (Preparation)

**投机性启动分类器（Speculative Classifier Start）**：针对 Bash 命令并行启动自动模式安全分类器，为主执行路径节省数百毫秒的宝贵时间。**输入回填（Input Backfill）**：深度克隆已解析的输入，并为 Hook 与权限系统注入派生字段（例如将 `~/foo.txt` 展开为绝对路径），同时完整保留原始输入以维持交互记录的稳定性。

### 第 7-9 步：权限把关阶段 (Permission)

**PreToolUse 钩子**：核心扩展机制 —— 它们可以做出权限裁决、修改输入参数、注入上下文，或者彻底中止执行。**权限决策解析（Permission Resolution）**：架起 Hook 与通用权限系统之间的桥梁 —— 如果 Hook 已经做出裁决，该裁决即为最终决定；否则由 `canUseTool()` 触发规则匹配、特定于工具的检查、基于模式的默认策略以及交互式终端确认。**权限拒绝处理（Permission Denied Handling）**：构建标准错误信息并执行 `PermissionDenied` 钩子。

### 第 10-14 步：执行与收尾阶段 (Execution and Cleanup)

**工具真正执行（Tool Execution）**：使用原始输入调用真正的 `call()`。**结果预算控制（Result Budgeting）**：将超大输出持久化至本地磁盘 `~/.claude/tool-results/{hash}.txt`，并在消息中替换为预览片段。**PostToolUse 钩子**：可以篡改 MCP 工具的输出或者阻止后续执行。**追加新消息（New Messages）**：将新消息（如子智能体记录、系统提醒）追加进对话。**错误分类与遥测（Error Handling）**：对错误进行精准分类以便遥测上报，从可能被混淆的代码中提取安全的字符串名称，并触发 OTel 事件。

---

## 权限管理系统

### 七种权限模式

| 模式名称 | 行为特征 |
|------|----------|
| `default` | 运行工具特定检查；对未识别的操作向用户弹出确认提示 |
| `acceptEdits` | 自动放行文件编辑；对其他写操作弹出提示 |
| `plan` | 纯只读模式 —— 拒绝所有写操作 |
| `dontAsk` | 凡是通常需要向用户弹窗询问的操作，一律自动拒绝（适用于后台智能体） |
| `bypassPermissions` | 放行所有操作，绝不弹窗询问 |
| `auto` | 使用执行记录分类器（transcript classifier）进行智能裁决（受特性开关控制） |
| `bubble` | 专用于子智能体的内部模式，将权限请求向上传递给父级上下文 |

### 权限裁决链

当一次工具调用进入权限决策解析时：

1. **Hook 裁决**：如果 PreToolUse 钩子已经明确返回了 `allow` 或 `deny`，该结果即为最终定论。
2. **规则匹配**：三大规则集 —— `alwaysAllowRules`、`alwaysDenyRules`、`alwaysAskRules` —— 针对工具名称及可选的内容模式进行匹配。例如 `Bash(git *)` 会匹配所有以 `git` 开头的 Bash 命令。
3. **特定于工具的检查**：调用工具自身的 `checkPermissions()` 方法。绝大多数工具返回 `passthrough`（直通）。
4. **基于模式的默认策略**：`bypassPermissions` 放行一切；`plan` 拒绝一切写入；`dontAsk` 拒绝一切可能弹窗的操作。
5. **交互式提示**：在 `default` 和 `acceptEdits` 模式下，未决决策会向用户展示确认提示框。
6. **Auto 模式分类器**：两阶段分类器（先由快速模型判断，模棱两可的情况再交由深度思考模型裁决）。

`safetyCheck` 变体包含一个 `classifierApprovable` 布尔字段：针对 `.claude/` 与 `.git/` 的编辑操作属于 `classifierApprovable: true`（罕见但偶有合法场景），而 Windows 路径绕过攻击尝试则属于 `classifierApprovable: false`（几乎必然是恶意对抗行为）。

### 权限规则与模式匹配

权限规则以 `PermissionRule` 对象的形式存储，包含三个组成部分：追溯规则来源的 `source`（如 userSettings、projectSettings、localSettings、cliArg、policySettings、session 等）、规则行为 `ruleBehavior`（allow、deny、ask），以及包含工具名和可选内容模式的 `ruleValue`。

`ruleContent` 字段支持高度细粒度的模式匹配。`Bash(git *)` 放行任何以 `git` 开头的 Bash 命令；`Edit(/src/**)` 仅放行发生在 `/src` 目录下的编辑；`Fetch(domain:example.com)` 仅允许抓取指定域名的网络内容。没有指定 `ruleContent` 的规则则会匹配该工具的所有调用。

BashTool 的权限匹配器通过 `parseForSecurity()`（一个 Bash AST 语法分析器）解析命令行，并将复合命令拆分为独立的子命令。如果 AST 解析失败（比如遇到了包含 heredoc 或深层嵌套子 shell 的复杂语法），匹配器将直接返回 `() => true` —— 采取故障安全策略，意味着安全 Hook 必须始终介入运行。其背后的设计哲学在于：如果一条命令复杂到无法被精确解析，那它就必然复杂到无法被放心地排除在安全审查之外。

### 子智能体的冒泡模式 (Bubble Mode)

在协调者-工作者（coordinator-worker）架构中，子智能体无法直接展示交互式权限提示 —— 因为它们没有独立的终端设备。`bubble`（冒泡）模式使得权限请求能够顺着层级链路向上冒泡传播至父级上下文。拥有终端访问权的协调者智能体（运行在主线程上）负责向用户展示弹窗，并将最终裁决结果原路下发给子智能体。

---

## 工具延迟加载 (Deferred Loading)

带有 `shouldDefer: true` 标记的工具在发送给 API 时会附带 `defer_loading: true` —— 仅发送工具名称与描述，而不包含完整的参数 Schema。这极大地压缩了初始提示词的体积。模型若要调用某个延迟加载的工具，必须首先调用 `ToolSearchTool` 加载其完整 Schema。此处的失败模式颇具教益：如果模型在未加载 Schema 的情况下直接强行调用延迟工具，Zod 校验将会失败（因为所有类型化参数都会被当成纯字符串传过来），此时系统会在错误信息中附带具有针对性的自愈修复提示。

延迟加载还能显著提高 Prompt 缓存命中率：带有 `defer_loading: true` 的工具仅仅向提示词贡献其名字，因此增删一个延迟加载的 MCP 工具只会让提示词改变寥寥几个 token，而不是动辄引入数百个 token 的剧烈变动。

---

## 结果预算控制 (Result Budgeting)

### 单工具大小上限

每个工具都会声明其 `maxResultSizeChars`：

| 工具名称 | maxResultSizeChars | 设计考量 |
|------|-------------------|-----------|
| BashTool | 30,000 | 足以容纳绝大多数有价值的命令行输出 |
| FileEditTool | 100,000 | Diff 差异可能非常大，但模型必须看到完整修改 |
| GrepTool | 100,000 | 带有上下文行的检索结果极易快速累积膨胀 |
| FileReadTool | Infinity | 通过自身的 Token 阈值进行自我限制；持久化会导致 Read 死循环 |

当工具的执行结果超出该阈值时，完整内容会被持久化保存至磁盘，而在消息中被替换为一个包含简略预览与文件路径的 `<persisted-output>` 包装块。如果模型后续确有需要，可以通过调用 `Read` 工具分段读取完整输出。

### 会话级累计聚合预算

除针对各个工具的独立限制外，`ContentReplacementState` 还会严密监控跨越整个对话历史的累计聚合预算，以防止“千刀万剐”式的上下文挤爆 —— 设想如果有许多个工具相继返回各自限额的 90%，它们的累加总和依然会迅速撑爆上下文窗口。

---

## 重点核心工具深度剖析

### BashTool：系统中最复杂的工具

BashTool 迄今为止是整个系统中最复杂的工具。它能够解析复合命令、将各个子命令区分为只读或写操作、管理后台常驻任务、通过魔数（magic bytes）嗅探图像二进制输出，甚至还实现了一套 sed 模拟器以提供安全的文件修改预览。

其中对复合命令的解析尤为精妙。`splitCommandWithOperators()` 将诸如 `cd /tmp && mkdir build && ls build` 这样的复合命令拆解为独立的子命令。每个子命令都会对照已知安全集合（`BASH_SEARCH_COMMANDS`、`BASH_READ_COMMANDS`、`BASH_LIST_COMMANDS`）进行安全判定。只有当复合命令中所有的非中性部分均为安全操作时，整个复合命令才会被判定为只读。中性集合（如 echo、printf）会被忽略 —— 它们不会让一条命令变成只读，但也不会直接将其归类为写操作。

特别值得关注的是 sed 模拟机制（`_simulatedSedEdit`）。当用户在权限确认对话框中批准某条 sed 命令时，系统会预先在沙箱中运行该 sed 命令捕获输出，提前算出修改结果。这个预先算好的结果会被作为 `_simulatedSedEdit` 注入到输入参数中。当 `call()` 真正执行时，它会直接将该预计算结果写入文件，彻底绕过底层的 Shell 重复执行。这就百分之百确保了用户在终端中预览到的内容与最终落盘的内容绝对一致 —— 杜绝了因文件在预览与执行之间的微小时间差内发生变化而导致二次执行产生不同结果的竞态隐患。

### FileEditTool：陈旧度检测 (Staleness Detection)

FileEditTool 与 `readFileState` 深度集成，后者是在整个对话期间维护的文件内容及时间戳 LRU 缓存。在应用任何编辑修改之前，工具都会先校验自模型上一次读取该文件以来，该文件是否曾在磁盘上被修改过。如果文件已变陈旧（stale）—— 无论是被后台进程、另一个工具还是用户本人在外部编辑器中改动过 —— 本次编辑都将被直接拒绝，并返回一条错误提示要求模型必须先重新读取该文件。

`findActualString()` 中的模糊匹配机制巧妙解决了模型经常把空白字符写错的常见痛点。它在匹配前会对空白字符和引号风格进行规范化，因此哪怕模型提供的 `old_string` 末尾多带了空格，依然能够精准命中文件中的实际内容。`replace_all` 标志位用于支持批量替换；若未声明该标志位，遇到多处非唯一匹配时工具会果断报错拒绝，强制要求模型提供更丰富的上下文以唯一锁定目标修改位置。

### FileReadTool：全能读取器

FileReadTool 是唯一一个将 `maxResultSizeChars` 设为 `Infinity` 的内置工具。如果 Read 的输出也持久化保存到磁盘上，模型为了看内容就不得不去 Read 那个持久化生成的文件，而读取该文件又可能再次超限，从而导致死循环。因此，该工具选择通过内置的 Token 估算机制进行自我边界约束，并在源头直接做智能截断。

该工具展现出了惊人的全能性：它不仅能读取带有行号的文本文件，还能读取图片（返回 base64 多模态内容块）、PDF（通过 `extractPDFPages()` 解析）、Jupyter Notebook（通过 `readNotebook()` 解析），以及目录结构（回退调用 `ls`）。它还会严密拦截危险的设备文件路径（如 `/dev/zero`、`/dev/random`、`/dev/stdin`），甚至还贴心地处理了 macOS 截图文件名中的特殊字符怪癖（如“Screen Shot”文件名中包含的 U+202F 窄不换行空格与常规空格的混淆问题）。

### GrepTool：基于 head_limit 的分页机制

GrepTool 封装了底层的 `ripGrep()`，并通过 `head_limit` 引入了分页机制。默认限制为 250 条记录 —— 这既保证了结果具备充分的实用价值，又避免了撑爆上下文。当发生截断时，响应中会明确标注 `appliedLimit: 250`，提示模型在下次调用时应传入 `offset` 进行分页查询。显式传入 `head_limit: 0` 则可彻底解除该限制。

GrepTool 会自动剔除六类版本控制系统（VCS）目录（`.git`、`.svn`、`.hg`、`.bzr`、`.jj`、`.sl`）。检索 `.git/objects` 内部内容几乎永远不是模型的真实本意，而且如果不小心把二进制的 pack 压缩文件扫了进来，瞬间就会将 Token 预算消耗殆尽。

### AgentTool 与上下文修改器

AgentTool 负责派生运行各自独立查询循环的子智能体。它的 `call()` 返回包含子智能体执行记录的 `newMessages`，并可选择性返回一个将状态变更反向同步给父级的 `contextModifier`。因为 AgentTool 默认非并发安全，所以单次响应中的多个 Agent 工具调用会按序串行执行 —— 每个子智能体的上下文修改器都会在下一个子智能体启动前生效应用。但在协调者（coordinator）模式下，模式发生了翻转：协调者会将独立的子任务分发给不同的子智能体，而 `isAgentSwarmsEnabled()` 检查则会解锁并行智能体执行集群能力。

---

## 工具与消息历史的交互机制

工具执行结果绝不仅仅是向模型返回简单的数据，它们会作为结构化消息深度参与到整个对话之中。

底层 API 要求工具结果必须以 `ToolResultBlockParam` 对象形式返回，并通过 ID 精确引用原始的 `tool_use` 块。绝大多数工具的结果被序列化为文本。FileReadTool 则可以序列化为图片内容块（base64 编码）以实现多模态响应。BashTool 会通过检查 stdout 的魔数自动识别图片输出，并智能切换为图片内容块。

`ToolResult.newMessages` 是工具打破简单“一问一答”模式、主动扩展对话的关键手段：

- **智能体执行记录**：AgentTool 将子智能体的完整消息历史作为附件消息（attachment messages）注入。
- **系统提醒 (System reminders)**：记忆相关工具会注入紧随工具结果之后的系统消息 —— 这些消息在下一轮对话中对模型可见，但在进入 `normalizeMessagesForAPI` 发送边界时会被自动剔除。
- **附件消息**：Hook 的执行结果、补充上下文以及详细错误信息都会携带结构化元数据，供模型在后续轮次中引用参考。

`contextModifier` 函数是工具修改后续执行环境的专用通道。当 `EnterPlanMode` 执行完毕时，它会返回一个将权限模式设置为 `'plan'` 的修改器；当 `ExitWorktree` 执行完毕时，它会修改当前的工作目录。这些修改器是工具影响后续工具执行的唯一合法途径 —— 直接就地突变（mutate）`ToolUseContext` 是绝对行不通的，因为在每次工具调用前上下文都会被浅拷贝复制。仅限串行执行的硬性约束正是由编排层强制保证的：试想若有两个并发工具同时试图修改工作目录，究竟应该以谁为准？

---

## 实战启发与应用：设计你的工具系统

**坚持故障闭环的默认值设计。** 新工具在被显式标注前必须遵循最保守的策略。开发者如果忘记配置某个开关，系统将自动回退到最安全的防御状态，而非危险的放行状态。

**根据输入动态判定安全性。** `isConcurrencySafe(input)` 与 `isReadOnly(input)` 应当接收已解析的输入作为实参，因为同一个工具在面对不同输入时的安全特征大相径庭。简单粗暴地将 BashTool 标记为“始终串行”虽然在安全性上挑不出毛病，却极大地扼杀了并发潜力。

**构建分层防御的权限架构。** 工具特异性检查、基于规则的模式匹配、基于模式的默认值、终端交互式弹窗以及自动化分类器各自解决不同维度的安全诉求，没有任何单一种机制足以包打天下。

**不仅要控制输入预算，更要严格控制结果预算。** 对模型输入的 Token 限制是行业标配，但工具返回的结果体积往往不可预测且会在多轮对话中持续累积。单工具大小限制能防止单点暴雷，而会话级聚合预算则能杜绝温水煮青蛙式的累积溢出。

**确保错误分类具备遥测安全性。** 在经过混淆压缩的代码中，`error.constructor.name` 往往会被重命名为无意义的字符。`classifyToolError()` 函数能够提取最具可读性且安全的特征字符串 —— 如遥测安全的消息、errno 错误码、稳定的规范化错误名称 —— 从而在保障遥测可观测性的同时，绝不在分析日志中意外泄露敏感的原始报错信息。

---

## 前瞻与后续演进

本章详尽阐述了单次工具调用如何从接口定义出发，历经参数校验、权限审查、底层执行以及结果预算控制的完整旅程。然而在真实场景中，模型极少一次只请求调用一个工具。如何将多个工具调用智能编排为兼具安全性与高性能的并发批次，正是第 7 章的核心主题。
