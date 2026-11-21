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
var import_jsx_runtime = require("react/jsx-runtime");

// node_modules/@spinejit/spine-sdk/dist/view/tree-style.js
function spineTreeSpawnOutcome(spawn) {
  return spawn !== null && typeof spawn === "object" ? spawn.arrived : null;
}
function spineTreeMarkerTone(marker) {
  switch (marker) {
    case "\u25C9":
    case "\u2713":
      return "brand";
    case "\xD7":
      return "error";
    case "!":
      return "warning";
    default:
      return "dim";
  }
}
function spineTreeMarker(node, active, hasChildren, expanded = true) {
  if (active)
    return "\u25C9";
  if (node.kind === "RootEpoch")
    return "\u25CC";
  const outcome = spineTreeSpawnOutcome(node.spawn);
  if (outcome === "completed")
    return "\u2713";
  if (outcome === "errored")
    return "\xD7";
  if (outcome === "aborted")
    return "!";
  if (node.spawn === "inherited")
    return "\u25CC";
  if (node.kind === "Spawn")
    return "\u25D0";
  if (node.status === "Live")
    return "\u25C9";
  if (node.status === "Closed")
    return "\u2713";
  if (node.status === "Compacted")
    return "\u25CC";
  if (node.status === "Opened" && hasChildren)
    return expanded ? "\u25BE" : "\u25B8";
  return "\u25CC";
}
function spineTreeLabel(node, active) {
  const summary = node.summary?.trim();
  if (summary)
    return summary;
  if (active || node.status === "Live")
    return "Current task";
  if (node.status === "Opened")
    return "Task";
  if (node.status === "Closed")
    return "Completed task";
  return "Previous task";
}
function spineTreeBranch(isLast) {
  return isLast ? "\u2514 " : "\u251C ";
}
function spineTreeChildPrefix(isLast) {
  return isLast ? "  " : "\u2502 ";
}

