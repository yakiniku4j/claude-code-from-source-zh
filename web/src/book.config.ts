export interface PartConfig {
  number: number;
  title: string;
  epigraph: string;
  chapters: number[];
}

export interface ChapterConfig {
  number: number;
  slug: string;
  title: string;
  description: string;
}

export const parts: PartConfig[] = [
  {
    number: 1,
    title: 'Foundations',
    epigraph: 'Before the agent can think, the process must exist.',
    chapters: [1, 2, 3, 4],
  },
  {
    number: 2,
    title: 'The Core Loop',
    epigraph: 'The heartbeat of the agent: stream, act, observe, repeat.',
    chapters: [5, 6, 7],
  },
  {
    number: 3,
    title: 'Multi-Agent Orchestration',
    epigraph: 'One agent is powerful. Many agents working together are transformative.',
    chapters: [8, 9, 10],
  },
  {
    number: 4,
    title: 'Persistence and Intelligence',
    epigraph: 'An agent without memory makes the same mistakes forever.',
    chapters: [11, 12],
  },
  {
    number: 5,
    title: 'The Interface',
    epigraph: 'Everything the user sees passes through this layer.',
    chapters: [13, 14],
  },
  {
    number: 6,
    title: 'Connectivity',
    epigraph: 'The agent reaches beyond localhost.',
    chapters: [15, 16],
  },
  {
    number: 7,
    title: 'Performance Engineering',
    epigraph: 'Making it all fast enough that humans don\'t notice the machinery.',
    chapters: [17, 18],
  },
];

export const partsZh: PartConfig[] = [
  {
    number: 1,
    title: '第一部分：基础架构',
    epigraph: '在智能体思考之前，承载它的进程必须首先存在。',
    chapters: [1, 2, 3, 4],
  },
  {
    number: 2,
    title: '第二部分：核心循环',
    epigraph: '智能体的心跳节律：流式接收、自主行动、环境观察、迭代循环。',
    chapters: [5, 6, 7],
  },
  {
    number: 3,
    title: '第三部分：多智能体编排',
    epigraph: '单智能体已足够强大；多智能体协同将带来范式转变。',
    chapters: [8, 9, 10],
  },
  {
    number: 4,
    title: '第四部分：持久化与认知进化',
    epigraph: '没有记忆的智能体，将永远在同一个错误上跌倒。',
    chapters: [11, 12],
  },
  {
    number: 5,
    title: '第五部分：人机交互界面',
    epigraph: '用户所能感知的一切，都必须流经这一展示层。',
    chapters: [13, 14],
  },
  {
    number: 6,
    title: '第六部分：生态连接',
    epigraph: '让智能体突破本地单机的疆界。',
    chapters: [15, 16],
  },
  {
    number: 7,
    title: '第七部分：性能工程与思考',
    epigraph: '极致的系统调优，让复杂机制快到用户难以察觉。',
    chapters: [17, 18],
  },
];

export const chapters: ChapterConfig[] = [
  { number: 1, slug: 'ch01-architecture', title: 'The Architecture of an AI Agent', description: 'The 6 key abstractions, data flow, permission system, build system' },
  { number: 2, slug: 'ch02-bootstrap', title: 'Starting Fast — The Bootstrap Pipeline', description: '5-phase init, module-level I/O parallelism, trust boundary' },
  { number: 3, slug: 'ch03-state', title: 'State — The Two-Tier Architecture', description: 'Bootstrap singleton, AppState store, sticky latches, cost tracking' },
  { number: 4, slug: 'ch04-api-layer', title: 'Talking to Claude — The API Layer', description: 'Multi-provider client, prompt cache, streaming, error recovery' },
  { number: 5, slug: 'ch05-agent-loop', title: 'The Agent Loop', description: 'query.ts deep dive, 4-layer compression, error recovery, token budgets' },
  { number: 6, slug: 'ch06-tools', title: 'Tools — From Definition to Execution', description: 'Tool interface, 14-step pipeline, permission system' },
  { number: 7, slug: 'ch07-concurrency', title: 'Concurrent Tool Execution', description: 'Partition algorithm, streaming executor, speculative execution' },
  { number: 8, slug: 'ch08-sub-agents', title: 'Spawning Sub-Agents', description: 'AgentTool, 15-step runAgent lifecycle, built-in agent types' },
  { number: 9, slug: 'ch09-fork-agents', title: 'Fork Agents and the Prompt Cache', description: 'Byte-identical prefix trick, cache sharing, cost optimization' },
  { number: 10, slug: 'ch10-coordination', title: 'Tasks, Coordination, and Swarms', description: 'Task state machine, coordinator mode, swarm messaging' },
  { number: 11, slug: 'ch11-memory', title: 'Memory — Learning Across Conversations', description: 'File-based memory, 4-type taxonomy, LLM recall, staleness' },
  { number: 12, slug: 'ch12-extensibility', title: 'Extensibility — Skills and Hooks', description: 'Two-phase skill loading, lifecycle hooks, snapshot security' },
  { number: 13, slug: 'ch13-terminal-ui', title: 'The Terminal UI', description: 'Custom Ink fork, rendering pipeline, double-buffer, pools' },
  { number: 14, slug: 'ch14-input-interaction', title: 'Input and Interaction', description: 'Key parsing, keybindings, chord support, vim mode' },
  { number: 15, slug: 'ch15-mcp', title: 'MCP — The Universal Tool Protocol', description: '8 transports, OAuth for MCP, tool wrapping' },
  { number: 16, slug: 'ch16-remote', title: 'Remote Control and Cloud Execution', description: 'Bridge v1/v2, CCR, upstream proxy' },
  { number: 17, slug: 'ch17-performance', title: 'Performance — Every Millisecond and Token Counts', description: 'Startup, context window, prompt cache, rendering, search' },
  { number: 18, slug: 'ch18-epilogue', title: 'Epilogue — What We Learned', description: 'The 5 architectural bets, what transfers, where agents are heading' },
];

