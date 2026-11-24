window.__ModuleLoader__.load({ id: "@spinejit/dsh-spinejit", factory: (require) => {
var module = { exports: {} };
var exports = module.exports;
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client.ts
var client_exports = {};
__export(client_exports, {
  SpineDock: () => SpineDock,
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(client_exports);
var import_react = require("react");
var import_jsx_runtime2 = require("react/jsx-runtime");

// src/compact-format.ts
var COMPACT_CHECKPOINT_PREFIX = "Conversation checkpoint from SpineJIT /compact:\n\n";

// src/compact-stats.ts
function checkpoint(event) {
  if (event.type !== "user/message" || event.data.source.kind !== "spine-compact") return null;
  return { source: event.data.source, content: event.data.content };
}
var compactStatsDefinition = {
  kind: "spinejit.compact-stats",
  target: "stats",
  match(event) {
    return checkpoint(event)?.source.calls?.length ? { id: `spine-compact:${event.seq}`, role: "start" } : null;
  },
  start(_context, { event }, reader) {
    const message = checkpoint(event);
    if (message === null) return null;
    let turn = message.source.turn;
    if (turn === void 0) {
      const end = reader.previous("stats-turn-end")?.matches[0]?.event;
      if (end?.type !== "turn/end") return null;
      turn = end.data.turn;
    }
    const text = message.content.reduce((text2, block) => block.type === "text" ? text2 + block.text : text2, "");
    return {
      turn,
      calls: message.source.calls ?? [],
      summaryChars: text.startsWith(COMPACT_CHECKPOINT_PREFIX) ? text.length - COMPACT_CHECKPOINT_PREFIX.length : text.length,
      shadowedTokens: typeof message.source.shadowedTokens === "number" ? message.source.shadowedTokens : null
    };
  },
  update(context) {
    return context.state ?? null;
  },
  buildViewNode({ key, kind, id, start, state }) {
    if (start === void 0 || state == null) return null;
    const route = state.calls[0];
    if (route === void 0) return null;
    let context = 0;
    let output = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let reported = 0;
    let reportedRead = false;
    let reportedWrite = false;
    for (const { usage } of state.calls) {
      if (usage === void 0) continue;
      reported++;
      const read = usage.cacheReadTokens ?? 0;
      const write = usage.cacheWriteTokens ?? 0;
      context += usage.inputTokens + read + write;
      output += usage.outputTokens;
      cacheRead += read;
      cacheWrite += write;
      reportedRead ||= usage.cacheReadTokens !== void 0;
      reportedWrite ||= usage.cacheWriteTokens !== void 0;
    }
    const complete = reported === state.calls.length;
    return {
      key,
      kind,
      id,
      target: "stats",
      anchorSeq: start.event.seq,
      location: start.location,
      data: { kind: "compaction", metrics: {
        compactionId: id,
        turn: state.turn,
        startTime: start.event.time,
        endTime: null,
        wall: null,
        running: false,
        context: reported > 0 ? context : null,
        output: reported > 0 ? output : null,
        cacheHit: complete && reportedRead && context > 0 ? Math.min(1, cacheRead / context) : null,
        cacheRead: reportedRead ? cacheRead : null,
        cacheWrite: reportedWrite ? cacheWrite : null,
        provider: route.provider,
        model: route.model,
        shadowedTokens: state.shadowedTokens,
        summaryChars: state.summaryChars,
        error: null
      } }
    };
  }
};

// src/spawn-id.ts
var SPAWN_SUFFIX = /:spawn:(\d+(?:\.\d+)*)$/;
function spawnIdentity(id) {
  const match = SPAWN_SUFFIX.exec(id);
  if (match === null) return null;
  return { parent: id.slice(0, match.index), producer: match[1].split(".").map(Number) };
}

// src/worktree.ts
var import_jsx_runtime = require("react/jsx-runtime");

// node_modules/@spinejit/spine-sdk/dist/view/tree-style.js
function spineTreeSpawnOutcome(spawn) {
  return spawn !== null && typeof spawn === "object" ? spawn.arrived : null;
}

// src/tree.ts
var TREE_PROJECTION = "spinejit";
function showsTree(tree) {
  return tree?.nodes.some((node) => node.kind === "Task") === true;
}

// src/worktree.ts
var PRETTY_MAX_VISIBLE_SIBLINGS = 3;
var PRETTY_ACTIVE_PARENT_DEPTH = 3;
function webTreeItems(activeNodeId, nodes) {
  const byId = /* @__PURE__ */ new Map();
  const childrenByParent = /* @__PURE__ */ new Map();
  for (const node of nodes) {
    byId.set(node.nodeId, node);
    const siblings = childrenByParent.get(node.parentId);
    if (siblings) siblings.push(node);
    else childrenByParent.set(node.parentId, [node]);
  }
  if (!byId.has(activeNodeId)) return [];
  const { rootNodes, activePath, earlierBranchCount } = prettyViewport(activeNodeId, childrenByParent, byId);
  return prettyLevel(childrenByParent, activeNodeId, rootNodes, activePath, earlierBranchCount);
}
function prettyLevel(childrenByParent, activeNodeId, level, activePath, leadingHistoryCount = 0) {
  const items = prependHistory(prettySiblingItems(visibleNodes(childrenByParent, activeNodeId, level), activePath), leadingHistoryCount);
  return items.map((item) => {
    if (item.type === "history") return item;
    const children = childrenByParent.get(item.node.nodeId) ?? [];
    return {
      ...item,
      current: item.node.nodeId === activeNodeId,
      children: shouldCollapse(item.node, children.length > 0, activePath) ? [] : prettyLevel(childrenByParent, activeNodeId, children, activePath)
    };
  });
}
function prettyViewport(activeNodeId, childrenByParent, byId) {
  const pathNodes = activePathNodes(activeNodeId, byId);
  const activePath = new Set(pathNodes.map((node) => node.nodeId));
  const activeRoot = pathNodes[pathNodes.length - 1];
  const activeRootNodes = visibleNodes(childrenByParent, activeNodeId, [activeRoot]);
  let earlierBranchCount = 0;
  for (const node of childrenByParent.get(null) ?? []) {
    if (node.nodeId === activeRoot.nodeId)
      continue;
    for (const visible of visibleNodes(childrenByParent, activeNodeId, [node])) {
      if (isCompleted(visible))
        earlierBranchCount += 1;
    }
  }
  const visibleActivePath = pathNodes.filter((node) => {
    const children = childrenByParent.get(node.nodeId) ?? [];
    return !shouldElide(node, children.length > 0, node.nodeId === activeNodeId);
  });
  if (visibleActivePath.length <= PRETTY_ACTIVE_PARENT_DEPTH + 1) {
    return { rootNodes: activeRootNodes, earlierBranchCount, activePath };
  }
  const focusRoot = visibleActivePath[PRETTY_ACTIVE_PARENT_DEPTH];
  earlierBranchCount += completedOffPathCount(activeRootNodes, activePath);
  for (const ancestor of visibleActivePath.slice(PRETTY_ACTIVE_PARENT_DEPTH + 1)) {
    const children = visibleNodes(childrenByParent, activeNodeId, childrenByParent.get(ancestor.nodeId) ?? []);
    earlierBranchCount += completedOffPathCount(children, activePath);
  }
  return { rootNodes: [focusRoot], earlierBranchCount, activePath };
}
function prettySiblingItems(nodes, activePath) {
  const items = nodes.map((node) => bucketable(node, activePath) ? { type: "history", count: 1 } : { type: "node", node });
  const activeIndex = nodes.findIndex((node) => activePath.has(node.nodeId));
  const visibleEnd = activeIndex < 0 ? nodes.length : activeIndex + 1;
  if (visibleEnd < nodes.length || nodes.length <= PRETTY_MAX_VISIBLE_SIBLINGS) {
    return mergeHistory(items);
  }
  const visibleStart = Math.max(0, visibleEnd - PRETTY_MAX_VISIBLE_SIBLINGS);
  const folded = [];
  if (visibleStart > 0) {
    folded.push({
      type: "history",
      count: visibleStart
    });
  }
  folded.push(...items.slice(visibleStart, visibleEnd));
  return mergeHistory(folded);
}
function visibleNodes(childrenByParent, activeNodeId, level) {
  const out = [];
  appendVisible(childrenByParent, activeNodeId, level, out);
  return out;
}
function appendVisible(childrenByParent, activeNodeId, level, out) {
  for (const node of level) {
    const children = childrenByParent.get(node.nodeId) ?? [];
    if (shouldElide(node, children.length > 0, node.nodeId === activeNodeId)) {
      appendVisible(childrenByParent, activeNodeId, children, out);
    } else {
      out.push(node);
    }
  }
}
function activePathNodes(activeNodeId, byId) {
  const path = [];
  const seen = /* @__PURE__ */ new Set();
  let current = byId.get(activeNodeId);
  while (current !== void 0) {
    if (seen.has(current.nodeId)) break;
    seen.add(current.nodeId);
    path.push(current);
    current = current.parentId === null ? void 0 : byId.get(current.parentId);
  }
  return path;
}
function shouldElide(node, hasChildren, active) {
  return node.kind === "RootEpoch" || hasChildren && !active && trimmedSummary(node) === null && !isCompleted(node);
}
function shouldCollapse(node, hasChildren, activePath) {
  return hasChildren && isCompleted(node) && !activePath.has(node.nodeId);
}
function bucketable(node, activePath) {
  return isCompleted(node) && trimmedSummary(node) === null && !activePath.has(node.nodeId);
}
function isCompleted(node) {
  if (node.kind === "Spawn")
    return node.spawn !== "pending";
  return node.status === "Closed" || node.status === "Compacted";
}
function completedOffPathCount(nodes, activePath) {
  return nodes.filter((node) => !activePath.has(node.nodeId) && isCompleted(node)).length;
}
function prependHistory(items, count) {
  if (count === 0)
    return items;
  if (items[0]?.type === "history") {
    return [{ type: "history", count: items[0].count + count }, ...items.slice(1)];
  }
  return [{ type: "history", count }, ...items];
}
function mergeHistory(items) {
  const merged = [];
  for (const item of items) {
    const last = merged[merged.length - 1];
    if (item.type === "history" && last?.type === "history") {
      last.count += item.count;
    } else {
      merged.push(item.type === "history" ? { type: "history", count: item.count } : item);
    }
  }
  return merged;
}
function trimmedSummary(node) {
  return node.summary?.trim() || null;
}
var ICON_PATHS = {
  sitemap: [
    "M3 15m0 2a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2v2a2 2 0 0 1 -2 2h-2a2 2 0 0 1 -2 -2z",
    "M15 15m0 2a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2v2a2 2 0 0 1 -2 2h-2a2 2 0 0 1 -2 -2z",
    "M9 3m0 2a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2v2a2 2 0 0 1 -2 2h-2a2 2 0 0 1 -2 -2z",
    "M6 15v-1a2 2 0 0 1 2 -2h8a2 2 0 0 1 2 2v1",
    "M12 9l0 3"
  ],
  history: ["M12 8l0 4l2 2", "M3.05 11a9 9 0 1 1 .5 4m-.5 5v-5h5"],
  check: ["M5 12l5 5l10 -10"],
  x: ["M18 6l-12 12", "M6 6l12 12"],
  "exclamation-mark": ["M12 19v.01", "M12 15v-10"]
};
function renderIcon(name, size) {
  return (0, import_jsx_runtime.jsx)("svg", {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    focusable: "false",
    "aria-hidden": true,
    children: ICON_PATHS[name].map((d) => (0, import_jsx_runtime.jsx)("path", { d }, d))
  });
}
function renderDisclosureIcon() {
  return (0, import_jsx_runtime.jsx)("svg", {
    width: 14,
    height: 14,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1,
    focusable: "false",
    "aria-hidden": true,
    children: (0, import_jsx_runtime.jsx)("path", { d: "M4 6l3.3 3.3q.7.7 1.4 0L12 6" })
  });
}
function renderStateMark(mark) {
  if (mark === "history") return renderIcon("history", 12);
  if (mark === "complete") return renderIcon("check", 14);
  if (mark === "error") return renderIcon("x", 14);
  if (mark === "aborted") return renderIcon("exclamation-mark", 14);
  if (mark === "task") {
    return (0, import_jsx_runtime.jsx)("span", { className: "spine-dot", "aria-hidden": true });
  }
  return (0, import_jsx_runtime.jsxs)("svg", {
    className: "spine-spinner",
    width: 14,
    height: 14,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round",
    focusable: "false",
    "aria-hidden": true,
    children: [
      (0, import_jsx_runtime.jsx)("circle", { cx: 12, cy: 12, r: 9.5, opacity: 0.25 }),
      (0, import_jsx_runtime.jsx)("circle", { cx: 12, cy: 12, r: 9.5, className: "spine-spinner-arc" })
    ]
  });
}
var worktreeText = {
  zh: {
    title: "\u5DE5\u4F5C\u6811",
    current: "\u5F53\u524D",
    parallel: "\u5E76\u884C",
    complete: "\u5DF2\u5B8C\u6210",
    error: "\u5931\u8D25",
    aborted: "\u4E2D\u6B62",
    task: "\u4EFB\u52A1",
    currentTask: "\u5F53\u524D\u4EFB\u52A1",
    completedTask: "\u5DF2\u5B8C\u6210\u4EFB\u52A1",
    previousTask: "\u8F83\u65E9\u4EFB\u52A1",
    parallelOne: "1 \u4E2A\u5E76\u884C\u5206\u652F",
    parallelMany: "{count} \u4E2A\u5E76\u884C\u5206\u652F",
    earlierOne: "1 \u4E2A\u8F83\u65E9\u5206\u652F",
    earlierMany: "{count} \u4E2A\u8F83\u65E9\u5206\u652F"
  },
  en: {
    title: "Task tree",
    current: "Current",
    parallel: "Parallel",
    complete: "Completed",
    error: "Failed",
    aborted: "Aborted",
    task: "Task",
    currentTask: "Current task",
    completedTask: "Completed task",
    previousTask: "Previous task",
    parallelOne: "1 parallel branch",
    parallelMany: "{count} parallel branches",
    earlierOne: "1 earlier branch",
    earlierMany: "{count} earlier branches"
  }
};
var CSS = `
.spinejit-worktree {
  box-sizing: border-box;
  flex: none;
  min-width: 0;
  width: calc(100% - 2 * var(--dsh-composer-side-clearance) - 4 * var(--dsh-composer-dock-inset));
  max-width: calc(var(--dsh-composer-card-max-width) - 4 * var(--dsh-composer-dock-inset));
  margin: 0 auto;
  border: 0;
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-specific-menu);
  backdrop-filter: var(--dsw-menu-backdrop-filter);
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1);
  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
  --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);
  box-shadow: var(--dsw-elevation-panel);
  color: var(--dsw-alias-label-primary);
  overflow: hidden;
}
.spinejit-worktree .spine-header {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 36px;
  padding: 6px 12px;
  list-style: none;
  font: var(--dsw-font-xs-13);
  cursor: pointer;
}
.spinejit-worktree .spine-header::-webkit-details-marker { display: none; }
.spinejit-worktree .spine-header:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: calc(-1 * var(--dsw-focus-ring-width));
  border-radius: inherit;
}
.spinejit-worktree .spine-title { flex: none; font: var(--dsw-font-xs-strong-13); }
.spinejit-worktree .spine-summary {
  display: flex;
  min-width: 0;
  color: var(--dsw-alias-label-tertiary);
  white-space: nowrap;
}
.spinejit-worktree .spine-summary-task {
  color: var(--dsw-alias-label-primary-dimmed);
  overflow: hidden;
  text-overflow: ellipsis;
}
.spinejit-worktree .spine-summary-status { flex: none; }
.spinejit-worktree .spine-icon {
  display: grid;
  place-items: center;
  width: 16px;
  height: 16px;
  flex: none;
  color: var(--dsw-alias-label-tertiary);
}
.spinejit-worktree .spine-icon svg { stroke-width: 1.5; }
.spinejit-worktree .spine-chevron {
  display: grid;
  place-items: center;
  flex: none;
  color: var(--dsw-alias-label-tertiary);
  margin-inline-start: auto;
}
.spinejit-worktree:not([open]) .spine-chevron svg { transform: rotate(180deg); }
/* Together with the header's lower padding, this leaves 8px before the tree. */
.spinejit-worktree .spine-body { padding: 2px 12px 6px; }
.spinejit-worktree .spine-tree {
  --spine-item-gap: 8px;
  --spine-indent: 18px;
  --spine-marker-size: 16px;
  max-block-size: 180px;
  overflow: auto;
}
.spinejit-worktree ul {
  display: flex;
  flex-direction: column;
  gap: var(--spine-item-gap);
  list-style: none;
  margin: 0;
  padding: 0;
}
.spinejit-worktree .spine-branches {
  margin-block-start: var(--spine-item-gap);
  padding-inline-start: var(--spine-indent);
}
.spinejit-worktree .spine-branches > li { --spine-connector-start: 0px; }
.spinejit-worktree .spine-branches > li:first-child {
  --spine-connector-start: calc(-1 * var(--spine-item-gap));
}
.spinejit-worktree .spine-branches > li:not(:last-child) { position: relative; }
.spinejit-worktree .spine-branches > li:not(:last-child)::before,
.spinejit-worktree .spine-branches > li:last-child > .spine-row::before,
.spinejit-worktree .spine-branches > li > .spine-row::after {
  content: "";
  position: absolute;
  /* Center the 1px stroke under the parent marker, whatever the child indent. */
  inset-inline-start: calc(var(--spine-marker-size) / 2 - var(--spine-indent) - 0.5px);
  background: var(--dsw-alias-border-l2);
}
.spinejit-worktree .spine-branches > li:not(:last-child)::before {
  inset-block: var(--spine-connector-start) calc(-1 * var(--spine-item-gap));
  width: 1px;
}
.spinejit-worktree .spine-branches > li:last-child > .spine-row::before {
  inset-block: var(--spine-connector-start) 50%;
  width: 1px;
}
.spinejit-worktree .spine-branches > li > .spine-row::after {
  inset-block-start: calc(50% - 0.5px);
  /* Leave more space between the hook and the child icon. */
  width: calc((var(--spine-indent) - var(--spine-marker-size) / 2 - 0.5px) * 0.9);
  height: 1px;
}
.spinejit-worktree .spine-row {
  position: relative;
  display: grid;
  grid-template-columns: var(--spine-marker-size) minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  min-width: 0;
  font: var(--dsw-font-xs-13);
  color: var(--dsw-alias-label-secondary);
}
.spinejit-worktree .spine-row-title { overflow-wrap: anywhere; }
.spinejit-worktree .spine-mark {
  display: grid;
  place-items: center;
  height: 16px;
  color: var(--dsw-alias-label-tertiary);
}
/* Match the shared DSH status indicators using the theme's state colors. */
.spinejit-worktree .spine-mark-task { color: var(--dsw-alias-state-idle-primary); }
.spinejit-worktree .spine-mark-parallel { color: var(--dsw-alias-state-done-primary); }
.spinejit-worktree .spine-mark-complete { color: var(--dsw-alias-state-success-primary); }
.spinejit-worktree .spine-mark-error { color: var(--dsw-alias-state-error-primary); }
.spinejit-worktree .spine-mark-aborted { color: var(--dsw-alias-state-warn-primary); }
.spinejit-worktree .spine-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}
.spinejit-worktree .spine-spinner { animation: spinejit-rotate 1.5s linear infinite; }
.spinejit-worktree .spine-spinner-arc {
  stroke-dasharray: 12 60;
  animation: spinejit-dash 1.5s ease-in-out infinite;
}
@keyframes spinejit-rotate { to { transform: rotate(360deg); } }
@keyframes spinejit-dash {
  0%, 100% { stroke-dasharray: 12 60; stroke-dashoffset: 0; }
  50% { stroke-dasharray: 24 60; stroke-dashoffset: -6; }
}
@media (prefers-reduced-motion: reduce) {
  .spinejit-worktree .spine-spinner, .spinejit-worktree .spine-spinner-arc { animation: none; }
  .spinejit-worktree .spine-spinner-arc { stroke-dasharray: 18 60; stroke-dashoffset: -3; }
}
.spinejit-worktree .spine-history { font-size: var(--dsw-font-xxs-12-font-size); }
.spinejit-worktree .spine-history .spine-mark { color: inherit; }
`;
function branchLabel(node, t) {
  const summary = trimmedSummary(node);
  if (summary) return summary;
  if (node.status === "Live") return t("currentTask");
  if (node.status === "Closed" && node.kind === "Task") return t("completedTask");
  if (node.status === "Compacted" || node.spawn === "inherited") return t("previousTask");
  return t("task");
}
function branchState(node) {
  if (node.kind === "Spawn") {
    if (node.spawn === "pending") return "parallel";
    switch (spineTreeSpawnOutcome(node.spawn)) {
      case "completed":
        return "complete";
      case "errored":
        return "error";
      case "aborted":
        return "aborted";
      default:
        return "history";
    }
  }
  if (node.status === "Closed") return "complete";
  if (node.status === "Compacted") return "history";
  return "task";
}
function countLabel(t, key, count) {
  return t(`${key}${count === 1 ? "One" : "Many"}`, { count });
}
function countVisibleParallel(items) {
  let count = 0;
  for (const item of items) {
    if (item.type === "history") continue;
    if (branchState(item.node) === "parallel") count += 1;
    count += countVisibleParallel(item.children);
  }
  return count;
}
function treeSummary(tree, items, t) {
  const current = tree.nodes.find((node) => node.nodeId === tree.cursor && node.kind !== "RootEpoch");
  const parallelCount = countVisibleParallel(items);
  return {
    title: current ? branchLabel(current, t) : null,
    parallel: parallelCount ? countLabel(t, "parallel", parallelCount) : null
  };
}
function renderSummary({ title, parallel }) {
  if (!title && !parallel) return null;
  return (0, import_jsx_runtime.jsxs)("span", { className: "spine-summary", children: [
    title && (0, import_jsx_runtime.jsx)("span", { className: "spine-summary-task", title, children: title }),
    parallel && (0, import_jsx_runtime.jsx)("span", { className: "spine-summary-status", children: `${title ? "\u2002\xB7\u2002" : ""}${parallel}` })
  ] });
}
function renderRows(items, t, nested = false) {
  return (0, import_jsx_runtime.jsx)("ul", {
    className: nested ? "spine-branches" : void 0,
    role: "list",
    children: items.map((item, index) => {
      if (item.type === "history") {
        return (0, import_jsx_runtime.jsx)("li", { children: (0, import_jsx_runtime.jsxs)("div", { className: "spine-row spine-history", children: [
          (0, import_jsx_runtime.jsx)("span", { className: "spine-mark spine-mark-history", "aria-hidden": true, children: renderStateMark("history") }),
          (0, import_jsx_runtime.jsx)("span", { className: "spine-row-title", children: countLabel(t, "earlier", item.count) })
        ] }) }, `history-${index}`);
      }
      const state = branchState(item.node);
      const mark = item.current && state === "task" ? "current" : state;
      const status = mark === "task" ? void 0 : t(mark === "history" ? "previousTask" : mark);
      return (0, import_jsx_runtime.jsxs)("li", { children: [
        (0, import_jsx_runtime.jsxs)("div", { className: "spine-row", "aria-current": item.current || void 0, children: [
          (0, import_jsx_runtime.jsx)("span", {
            className: `spine-mark spine-mark-${mark}`,
            role: status ? "img" : void 0,
            "aria-label": status,
            "aria-hidden": status ? void 0 : true,
            title: status,
            children: renderStateMark(mark)
          }),
          (0, import_jsx_runtime.jsx)("span", {
            className: "spine-row-title",
            children: branchLabel(item.node, t)
          })
        ] }),
        item.children.length > 0 && renderRows(item.children, t, true)
      ] }, `branch-${item.node.nodeId}`);
    })
  });
}
function SpineDock({ useProjection, t }) {
  const tree = useProjection(TREE_PROJECTION);
  if (!showsTree(tree)) return null;
  const items = webTreeItems(tree.cursor, tree.nodes);
  if (!items.length) return null;
  return (0, import_jsx_runtime.jsxs)("details", { className: "spinejit-worktree", children: [
    (0, import_jsx_runtime.jsxs)("summary", { className: "spine-header", children: [
      (0, import_jsx_runtime.jsx)("span", { className: "spine-icon", "aria-hidden": true, children: renderIcon("sitemap", 14) }),
      (0, import_jsx_runtime.jsx)("span", { className: "spine-title", children: t("title") }),
      renderSummary(treeSummary(tree, items, t)),
      (0, import_jsx_runtime.jsx)("span", { className: "spine-chevron", "aria-hidden": true, children: renderDisclosureIcon() })
    ] }),
    (0, import_jsx_runtime.jsx)("style", { children: CSS }),
    (0, import_jsx_runtime.jsx)("div", { className: "spine-body", children: (0, import_jsx_runtime.jsx)("div", {
      className: "spine-tree",
      children: renderRows(items, t)
    }) })
  ] });
}

// src/client.ts
var LOCALE = "spinejit";
var SPAWN_LOCALE = "spinejit-spawn";
var SPAWN_COPY = {
  en: { placeholder: "Send messages from the parent conversation" },
  zh: { placeholder: "\u8BF7\u5728\u7236\u4F1A\u8BDD\u53D1\u9001\u6D88\u606F" }
};
var emptySpineContextDefinition = {
  kind: "spinejit.empty-context",
  target: "chat",
  match: {
    "developer/message"(event) {
      const { message } = event.data;
      const kind = message.source.kind;
      return kind === "spine" && message.content.length === 0 ? { id: String(event.seq), role: "start", exclusive: true } : null;
    }
  },
  start: () => null,
  update: () => null,
  buildViewNode: () => null
};
var inject = ["slots", "uiConversation", "conversation", "locale", "uiSession"];
function apply(ctx) {
  const { blocks } = ctx.conversation;
  const conversationText = ctx.locale.bind("conversation");
  ctx.effect(() => ctx.locale.register(LOCALE, worktreeText), "spinejit: work tree locale");
  ctx.effect(() => ctx.uiConversation.events.register(emptySpineContextDefinition), "spinejit: hide empty context");
  ctx.effect(() => ctx.uiConversation.events.register(compactStatsDefinition), "spinejit: compact statistics");
  ctx.effect(() => ctx.locale.register(SPAWN_LOCALE, SPAWN_COPY), "spinejit: child composer copy");
  ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
    name: "conversation.composer.dock",
    id: "spinejit.spawn-send-block",
    locale: SPAWN_LOCALE
  }, function SpineSpawnSendBlock({ sessionId, useSession, t }) {
    const spawned = useSession((session) => {
      const address = session.subagent?.address;
      return address?.mode === "continuable" && address.childSessionId === sessionId && spawnIdentity(address.childSessionId)?.parent === address.parentSessionId;
    });
    const running = useSession((session) => session.running === true && session.removed !== true);
    const styleRef = (0, import_react.useRef)(null);
    const reason = t("placeholder");
    (0, import_react.useLayoutEffect)(() => {
      if (!spawned) return;
      return holdComposerBlock(blocks, sessionId, reason);
    }, [sessionId, spawned, reason]);
    (0, import_react.useLayoutEffect)(() => {
      if (spawned && running && styleRef.current !== null) {
        return suppressStopShortcut(styleRef.current, sessionId, ctx.uiSession);
      }
    }, [sessionId, spawned, running]);
    if (!spawned) return null;
    return (0, import_jsx_runtime2.jsx)("style", {
      ref: styleRef,
      "data-spinejit-child-stop": "",
      children: stopButtonCss(conversationText("input.stop"))
    });
  }));
  ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
    name: "conversation.input.dock",
    // Between the official Goal (10) and queue (20) entries.
    id: "spinejit",
    order: 19,
    locale: LOCALE,
    registrant: "@spinejit/dsh-spinejit"
  }, SpineDock));
}
function stopButtonCss(label) {
  const escaped = Array.from(label, (char) => `\\${char.codePointAt(0).toString(16)} `).join("");
  const stop = `:has(> [data-composer-dock] [data-spinejit-child-stop]) > [data-composer-card] button[aria-label="${escaped}"]:not([data-slot^="conversation.input."] *)`;
  return `
${stop} { pointer-events: none; visibility: hidden; }
@supports (interactivity: inert) {
  ${stop} { interactivity: inert; visibility: visible; opacity: 0.4; }
}`;
}
function suppressStopShortcut(seat, sessionId, uiSession) {
  const occurrence = seat.closest("[data-conversation-session]");
  if (occurrence?.dataset.conversationSession !== sessionId) return;
  const document = seat.ownerDocument;
  const keydown = (event) => {
    if (event.code !== "Escape" || event.defaultPrevented || event.repeat || event.isComposing || event.ctrlKey || event.altKey || event.shiftKey || event.metaKey || event.keyCode === 229) return;
    const target = event.composedPath().find((node) => node instanceof Element);
    if (!target || target.closest("[data-conversation-session]") !== occurrence) return;
    const region = target.closest("[data-conversation-region]");
    if (!region || !occurrence.contains(region) || target.closest("[data-approval-key], [data-question-key], iframe, .xterm, [inert]") || uiSession.sessionStatus.getSnapshot().get(sessionId)?.pendingInteraction !== void 0 || document.querySelector('[role="dialog"][aria-modal="true"], [role="menu"]')) return;
    event.preventDefault();
  };
  document.addEventListener("keydown", keydown);
  return () => document.removeEventListener("keydown", keydown);
}
function holdComposerBlock(blocks, sessionId, reason) {
  const block = { reason };
  const store = blocks.storeFor(sessionId);
  const apply2 = () => {
    if (store.getSnapshot() === void 0) blocks.set(sessionId, block);
  };
  const unsubscribe = store.subscribe(apply2);
  apply2();
  return () => {
    unsubscribe();
    if (store.getSnapshot() === block) blocks.set(sessionId, void 0);
  };
}
/*!
 * Tabler Icons v3.31.0 (https://github.com/tabler/tabler-icons/tree/v3.31.0/icons/outline)
 * MIT License
 *
 * Copyright (c) 2020-2024 Paweł Kuna
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
return module.exports;
} });
//# sourceMappingURL=client.js.map