// node_modules/@spinejit/spine-sdk/dist/view/pretty-tree.js
var PRETTY_MAX_VISIBLE_SIBLINGS = 3;
var PRETTY_ACTIVE_PARENT_DEPTH = 3;
function prettySpineTreeLines(activeNodeId, nodes) {
  const lines = [{ type: "header" }];
  if (nodes.length === 0) {
    lines.push({ type: "empty" });
    return lines;
  }
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  if (!byId.has(activeNodeId)) {
    lines.push({ type: "empty" });
    return lines;
  }
  const viewport = prettyViewport(activeNodeId, nodes, byId);
  if (viewport.rootNodes.length === 0) {
    lines.push({ type: "empty" });
    return lines;
  }
  appendPrettyNodes(lines, nodes, activeNodeId, viewport.rootNodes, viewport.activePath, "  ", viewport.earlierBranchCount);
  return lines;
}
function appendPrettyNodes(lines, nodes, activeNodeId, level, activePath, prefix, leadingHistoryCount) {
  const items = prependHistory(prettySiblingItems(visibleNodes(nodes, activeNodeId, level), activePath), leadingHistoryCount);
  items.forEach((item, index) => {
    const isLast = index + 1 === items.length;
    const branch = spineTreeBranch(isLast);
    const childPrefix = `${prefix}${spineTreeChildPrefix(isLast)}`;
    if (item.type === "history") {
      lines.push({ type: "history", prefix: `${prefix}${branch}`, count: item.count });
      return;
    }
    const children = childNodes(nodes, item.node.nodeId);
    const current = item.node.nodeId === activeNodeId;
    lines.push({
      type: "node",
      prefix: `${prefix}${branch}`,
      marker: spineTreeMarker(item.node, current, children.length > 0),
      label: spineTreeLabel(item.node, current),
      current
    });
    if (shouldCollapse(item.node, children.length > 0, activePath))
      return;
    appendPrettyNodes(lines, nodes, activeNodeId, children, activePath, childPrefix, 0);
  });
}
function prettyViewport(activeNodeId, nodes, byId) {
  const pathNodes = activePathNodes(activeNodeId, byId);
  const activePath = new Set(pathNodes.map((node) => node.nodeId));
  const activeRoot = pathNodes[pathNodes.length - 1];
  if (activeRoot === void 0) {
    return { rootNodes: [], earlierBranchCount: 0, activePath };
  }
  const activeRootNodes = visibleNodes(nodes, activeNodeId, [activeRoot]);
  let earlierBranchCount = 0;
  for (const node of childNodes(nodes, null)) {
    if (node.nodeId === activeRoot.nodeId)
      continue;
    for (const visible of visibleNodes(nodes, activeNodeId, [node])) {
      if (isCompleted(visible))
        earlierBranchCount += 1;
    }
  }
  const visibleActivePath = pathNodes.filter((node) => {
    const children = childNodes(nodes, node.nodeId);
    return !shouldElide(node, children.length > 0, node.nodeId === activeNodeId);
  });
  if (visibleActivePath.length <= PRETTY_ACTIVE_PARENT_DEPTH + 1) {
    return { rootNodes: activeRootNodes, earlierBranchCount, activePath };
  }
  const focusRoot = visibleActivePath[PRETTY_ACTIVE_PARENT_DEPTH];
  if (focusRoot === void 0) {
    return { rootNodes: activeRootNodes, earlierBranchCount, activePath };
  }
  earlierBranchCount += completedOffPathCount(activeRootNodes, activePath);
  for (const ancestor of visibleActivePath.slice(PRETTY_ACTIVE_PARENT_DEPTH + 1)) {
    const children = visibleNodes(nodes, activeNodeId, childNodes(nodes, ancestor.nodeId));
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
      count: items.slice(0, visibleStart).reduce((sum, item) => sum + (item.type === "history" ? item.count : 1), 0)
    });
  }
  folded.push(...items.slice(visibleStart, visibleEnd));
  return mergeHistory(folded);
}
function visibleNodes(nodes, activeNodeId, level) {
  const out = [];
  appendVisible(nodes, activeNodeId, level, out);
  return out;
}
function appendVisible(nodes, activeNodeId, level, out) {
  for (const node of level) {
    const children = childNodes(nodes, node.nodeId);
    if (shouldElide(node, children.length > 0, node.nodeId === activeNodeId)) {
      appendVisible(nodes, activeNodeId, children, out);
    } else {
      out.push(node);
    }
  }
}
function childNodes(nodes, parentId) {
  return nodes.filter((node) => node.parentId === parentId);
}
function activePathNodes(activeNodeId, byId) {
  const path = [];
  const seen = /* @__PURE__ */ new Set();
  let current = byId.get(activeNodeId);
  while (current !== void 0) {
    if (!seen.add(current.nodeId))
      break;
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
  const summary = node.summary?.trim();
  return summary === void 0 || summary === "" ? null : summary;
}
function historyNoun(count) {
  return count === 1 ? "branch" : "branches";
}
function prettySpineTreeLineText(line) {
  switch (line.type) {
    case "header":
      return "\u2022 Spine Tree";
    case "empty":
      return "  \u2514 (empty)";
    case "history":
      return `${line.prefix}\u25CC ${line.count} earlier ${historyNoun(line.count)}`;
    case "node":
      return `${line.prefix}${line.marker} ${line.label}`;
  }
}

// src/spawn-id.ts
var SPAWN_SUFFIX = /:spawn:(\d+(?:\.\d+)*)$/;
function spawnIdentity(id) {
  const match = SPAWN_SUFFIX.exec(id);
  if (match === null) return null;
  return { parent: id.slice(0, match.index), producer: match[1].split(".").map(Number) };
}

// src/tree.ts
var TREE_PROJECTION = "spinejit";
function showsTree(tree) {
  return tree?.nodes.some((node) => node.kind === "Task") === true;
}

// src/client.ts
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
  ctx.effect(() => ctx.uiConversation.events.register(emptySpineContextDefinition), "spinejit: hide empty context");
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
    return (0, import_jsx_runtime.jsx)("style", {
      ref: styleRef,
      "data-spinejit-child-stop": "",
      children: stopButtonCss(conversationText("input.stop"))
    });
  }));
  ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
    name: "conversation.input.dock",
    // After the official entries: todo 0, goal 10, activity 15, queue 20.
    id: "spinejit",
    order: 30,
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
var BLOCK = {
  boxSizing: "border-box",
  width: "100%",
  maxWidth: "var(--dsh-composer-card-max-width)",
  margin: "0 auto",
  padding: "4px 16px 0",
  fontFamily: "var(--dsw-font-mono, monospace)",
  fontSize: 12,
  lineHeight: "18px",
  color: "var(--dsw-alias-label-secondary)"
};
var ROW = { whiteSpace: "pre", overflow: "hidden", textOverflow: "ellipsis" };
var DIM = { color: "var(--dsw-alias-label-tertiary)" };
var TONE = {
  brand: { color: "var(--dsw-alias-state-success-primary)", fontWeight: 600 },
  error: { color: "var(--dsw-alias-state-error-primary)", fontWeight: 600 },
  warning: { color: "var(--dsw-alias-state-warn-primary)", fontWeight: 600 },
  dim: DIM
};
function SpineDock({ useProjection }) {
  const tree = useProjection(TREE_PROJECTION);
  if (!showsTree(tree)) return null;
  return (0, import_jsx_runtime.jsx)("div", {
    style: BLOCK,
    children: prettySpineTreeLines(tree.cursor, tree.nodes).map((line, index) => (0, import_jsx_runtime.jsxs)("div", { style: ROW, children: rowParts(line) }, index))
  });
}
function rowParts(line) {
  switch (line.type) {
    case "header":
      return [span(DIM, "\u2022 "), span(TONE.brand, "Spine Tree")];
    case "node":
      return [span(DIM, line.prefix), span(TONE[spineTreeMarkerTone(line.marker)], line.marker), ` ${line.label}`];
    default:
      return [span(DIM, prettySpineTreeLineText(line))];
  }
}
function span(style, text) {
  return (0, import_jsx_runtime.jsx)("span", { style, children: text });
}
return module.exports;
} });
//# sourceMappingURL=client.js.map
