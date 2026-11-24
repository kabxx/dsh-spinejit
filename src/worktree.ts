// Renders the session projection as a themed tree in the conversation dock.
import { jsx, jsxs } from "react/jsx-runtime";
import { spineTreeSpawnOutcome, type DisplayNode } from "@spinejit/spine-sdk/view";

import { showsTree, TREE_PROJECTION, type SpineTree } from "./tree.js";

type TranslationKey = keyof typeof worktreeText.en;
type Translate = (key: TranslationKey, values?: { count: number }) => string;
type State = "task" | "history" | "complete" | "error" | "aborted" | "parallel";

/** The dock seat's props the entry reads. */
export interface SpineDockProps {
  useProjection(key: typeof TREE_PROJECTION): SpineTree | null | undefined;
  t: Translate;
}

// Keep the SDK's pretty-tree viewport rules while retaining node identity and
// parent/child structure for the browser. The SDK currently returns text rows.
type HistoryItem = { type: "history"; count: number };
type SiblingItem = HistoryItem | { type: "node"; node: DisplayNode };
type WebTreeItem = HistoryItem | {
  type: "node";
  node: DisplayNode;
  current: boolean;
  children: WebTreeItem[];
};

const PRETTY_MAX_VISIBLE_SIBLINGS = 3;
const PRETTY_ACTIVE_PARENT_DEPTH = 3;
type ChildrenByParent = ReadonlyMap<string | null, readonly DisplayNode[]>;

