import { useEffect, useRef, useState, useCallback } from "react";
import * as d3 from "d3";

// --- Data ---

interface GraphNode extends d3.SimulationNodeDatum {
  id: string;
  label: string;
  description: string;
  href?: string;
  primary: boolean;
}

interface GraphLink extends d3.SimulationLinkDatum<GraphNode> {
  label: string;
}

const nodes: GraphNode[] = [
  {
    id: "query-loop",
    label: "Query Loop",
    description:
      "The async generator that drives everything. Streams model output, executes tools, manages context.",
    href: "/ch05-agent-loop/",
    primary: true,
  },
  {
    id: "tool-system",
    label: "Tool System",
    description:
      "40+ tools with a 14-step execution pipeline. Permission system, result budgeting.",
    href: "/ch06-tools/",
    primary: true,
  },
  {
    id: "tasks",
    label: "Tasks",
    description:
      "Sub-agents and background work. State machine: pending, running, completed/failed.",
    href: "/ch10-coordination/",
    primary: true,
  },
  {
    id: "state-layer",
    label: "State Layer",
    description:
      "Two-tier: Bootstrap STATE (mutable singleton) + AppState (reactive store).",
    href: "/ch03-state/",
    primary: true,
  },
  {
    id: "hooks",
    label: "Hooks",
    description:
      "27 lifecycle events. Config frozen at startup. Can block tools, modify results, force continuation.",
    href: "/ch12-extensibility/",
    primary: true,
  },
  {
    id: "memory",
    label: "Memory",
    description:
      "File-based with LLM-powered recall. 4 types: user, feedback, project, reference.",
    href: "/ch11-memory/",
    primary: true,
  },
  {
    id: "user",
    label: "User",
    description: "The developer interacting with the CLI.",
    primary: false,
  },
  {
    id: "repl",
    label: "REPL",
    description: "The terminal interface. Handles input, rendering, permissions.",
    href: "/ch13-terminal-ui/",
    primary: false,
  },
];

const links: GraphLink[] = [
  { source: "user", target: "repl", label: "input" },
  { source: "repl", target: "query-loop", label: "prompts" },
  { source: "query-loop", target: "tool-system", label: "tool calls" },
  { source: "tool-system", target: "query-loop", label: "tool results" },
  { source: "query-loop", target: "tasks", label: "spawns" },
  { source: "tasks", target: "query-loop", label: "own query loop" },
  { source: "tasks", target: "repl", label: "bubble permissions" },
  { source: "query-loop", target: "hooks", label: "fires events" },
  { source: "hooks", target: "tool-system", label: "PreToolUse / PostToolUse" },
  { source: "hooks", target: "query-loop", label: "Stop hooks" },
  { source: "query-loop", target: "state-layer", label: "reads/writes" },
  { source: "state-layer", target: "query-loop", label: "bootstrap singleton" },
  { source: "state-layer", target: "repl", label: "reactive store" },
  {
    source: "memory",
    target: "query-loop",
    label: "injected at session start",
  },
];

const zhNodeData: Record<string, { label: string; description: string }> = {
  "query-loop": {
    label: "查询循环 (Query Loop)",
    description: "驱动整个系统的核心异步生成器。负责模型输出流处理、工具执行与上下文生命周期管理。",
  },
  "tool-system": {
    label: "工具系统 (Tool System)",
    description: "40+ 工具与 14 步严格防护流水线。内置权限决策系统与结果动态预算控制。",
  },
  tasks: {
    label: "任务与子智能体 (Tasks)",
    description: "子智能体 (Sub-agents) 与后台异步协作。状态机：pending、running、completed/failed。",
  },
  "state-layer": {
    label: "状态层 (State Layer)",
    description: "双层状态架构：Bootstrap STATE（可变单例）+ AppState（响应式响应树）。",
  },
  hooks: {
    label: "钩子系统 (Hooks)",
    description: "27 个核心生命周期事件。启动期冻结不可变快照，可拦截工具、修改调用结果并强行推进。",
  },
  memory: {
    label: "记忆系统 (Memory)",
    description: "基于纯文本 Markdown 配合 LLM 智能召回。4 类记忆模型：用户、反馈、项目、参考。",
  },
  user: {
    label: "开发者 (User)",
    description: "在终端通过命令行与智能体进行深度交互的开发者。",
  },
  repl: {
    label: "REPL 终端",
    description: "终端界面展示层。负责键盘协议解析、双缓冲帧调度、交互展示与权限弹窗。",
  },
};