export const chaptersZh: ChapterConfig[] = [
  { number: 1, slug: 'ch01-architecture', title: '第 1 章：AI 智能体的架构设计', description: '六大核心抽象、端到端数据流、权限决策系统、Bun 构建系统' },
  { number: 2, slug: 'ch02-bootstrap', title: '第 2 章：极速起跑 —— Bootstrap 引导流水线', description: '五阶段启动流水线、模块级 I/O 并发重叠、信任边界机制' },
  { number: 3, slug: 'ch03-state', title: '第 3 章：状态管理 —— 双层架构设计', description: 'Bootstrap 单例、AppState 响应式 Store、防缓存击穿的五大粘性锁存器' },
  { number: 4, slug: 'ch04-api-layer', title: '第 4 章：与 Claude 对话 —— API 调用层', description: '多 Provider 统一客户端、Prompt 缓存前缀策略、流式底层解析与空闲看门狗' },
  { number: 5, slug: 'ch05-agent-loop', title: '第 5 章：Agent Loop 核心循环机制', description: 'query.ts 深度解析、四层上下文压缩体系、错误回注与 Token 预算控制' },
  { number: 6, slug: 'ch06-tools', title: '第 6 章：工具系统 —— 从定义到安全执行', description: 'Tool 统一接口、14 步严格防护流水线、输入相关并发安全、动态结果预算控制' },
  { number: 7, slug: 'ch07-concurrency', title: '第 7 章：并发工具执行与投机调度', description: '分区算法 (partitionToolCalls)、保序流式缓冲、流式投机执行' },
  { number: 8, slug: 'ch08-sub-agents', title: '第 8 章：衍生子智能体 (Sub-Agents)', description: 'AgentTool 动态 Schema、15 步 runAgent 生命周期、内置 Agent 全景剖析' },
  { number: 9, slug: 'ch09-fork-agents', title: '第 9 章：分叉智能体与 Prompt 缓存共享', description: '字节完全一致前缀技术、Prompt 缓存复用、降低 95% 输入 Token 开销' },
  { number: 10, slug: 'ch10-coordination', title: '第 10 章：任务、协调与集群 (Swarm)', description: '任务状态机、协调者模式 (Coordinator)、Swarm 邮箱与消息总线' },
  { number: 11, slug: 'ch11-memory', title: '第 11 章：记忆系统 —— 跨越会话的学习与积累', description: '纯文本 Markdown 存储哲学、四类型记忆分类法、轻量模型智能召回' },
  { number: 12, slug: 'ch12-extensibility', title: '第 12 章：可扩展性 —— 技能 (Skills) 与钩子 (Hooks)', description: '技能两阶段延迟加载、五大核心生命周期事件、退出码 2 硬拦截' },
  { number: 13, slug: 'ch13-terminal-ui', title: '第 13 章：终端 UI 架构与渲染引擎', description: 'Ink 定制优化、React Fiber 容器、七阶段双缓冲帧调度、对象池驻留' },
  { number: 14, slug: 'ch14-input-interaction', title: '第 14 章：输入处理与深度交互', description: '按键协议栈 (Kitty/xterm/VT/SGR)、组合键 Chord 状态机、Vim 模式纯函数状态机' },
  { number: 15, slug: 'ch15-mcp', title: '第 15 章：MCP —— 通用工具协议体系', description: '8 种传输层协议、基于 RFC 的 OAuth 动态发现、工具包装与属性映射' },
  { number: 16, slug: 'ch16-remote', title: '第 16 章：远程控制与云端执行', description: 'Bridge v1 轮询与 v2 长连接、非对称读写设计、直连模式与凭据保护代理' },
  { number: 17, slug: 'ch17-performance', title: '第 17 章：性能调优 —— 每一毫秒与每一个 Token 都至关重要', description: '8K/64K 槽位预留、粘性锁存器控成本、自适应 60fps/30fps 节流' },
  { number: 18, slug: 'ch18-epilogue', title: '第 18 章：结语与经验提炼 —— 我们的收获与思考', description: '五大核心架构抉择、系统复杂度的成本反思、智能体演进的四大未来方向' },
];

export function getParts(lang: 'en' | 'zh' = 'en'): PartConfig[] {
  return lang === 'zh' ? partsZh : parts;
}

export function getChapters(lang: 'en' | 'zh' = 'en'): ChapterConfig[] {
  return lang === 'zh' ? chaptersZh : chapters;
}

export function getPartForChapter(chapterNumber: number, lang: 'en' | 'zh' = 'en'): PartConfig | undefined {
  const currentParts = getParts(lang);
  return currentParts.find(p => p.chapters.includes(chapterNumber));
}

export function getChapterNumber(slug: string): number {
  const match = slug.match(/^ch(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

export function getAdjacentChapters(chapterNumber: number, lang: 'en' | 'zh' = 'en') {
  const currentChapters = getChapters(lang);
  const idx = currentChapters.findIndex(c => c.number === chapterNumber);
  return {
    prev: idx > 0 ? currentChapters[idx - 1] : null,
    next: idx < currentChapters.length - 1 ? currentChapters[idx + 1] : null,
  };
}

export function isFirstChapterOfPart(chapterNumber: number, lang: 'en' | 'zh' = 'en'): boolean {
  const currentParts = getParts(lang);
  return currentParts.some(p => p.chapters[0] === chapterNumber);
}