function webTreeItems(activeNodeId: string, nodes: readonly DisplayNode[]): WebTreeItem[] {
  const byId = new Map<string, DisplayNode>();
  const childrenByParent = new Map<string | null, DisplayNode[]>();
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

function prettyLevel(childrenByParent: ChildrenByParent, activeNodeId: string, level: readonly DisplayNode[], activePath: ReadonlySet<string>, leadingHistoryCount = 0): WebTreeItem[] {
  const items = prependHistory(prettySiblingItems(visibleNodes(childrenByParent, activeNodeId, level), activePath), leadingHistoryCount);
  return items.map((item) => {
    if (item.type === "history") return item;
    const children = childrenByParent.get(item.node.nodeId) ?? [];
    return {
      ...item,
      current: item.node.nodeId === activeNodeId,
      children: shouldCollapse(item.node, children.length > 0, activePath)
        ? []
        : prettyLevel(childrenByParent, activeNodeId, children, activePath)
    };
  });
}

function prettyViewport(activeNodeId: string, childrenByParent: ChildrenByParent, byId: ReadonlyMap<string, DisplayNode>) {
  const pathNodes = activePathNodes(activeNodeId, byId);
  const activePath = new Set(pathNodes.map((node) => node.nodeId));
  // webTreeItems has already checked that the active node exists.
  const activeRoot = pathNodes[pathNodes.length - 1]!;
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
  const focusRoot = visibleActivePath[PRETTY_ACTIVE_PARENT_DEPTH]!;
  earlierBranchCount += completedOffPathCount(activeRootNodes, activePath);
  for (const ancestor of visibleActivePath.slice(PRETTY_ACTIVE_PARENT_DEPTH + 1)) {
    const children = visibleNodes(childrenByParent, activeNodeId, childrenByParent.get(ancestor.nodeId) ?? []);
    earlierBranchCount += completedOffPathCount(children, activePath);
  }
  return { rootNodes: [focusRoot], earlierBranchCount, activePath };
}
function prettySiblingItems(nodes: readonly DisplayNode[], activePath: ReadonlySet<string>): SiblingItem[] {
  const items = nodes.map<SiblingItem>((node) => bucketable(node, activePath)
    ? { type: "history", count: 1 }
    : { type: "node", node });
  const activeIndex = nodes.findIndex((node) => activePath.has(node.nodeId));
  const visibleEnd = activeIndex < 0 ? nodes.length : activeIndex + 1;
  if (visibleEnd < nodes.length || nodes.length <= PRETTY_MAX_VISIBLE_SIBLINGS) {
    return mergeHistory(items);
  }
  const visibleStart = Math.max(0, visibleEnd - PRETTY_MAX_VISIBLE_SIBLINGS);
  const folded: SiblingItem[] = [];
  if (visibleStart > 0) {
    folded.push({
      type: "history",
      count: visibleStart,
    });
  }
  folded.push(...items.slice(visibleStart, visibleEnd));
  return mergeHistory(folded);
}
function visibleNodes(childrenByParent: ChildrenByParent, activeNodeId: string, level: readonly DisplayNode[]): DisplayNode[] {
  const out: DisplayNode[] = [];
  appendVisible(childrenByParent, activeNodeId, level, out);
  return out;
}
function appendVisible(childrenByParent: ChildrenByParent, activeNodeId: string, level: readonly DisplayNode[], out: DisplayNode[]): void {
  for (const node of level) {
    const children = childrenByParent.get(node.nodeId) ?? [];
    if (shouldElide(node, children.length > 0, node.nodeId === activeNodeId)) {
      appendVisible(childrenByParent, activeNodeId, children, out);
    } else {
      out.push(node);
    }
  }
}
function activePathNodes(activeNodeId: string, byId: ReadonlyMap<string, DisplayNode>): DisplayNode[] {
  const path: DisplayNode[] = [];
  const seen = new Set<string>();
  let current = byId.get(activeNodeId);
  while (current !== undefined) {
    if (seen.has(current.nodeId)) break;
    seen.add(current.nodeId);
    path.push(current);
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }
  return path;
}
function shouldElide(node: DisplayNode, hasChildren: boolean, active: boolean): boolean {
  return node.kind === "RootEpoch" || hasChildren && !active && trimmedSummary(node) === null && !isCompleted(node);
}
function shouldCollapse(node: DisplayNode, hasChildren: boolean, activePath: ReadonlySet<string>): boolean {
  return hasChildren && isCompleted(node) && !activePath.has(node.nodeId);
}
function bucketable(node: DisplayNode, activePath: ReadonlySet<string>): boolean {
  return isCompleted(node) && trimmedSummary(node) === null && !activePath.has(node.nodeId);
}
function isCompleted(node: DisplayNode): boolean {
  if (node.kind === "Spawn")
    return node.spawn !== "pending";
  return node.status === "Closed" || node.status === "Compacted";
}
function completedOffPathCount(nodes: readonly DisplayNode[], activePath: ReadonlySet<string>): number {
  return nodes.filter((node) => !activePath.has(node.nodeId) && isCompleted(node)).length;
}
function prependHistory(items: SiblingItem[], count: number): SiblingItem[] {
  if (count === 0)
    return items;
  if (items[0]?.type === "history") {
    return [{ type: "history", count: items[0].count + count }, ...items.slice(1)];
  }
  return [{ type: "history", count }, ...items];
}
function mergeHistory(items: readonly SiblingItem[]): SiblingItem[] {
  const merged: SiblingItem[] = [];
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
function trimmedSummary(node: DisplayNode): string | null {
  return node.summary?.trim() || null;
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
// Verbatim outline paths from Tabler Icons v3.31.0.
const ICON_PATHS = {
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

function renderIcon(name: keyof typeof ICON_PATHS, size: number): unknown {
  return jsx("svg", {
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
    children: ICON_PATHS[name].map((d) => jsx("path", { d }, d))
  });
}

// Match the sizing, weight and rounded bend of the host's disclosure icon.
function renderDisclosureIcon(): unknown {
  return jsx("svg", {
    width: 14,
    height: 14,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1,
    focusable: "false",
    "aria-hidden": true,
    children: jsx("path", { d: "M4 6l3.3 3.3q.7.7 1.4 0L12 6" })
  });
}

function renderStateMark(mark: State | "current"): unknown {
  if (mark === "history") return renderIcon("history", 12);
  if (mark === "complete") return renderIcon("check", 14);
  if (mark === "error") return renderIcon("x", 14);
  if (mark === "aborted") return renderIcon("exclamation-mark", 14);
  if (mark === "task") {
    return jsx("span", { className: "spine-dot", "aria-hidden": true });
  }
  return jsxs("svg", {
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
      jsx("circle", { cx: 12, cy: 12, r: 9.5, opacity: 0.25 }),
      jsx("circle", { cx: 12, cy: 12, r: 9.5, className: "spine-spinner-arc" })
    ]
  });
}

export const worktreeText = {
  zh: {
    title: "工作树", current: "当前", parallel: "并行", complete: "已完成",
    error: "失败", aborted: "中止", task: "任务", currentTask: "当前任务",
    completedTask: "已完成任务", previousTask: "较早任务",
    parallelOne: "1 个并行分支", parallelMany: "{count} 个并行分支",
    earlierOne: "1 个较早分支", earlierMany: "{count} 个较早分支"
  },
  en: {
    title: "Task tree", current: "Current", parallel: "Parallel", complete: "Completed",
    error: "Failed", aborted: "Aborted", task: "Task", currentTask: "Current task",
    completedTask: "Completed task", previousTask: "Previous task",
    parallelOne: "1 parallel branch", parallelMany: "{count} parallel branches",
    earlierOne: "1 earlier branch", earlierMany: "{count} earlier branches"
  }
};

const CSS = `
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

function branchLabel(node: DisplayNode, t: Translate): string {
  const summary = trimmedSummary(node);
  if (summary) return summary;
  if (node.status === "Live") return t("currentTask");
  if (node.status === "Closed" && node.kind === "Task") return t("completedTask");
  if (node.status === "Compacted" || node.spawn === "inherited") return t("previousTask");
  return t("task");
}

function branchState(node: DisplayNode): State {
  if (node.kind === "Spawn") {
    if (node.spawn === "pending") return "parallel";
    switch (spineTreeSpawnOutcome(node.spawn)) {
      case "completed": return "complete";
      case "errored": return "error";
      case "aborted": return "aborted";
      default: return "history";
    }
  }
  if (node.status === "Closed") return "complete";
  if (node.status === "Compacted") return "history";
  return "task";
}

function countLabel(t: Translate, key: "earlier" | "parallel", count: number): string {
  return t(`${key}${count === 1 ? "One" : "Many"}`, { count });
}

function countVisibleParallel(items: readonly WebTreeItem[]): number {
  let count = 0;
  for (const item of items) {
    if (item.type === "history") continue;
    if (branchState(item.node) === "parallel") count += 1;
    count += countVisibleParallel(item.children);
  }
  return count;
}

function treeSummary(tree: SpineTree, items: readonly WebTreeItem[], t: Translate) {
  const current = tree.nodes.find((node) => node.nodeId === tree.cursor && node.kind !== "RootEpoch");
  const parallelCount = countVisibleParallel(items);
  return {
    title: current ? branchLabel(current, t) : null,
    parallel: parallelCount ? countLabel(t, "parallel", parallelCount) : null
  };
}

function renderSummary({ title, parallel }: ReturnType<typeof treeSummary>): unknown {
  if (!title && !parallel) return null;
  return jsxs("span", { className: "spine-summary", children: [
    title && jsx("span", { className: "spine-summary-task", title, children: title }),
    parallel && jsx("span", { className: "spine-summary-status", children: `${title ? "\u2002·\u2002" : ""}${parallel}` })
  ] });
}

function renderRows(items: readonly WebTreeItem[], t: Translate, nested = false): unknown {
  return jsx("ul", {
    className: nested ? "spine-branches" : undefined,
    role: "list",
    children: items.map((item, index) => {
      if (item.type === "history") {
        return jsx("li", { children: jsxs("div", { className: "spine-row spine-history", children: [
          jsx("span", { className: "spine-mark spine-mark-history", "aria-hidden": true, children: renderStateMark("history") }),
          jsx("span", { className: "spine-row-title", children: countLabel(t, "earlier", item.count) })
        ] }) }, `history-${index}`);
      }
      const state = branchState(item.node);
      const mark = item.current && state === "task" ? "current" : state;
      const status = mark === "task" ? undefined : t(mark === "history" ? "previousTask" : mark);
      return jsxs("li", { children: [
        jsxs("div", { className: "spine-row", "aria-current": item.current || undefined, children: [
          jsx("span", {
            className: `spine-mark spine-mark-${mark}`,
            role: status ? "img" : undefined,
            "aria-label": status,
            "aria-hidden": status ? undefined : true,
            title: status,
            children: renderStateMark(mark)
          }),
          jsx("span", {
            className: "spine-row-title",
            children: branchLabel(item.node, t)
          })
        ] }),
        item.children.length > 0 && renderRows(item.children, t, true)
      ] }, `branch-${item.node.nodeId}`);
    })
  });
}

/** Reads the session projection and keeps disclosure state in the native element. */
export function SpineDock({ useProjection, t }: SpineDockProps): unknown {
  const tree = useProjection(TREE_PROJECTION);
  if (!showsTree(tree)) return null;
  const items = webTreeItems(tree.cursor, tree.nodes);
  if (!items.length) return null;
  // Native disclosure keeps the user's choice while projection data changes.
  return jsxs("details", { className: "spinejit-worktree", children: [
    jsxs("summary", { className: "spine-header", children: [
      jsx("span", { className: "spine-icon", "aria-hidden": true, children: renderIcon("sitemap", 14) }),
      jsx("span", { className: "spine-title", children: t("title") }),
      renderSummary(treeSummary(tree, items, t)),
      jsx("span", { className: "spine-chevron", "aria-hidden": true, children: renderDisclosureIcon() })
    ] }),
    jsx("style", { children: CSS }),
    jsx("div", { className: "spine-body", children: jsx("div", {
      className: "spine-tree", children: renderRows(items, t)
    }) })
  ] });
}