// --- Component ---

interface Props {
  className?: string;
  lang?: "en" | "zh";
}

export default function ArchitectureExplorer({ className, lang }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const simulationRef = useRef<d3.Simulation<GraphNode, GraphLink> | null>(
    null,
  );
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<{
    x: number;
    y: number;
    node: GraphNode;
  } | null>(null);
  const [isDark, setIsDark] = useState(false);

  const isZh = lang
    ? lang === "zh"
    : typeof document !== "undefined"
      ? document.documentElement.lang.startsWith("zh") ||
        window.location.pathname.includes("/zh/") ||
        window.location.pathname.endsWith("/zh") ||
        window.location.pathname === "/"
      : false;

  // Detect dark mode
  useEffect(() => {
    const check = () =>
      setIsDark(document.documentElement.classList.contains("dark"));
    check();
    window.addEventListener("theme-changed", check);
    // Also listen for class changes (MutationObserver)
    const observer = new MutationObserver(check);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => {
      window.removeEventListener("theme-changed", check);
      observer.disconnect();
    };
  }, []);

  const colors = {
    nodePrimary: "#d97757",
    nodeSecondary: "#87867f",
    edge: isDark ? "rgba(194,192,182,0.3)" : "rgba(194,192,182,0.6)",
    edgeHighlight: "#d97757",
    text: isDark ? "#f5f4ed" : "#141413",
    textSecondary: isDark ? "#87867f" : "#87867f",
    tooltipBg: isDark ? "#1e1e1c" : "#ffffff",
    tooltipBorder: isDark ? "#333" : "#c2c0b6",
  };

  const getConnectedLinks = useCallback(
    (nodeId: string) => {
      return links.filter(
        (l) =>
          (typeof l.source === "string" ? l.source : (l.source as GraphNode).id) === nodeId ||
          (typeof l.target === "string" ? l.target : (l.target as GraphNode).id) === nodeId,
      );
    },
    [],
  );

  const getConnectedNodeIds = useCallback(
    (nodeId: string) => {
      const connected = new Set<string>();
      connected.add(nodeId);
      for (const l of links) {
        const sid = typeof l.source === "string" ? l.source : (l.source as GraphNode).id;
        const tid = typeof l.target === "string" ? l.target : (l.target as GraphNode).id;
        if (sid === nodeId) connected.add(tid);
        if (tid === nodeId) connected.add(sid);
      }
      return connected;
    },
    [],
  );

  useEffect(() => {
    if (!svgRef.current || !containerRef.current) return;

    const container = containerRef.current;
    const rect = container.getBoundingClientRect();
    const width = rect.width;
    const height = Math.max(500, Math.min(600, width * 0.65));

    const svg = d3
      .select(svgRef.current)
      .attr("width", width)
      .attr("height", height)
      .attr("viewBox", `0 0 ${width} ${height}`);

    // Clear previous
    svg.selectAll("*").remove();

    // Defs for arrow markers
    const defs = svg.append("defs");
    defs
      .append("marker")
      .attr("id", "arrow")
      .attr("viewBox", "0 -5 10 10")
      .attr("refX", 28)
      .attr("refY", 0)
      .attr("markerWidth", 6)
      .attr("markerHeight", 6)
      .attr("orient", "auto")
      .append("path")
      .attr("d", "M0,-4L10,0L0,4")
      .attr("fill", colors.edge);

    defs
      .append("marker")
      .attr("id", "arrow-highlight")
      .attr("viewBox", "0 -5 10 10")
      .attr("refX", 28)
      .attr("refY", 0)
      .attr("markerWidth", 6)
      .attr("markerHeight", 6)
      .attr("orient", "auto")
      .append("path")
      .attr("d", "M0,-4L10,0L0,4")
      .attr("fill", colors.edgeHighlight);

    // Clone data for simulation (with localized content if Chinese)
    const simNodes: GraphNode[] = nodes.map((d) => {
      if (!isZh) return { ...d };
      const zh = zhNodeData[d.id];
      return {
        ...d,
        label: zh?.label ?? d.label,
        description: zh?.description ?? d.description,
      };
    });
    const simLinks: GraphLink[] = links.map((d) => ({ ...d }));

    // Force simulation
    const isMobile = width < 640;
    const nodeRadius = isMobile ? 20 : 26;
    const labelOffset = isMobile ? 28 : 34;

    const simulation = d3
      .forceSimulation(simNodes)
      .force(
        "link",
        d3
          .forceLink<GraphNode, GraphLink>(simLinks)
          .id((d) => d.id)
          .distance(isMobile ? 100 : 140),
      )
      .force("charge", d3.forceManyBody().strength(isMobile ? -400 : -600))
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force("collision", d3.forceCollide().radius(nodeRadius + 20))
      .force("x", d3.forceX(width / 2).strength(0.05))
      .force("y", d3.forceY(height / 2).strength(0.05));

    simulationRef.current = simulation;

    const g = svg.append("g");

    // Links
    const link = g
      .append("g")
      .selectAll("line")
      .data(simLinks)
      .join("line")
      .attr("class", "graph-link")
      .attr("stroke", colors.edge)
      .attr("stroke-width", 1.5)
      .attr("marker-end", "url(#arrow)");

    // Link labels
    const linkLabel = g
      .append("g")
      .selectAll("text")
      .data(simLinks)
      .join("text")
      .attr("class", "graph-link-label")
      .attr("text-anchor", "middle")
      .attr("dy", -6)
      .attr("fill", colors.textSecondary)
      .attr("font-size", isMobile ? "8px" : "10px")
      .attr("font-family", "var(--font-mono)")
      .attr("opacity", 0)
      .text((d) => d.label);

    // Node groups
    const node = g
      .append("g")
      .selectAll<SVGGElement, GraphNode>("g")
      .data(simNodes)
      .join("g")
      .attr("class", "graph-node")
      .style("cursor", (d) => (d.href ? "pointer" : "default"))
      .call(
        d3
          .drag<SVGGElement, GraphNode>()
          .on("start", (event, d) => {
            if (!event.active) simulation.alphaTarget(0.3).restart();
            d.fx = d.x;
            d.fy = d.y;
          })
          .on("drag", (event, d) => {
            d.fx = event.x;
            d.fy = event.y;
          })
          .on("end", (event, d) => {
            if (!event.active) simulation.alphaTarget(0);
            d.fx = null;
            d.fy = null;
          }),
      );

    // Node circles
    node
      .append("circle")
      .attr("r", (d) => (d.primary ? nodeRadius : nodeRadius * 0.7))
      .attr("fill", (d) => (d.primary ? colors.nodePrimary : colors.nodeSecondary))
      .attr("opacity", 0)
      .transition()
      .duration(800)
      .delay((_, i) => i * 100)
      .attr("opacity", 1);

    // Node labels
    node
      .append("text")
      .attr("text-anchor", "middle")
      .attr("dy", (d) => (d.primary ? labelOffset : labelOffset * 0.75))
      .attr("fill", colors.text)
      .attr("font-size", isMobile ? "10px" : "12px")
      .attr("font-weight", (d) => (d.primary ? "600" : "400"))
      .attr("font-family", "var(--font-serif)")
      .text((d) => d.label);

    // Node icon letters (abbreviated)
    node
      .append("text")
      .attr("text-anchor", "middle")
      .attr("dy", "0.35em")
      .attr("fill", "white")
      .attr("font-size", (d) => (d.primary ? (isMobile ? "12px" : "14px") : (isMobile ? "10px" : "12px")))
      .attr("font-weight", "700")
      .attr("font-family", "var(--font-mono)")
      .text((d) => {
        const abbrevMap: Record<string, string> = {
          "query-loop": "QL",
          "tool-system": "TS",
          tasks: "TK",
          "state-layer": "SL",
          hooks: "HK",
          memory: "MM",
          user: "U",
          repl: "R",
        };
        return abbrevMap[d.id] || d.label[0];
      });

    // Hover interactions
    node
      .on("mouseenter", (event, d) => {
        setHoveredNode(d.id);
        const svgRect = svgRef.current!.getBoundingClientRect();
        setTooltip({
          x: event.clientX - svgRect.left,
          y: event.clientY - svgRect.top - 10,
          node: d,
        });

        const connected = getConnectedNodeIds(d.id);

        // Dim non-connected nodes
        node.select("circle").transition().duration(200)
          .attr("opacity", (n: unknown) => connected.has((n as GraphNode).id) ? 1 : 0.2);
        node.selectAll("text").transition().duration(200)
          .attr("opacity", (n: unknown) => connected.has((n as GraphNode).id) ? 1 : 0.2);

        // Highlight connected links
        link.transition().duration(200)
          .attr("stroke", (l: GraphLink) => {
            const sid = (l.source as GraphNode).id;
            const tid = (l.target as GraphNode).id;
            return sid === d.id || tid === d.id
              ? colors.edgeHighlight
              : colors.edge;
          })
          .attr("stroke-width", (l: GraphLink) => {
            const sid = (l.source as GraphNode).id;
            const tid = (l.target as GraphNode).id;
            return sid === d.id || tid === d.id ? 2.5 : 1;
          })
          .attr("opacity", (l: GraphLink) => {
            const sid = (l.source as GraphNode).id;
            const tid = (l.target as GraphNode).id;
            return sid === d.id || tid === d.id ? 1 : 0.15;
          })
          .attr("marker-end", (l: GraphLink) => {
            const sid = (l.source as GraphNode).id;
            const tid = (l.target as GraphNode).id;
            return sid === d.id || tid === d.id
              ? "url(#arrow-highlight)"
              : "url(#arrow)";
          });

        // Show connected link labels
        linkLabel.transition().duration(200)
          .attr("opacity", (l: GraphLink) => {
            const sid = (l.source as GraphNode).id;
            const tid = (l.target as GraphNode).id;
            return sid === d.id || tid === d.id ? 1 : 0;
          });
      })
      .on("mousemove", (event) => {
        const svgRect = svgRef.current!.getBoundingClientRect();
        setTooltip((prev) =>
          prev
            ? {
                ...prev,
                x: event.clientX - svgRect.left,
                y: event.clientY - svgRect.top - 10,
              }
            : null,
        );
      })
      .on("mouseleave", () => {
        setHoveredNode(null);
        setTooltip(null);

        // Reset
        node.select("circle").transition().duration(200).attr("opacity", 1);
        node.selectAll("text").transition().duration(200).attr("opacity", 1);
        link
          .transition()
          .duration(200)
          .attr("stroke", colors.edge)
          .attr("stroke-width", 1.5)
          .attr("opacity", 1)
          .attr("marker-end", "url(#arrow)");
        linkLabel.transition().duration(200).attr("opacity", 0);
      })
      .on("click", (_, d) => {
        if (d.href) {
          const rawBase = (import.meta as Record<string, unknown>).env && typeof (import.meta as Record<string, Record<string, unknown>>).env.BASE_URL === 'string'
            ? (import.meta as Record<string, Record<string, string>>).env.BASE_URL
            : '/';
          const base = rawBase.endsWith("/") ? rawBase : rawBase + "/";
          const cleanHref = d.href.replace(/^\//, "");
          const targetPath = isZh ? `zh/${cleanHref}` : cleanHref;
          window.location.href = base + targetPath;
        }
      });

    // Tick
    simulation.on("tick", () => {
      // Constrain nodes within bounds
      for (const d of simNodes) {
        d.x = Math.max(nodeRadius + 10, Math.min(width - nodeRadius - 10, d.x!));
        d.y = Math.max(nodeRadius + 10, Math.min(height - nodeRadius - 10, d.y!));
      }

      link
        .attr("x1", (d) => (d.source as GraphNode).x!)
        .attr("y1", (d) => (d.source as GraphNode).y!)
        .attr("x2", (d) => (d.target as GraphNode).x!)
        .attr("y2", (d) => (d.target as GraphNode).y!);

      linkLabel
        .attr("x", (d) => ((d.source as GraphNode).x! + (d.target as GraphNode).x!) / 2)
        .attr("y", (d) => ((d.source as GraphNode).y! + (d.target as GraphNode).y!) / 2);

      node.attr("transform", (d) => `translate(${d.x},${d.y})`);
    });

    // Resize handler
    const handleResize = () => {
      const newRect = container.getBoundingClientRect();
      const newWidth = newRect.width;
      const newHeight = Math.max(500, Math.min(600, newWidth * 0.65));
      svg.attr("width", newWidth).attr("height", newHeight).attr("viewBox", `0 0 ${newWidth} ${newHeight}`);
      simulation.force("center", d3.forceCenter(newWidth / 2, newHeight / 2));
      simulation.force("x", d3.forceX(newWidth / 2).strength(0.05));
      simulation.force("y", d3.forceY(newHeight / 2).strength(0.05));
      simulation.alpha(0.3).restart();
    };

    window.addEventListener("resize", handleResize);

    return () => {
      simulation.stop();
      window.removeEventListener("resize", handleResize);
    };
  }, [isDark, colors.edge, colors.edgeHighlight, colors.nodePrimary, colors.nodeSecondary, colors.text, colors.textSecondary, getConnectedNodeIds]);

  return (
    <div ref={containerRef} className={className} style={{ position: "relative" }}>
      <svg
        ref={svgRef}
        style={{
          width: "100%",
          minHeight: 500,
          overflow: "visible",
        }}
      />
      {/* Tooltip */}
      {tooltip && (
        <div
          style={{
            position: "absolute",
            left: tooltip.x,
            top: tooltip.y,
            transform: "translate(-50%, -100%)",
            background: colors.tooltipBg,
            border: `1px solid ${colors.tooltipBorder}`,
            borderRadius: 8,
            padding: "10px 14px",
            maxWidth: 240,
            pointerEvents: "none",
            zIndex: 10,
            boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
          }}
        >
          <div
            style={{
              fontWeight: 600,
              fontSize: 13,
              color: colors.text,
              marginBottom: 4,
              fontFamily: "var(--font-serif)",
            }}
          >
            {tooltip.node.label}
          </div>
          <div
            style={{
              fontSize: 12,
              color: colors.textSecondary,
              lineHeight: 1.4,
              fontFamily: "var(--font-serif)",
            }}
          >
            {tooltip.node.description}
          </div>
          {tooltip.node.href && (
            <div
              style={{
                fontSize: 11,
                color: "#d97757",
                marginTop: 6,
                fontFamily: "var(--font-mono)",
              }}
            >
              {isZh ? "点击阅读该章节 →" : "Click to read chapter"}
            </div>
          )}
        </div>
      )}
      {/* Legend */}
      <div
        style={{
          display: "flex",
          gap: 16,
          justifyContent: "center",
          marginTop: 8,
          fontSize: 12,
          color: colors.textSecondary,
          fontFamily: "var(--font-serif)",
          flexWrap: "wrap",
        }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: "50%",
              background: "#d97757",
              display: "inline-block",
            }}
          />
          {isZh ? "核心抽象" : "Core abstraction"}
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: "50%",
              background: "#87867f",
              display: "inline-block",
            }}
          />
          {isZh ? "交互接口" : "Interface"}
        </span>
        <span>
          {isZh
            ? "拖拽节点自由探索 · 悬停查看详情 · 点击直达章节"
            : "Drag nodes to explore. Hover for details. Click to read."}
        </span>
      </div>
    </div>
  );
}
