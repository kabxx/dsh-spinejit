// The Spine tree DSH shows: the terminal's three rows, the session records
// clients fold, and the browser dock that draws them.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { pluginRecordOf } from "@deepseek-ai/dsh-session";
import { formatPrettySpineTreeFromNodes, prettySpineTreeLines } from "@spinejit/spine-sdk/view";

import { TreeDisplay, treeProjection } from "../dist/display.js";
import { TREE_RECORD, treeWindow } from "../dist/tree.js";
import { mountDsh } from "./harness.mjs";

function node(nodeId, parentId, summary, status, kind = "Task") {
  return { nodeId, parentId, kind, status, summary, spawn: null };
}

const deep = {
  cursor: "1.2.1",
  nodes: [
    node("1", null, "root task", "Opened"),
    node("1.1", "1", "first step", "Closed"),
    node("1.2", "1", "second step", "Opened"),
    node("1.2.1", "1.2", "deep step", "Live"),
  ],
};
const text = (line) => line.type === "node" ? `${line.prefix}${line.marker} ${line.label}` : line.type;

test("the terminal window keeps the cursor's row within three rows", () => {
  // Without the header the tree has four rows; the root task's is cut.
  assert.deepEqual(treeWindow(deep, 3).map(text), ["    ├ ✓ first step", "    └ ▾ second step", "      └ ◉ deep step"]);
  const top = { cursor: "1", nodes: [node("1", null, "root", "Live"), ...["a", "b", "c", "d"].map((id) => node(`1.${id}`, "1", id, "Opened"))] };
  const rows = treeWindow(top, 3);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].type === "node" && rows[0].current, true, "the cursor at the top starts the window");
  for (const cursor of ["1", "1.1", "1.2", "1.2.1"]) {
    const window = treeWindow({ ...deep, cursor }, 3);
    assert.equal(window.length <= 3, true);
    assert.equal(window.some((line) => line.type === "node" && line.current), true, `cursor ${cursor} is shown`);
  }
  assert.deepEqual(treeWindow({ cursor: "1", nodes: [node("1", null, "only", "Live")] }, 3).map(text), ["  └ ◉ only"]);
  // At the root epoch, which is never drawn, the newest rows: the task just closed stays in view.
  const epoch = { cursor: "1", nodes: [node("1", null, null, "Live", "RootEpoch"), ...["a", "b", "c", "d"].map((id) => node(`1.${id}`, "1", id, "Closed"))] };
  assert.equal(treeWindow(epoch, 3).at(-1).label, "d");
});

test("the terminal shows the top-level session opened last, never a subagent's, and falls back when it closes", () => {
  const display = new TreeDisplay();
  let emits = 0;
  display.subscribe(() => { emits += 1; });
  const record = (tree) => ({ seq: 1, time: 0, type: TREE_RECORD, ignorable: true, data: tree });
  const session = (id, events = [], origin) => ({ id, header: origin === undefined ? {} : { origin }, snapshotEvents: () => events });
  display.open(session("main", [record(deep), record({ cursor: 1 })]));
  assert.deepEqual(display.shown(), deep, "a resumed session shows its last readable record at once");
  assert.equal(display.shown(), display.shown(), "the same object until it changes");
  display.open(session("child", [], "subagent"));
  assert.deepEqual(display.shown(), deep, "a subagent does not take the terminal");
  display.open(session("fork"));
  assert.equal(display.shown(), null, "a new top-level session shows its own, empty tree");
  const before = emits;
  display.close("fork");
  assert.equal(emits, before + 1);
  assert.deepEqual(display.shown(), deep, "closing it shows the session before it again");
  display.close("child");
  assert.equal(emits, before + 1, "closing a session not shown changes nothing shown");
});

test("the terminal rows show the session's tree, draw markers with theme colors, and wait for a task", async () => {
  const dsh = await mountDsh([[["spine_open", { goal: "inspect" }]], "done"]);
  try {
    const views = [];
    dsh.ctx.provide("tuiStatus");
    dsh.ctx.set("tuiStatus", { registerView: (descriptor) => { views.push(descriptor); return () => {}; } });
    // The plugin's view registration waits for the service, as it waits for dsh-tui.
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(views.map(({ key, maxRows }) => [key, maxRows]), [["spinejit:tree", 3]]);
    const React = {
      createElement: (type, props, ...children) => ({ type, props, children }),
      useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
    };
    const rows = () => views[0].component({ React, ui: { Box: "Box", Text: "Text" } });
    assert.equal(rows(), null);
    await dsh.run("start");
    const box = rows();
    assert.equal(box.type, "Box");
    const flat = (element) => typeof element === "string" ? element : element.children.map(flat).join("");
    assert.deepEqual(box.children.map(flat), ["  └ ◉ inspect"]);
    const [prefix, marker] = box.children[0].children;
    assert.deepEqual(prefix.props, { dimColor: true });
    assert.deepEqual(marker.props, { color: "success", bold: true });
  } finally {
    await dsh.dispose();
  }
});

test("the projection folds the latest readable tree record and ignores the rest", () => {
  const state = treeProjection.init();
  assert.equal(state, null);
  const other = { seq: 1, type: "turn/end", data: {} };
  assert.equal(treeProjection.apply(state, other), state);
  const record = (seq, data) => ({ seq, time: 0, type: TREE_RECORD, ignorable: true, data });
  assert.equal(pluginRecordOf(record(2, deep))?.type, TREE_RECORD);
  const folded = treeProjection.apply(state, record(2, deep));
  assert.deepEqual(folded, deep);
  assert.equal(treeProjection.apply(folded, other), folded, "an unrelated event keeps the same state");
  assert.equal(treeProjection.apply(folded, record(3, { cursor: 1 })), folded, "an unreadable record keeps the tree");
  assert.deepEqual(treeProjection.wire.viewSchema.parse(folded), deep);
  assert.equal(treeProjection.wire.summary, false, "session/list summaries omit the display-only tree");
  assert.deepEqual(treeProjection.wire.view(folded), deep, "SpineDock still receives the complete projection");
});

test("each change of the shown tree is recorded once, a resumed session records none again, and the projection serves it", async () => {
  const replies = [[["spine_open", { goal: "inspect" }]], [["spine_close", { memory: "found it" }]], "done", "ok"];
  const first = await mountDsh(replies);
  let id;
  let trees;
  try {
    const agent = await first.run("start");
    await first.send(agent, "more");
    id = agent.id;
    trees = first.events(agent).map(pluginRecordOf).filter((record) => record?.type === TREE_RECORD).map((record) => record.data);
    const shown = trees.map((tree) => JSON.stringify(tree));
    assert.deepEqual(shown, [...new Set(shown)], "no tree is recorded twice");
    assert.deepEqual(trees.map((tree) => formatPrettySpineTreeFromNodes(tree.cursor, tree.nodes).slice(1)), [
      ["  └ (empty)"],
      ["  └ ◉ inspect"],
      ["  └ ✓ inspect"],
    ]);
    assert.deepEqual(first.ctx.sessionProjections.stateOf(agent.session, "spinejit"), trees.at(-1));
    const summary = first.ctx.sessionProjections.snapshot(agent.session, first.ctx.sessionProjections.summaryKeys());
    assert.equal("spinejit" in summary.values, false, "session/list summaries omit the tree");
    assert.deepEqual(first.ctx.sessionProjections.snapshot(agent.session).values.spinejit, trees.at(-1), "full client snapshots retain the tree for SpineDock");
  } finally {
    await first.dispose();
  }
  const second = await mountDsh(["again"], { root: first.root });
  try {
    const agent = await second.resume(id);
    await second.send(agent, "next");
    const records = agent.session.snapshotEvents().map(pluginRecordOf).filter((record) => record?.type === TREE_RECORD);
    assert.deepEqual(records.map((record) => record.data), trees, "the resumed session's tree did not change");
  } finally {
    await second.dispose();
  }
});

test("the client leaves literal [U<n>] lines in user bubbles", async () => {
  const { client } = await loadClient();
  assert.equal(client.userAnchorRule, undefined);
  client.apply({
    slots: { inject: (_name, register) => register(), register: () => {} },
    uiConversation: {
      userText: { register: () => assert.fail("text-only rules cannot identify a stored anchor") },
      events: { register: () => () => {} },
    },
    conversation: { blocks: {} },
    uiSession: { sessionStatus: { getSnapshot: () => new Map() } },
    locale: { bind: () => () => "Stop generating", register: () => () => {} },
    effect: (execute) => execute(),
  });
});

/** dist/client.js as the web client's module loader runs it, with a JSX runtime that builds plain objects. */
async function loadClient() {
  const source = await readFile(new URL("../dist/client.js", import.meta.url), "utf8");
  let loaded;
  const window = { __ModuleLoader__: { load: (module) => { loaded = module; } } };
  new Function("window", source)(window);
  const element = (key) => (type, props, elementKey) => ({ type, props, key: elementKey ?? null, kind: key });
  const required = [];
  const layoutEffects = [];
  const client = loaded.factory((name) => {
    required.push(name);
    if (name === "react") return {
      useLayoutEffect: (effect) => layoutEffects.push(effect),
      useRef: (current) => ({ current }),
    };
    return { jsx: element("jsx"), jsxs: element("jsxs") };
  });
  return { id: loaded.id, client, required, layoutEffects };
}

async function loadDock(locale = "en") {
  const { id, client, required } = await loadClient();
  assert.equal(id, "@spinejit/dsh-spinejit");
  assert.deepEqual([...new Set(required)], ["react", "react/jsx-runtime"]);
  assert.deepEqual(client.inject, ["slots", "uiConversation", "conversation", "locale", "uiSession"]);
  const registered = [];
  const definitions = [];
  const dictionaries = new Map();
  client.apply({
    slots: { inject: (_name, register) => register(), register: (entry, component) => registered.push([entry, component]) },
    uiConversation: { events: { register: (definition) => { definitions.push(definition); return () => {}; } } },
    conversation: { blocks: {} },
    uiSession: { sessionStatus: { getSnapshot: () => new Map() } },
    locale: {
      bind: () => () => "Stop generating",
      register: (namespace, texts) => { dictionaries.set(namespace, texts); return () => {}; },
    },
    effect: (execute) => execute(),
  });
  assert.deepEqual(definitions.map(({ kind, target }) => [kind, target]), [
    ["spinejit.empty-context", "chat"],
    ["spinejit.compact-stats", "stats"],
  ]);
  const [emptyContext] = definitions;
  assert.equal(emptyContext.buildViewNode(), null);
  assert.deepEqual(Object.keys(emptyContext.match), ["developer/message"]);
  const match = emptyContext.match["developer/message"];
  const developerEvent = (kind, content, seq = 12) => ({ seq, type: "developer/message", data: { message: { source: { kind }, content } } });
  const marker = developerEvent("spine", []);
  assert.deepEqual(match(marker), { id: "12", role: "start", exclusive: true });
  assert.deepEqual(marker, developerEvent("spine", []), "the event is left intact");
  assert.notEqual(match(developerEvent("spine", [], 13)).id, match(marker).id);
  assert.equal(match(developerEvent("spine", [{ type: "text", text: "branch summary" }])), null);
  assert.equal(match(developerEvent("time-context", [])), null);
  const leaves = registered.filter(([entry]) => entry.name === "conversation.input.dock");
  assert.deepEqual(leaves.map(([entry]) => entry), [{ name: "conversation.input.dock", id: "spinejit", order: 19, locale: "spinejit", registrant: id }]);
  const [entry, Dock] = leaves[0];
  const t = (key, params) => dictionaries.get(entry.locale)[locale][key].replace("{count}", params?.count);
  return (tree) => Dock({ useProjection: (key) => { assert.equal(key, "spinejit"); return tree; }, t });
}

function elements(part, match) {
  if (Array.isArray(part)) return part.flatMap((child) => elements(child, match));
  if (part === null || typeof part !== "object") return [];
  return [...(match(part) ? [part] : []), ...elements(part.props.children, match)];
}

const withClass = (part, cls) => elements(part, (el) => el.props.className?.split(" ").includes(cls));
const titles = (part) => withClass(part, "spine-row-title").map((el) => el.props.children);

function spawn(id, parentId, state) {
  return { ...node(id, parentId, id, "Opened", "Spawn"), spawn: state };
}

test("the original client loads one localized, collapsible work tree above the composer", async () => {
  const Dock = await loadDock("zh");
  assert.equal(Dock(undefined), null);
  assert.equal(Dock({ cursor: "1", nodes: [node("1", null, null, "Live", "RootEpoch")] }), null);
  const dock = Dock(deep);
  assert.equal(dock.type, "details");
  assert.equal(dock.props.open, undefined, "disclosure starts closed and the browser owns its state");
  assert.equal(dock.props.children[0].type, "summary");
  assert.equal(withClass(dock, "spine-title")[0].props.children, "工作树");
  assert.equal(withClass(dock, "spine-summary-task")[0].props.children, "deep step");
  assert.deepEqual(titles(dock), ["root task", "first step", "second step", "deep step"]);
  assert.equal(withClass(dock, "spine-branches").length, 2);
  const style = elements(dock, (el) => el.type === "style")[0].props.children;
  const [chevron] = withClass(dock, "spine-chevron");
  assert.equal(chevron.props["aria-hidden"], true);
  const arrow = chevron.props.children;
  assert.equal(arrow.type, "svg");
  assert.equal(arrow.props.width, 14);
  assert.equal(arrow.props.height, 14);
  assert.equal(arrow.props.strokeWidth, 1);
  assert.equal(arrow.props.stroke, "currentColor");
  assert.match(style, /:not\(\[open\]\) \.spine-chevron svg \{ transform: rotate\(180deg\); \}/);
  assert.match(style, /--spine-indent: 18px/);
  assert.match(style, /max-block-size: 180px/);
  assert.equal(elements(dock, (el) => el.props["aria-current"] === true).length, 1);
  assert.equal(withClass(dock, "spine-mark-current")[0].props["aria-label"], "当前");
  assert.equal(withClass(dock, "spine-mark-complete")[0].props["aria-label"], "已完成");
});

test("the dock follows the SDK's parallel sibling window and counts only visible pending branches", async () => {
  const Dock = await loadDock();
  const chain = ["1", "2", "3", "4", "5", "6"].map((id, index) =>
    node(id, index === 0 ? null : String(index), `task ${id}`, index === 5 ? "Live" : "Opened"));
  const pending = Array.from({ length: 5 }, (_, index) => spawn(`parallel ${index}`, "6", "pending"));
  const hidden = spawn("hidden parallel", "1", "pending");
  const tree = { cursor: "6", nodes: [...chain, hidden, ...pending] };
  const dock = Dock(tree);
  const sdkRows = prettySpineTreeLines(tree.cursor, tree.nodes).slice(1).map((line) =>
    line.type === "history" ? `${line.count} earlier branches` : line.label);
  assert.equal(withClass(dock, "spine-title")[0].props.children, "Task tree");
  assert.deepEqual(titles(dock), sdkRows);
  assert.deepEqual(titles(dock).slice(-4), ["2 earlier branches", "parallel 2", "parallel 3", "parallel 4"]);
  assert.equal(withClass(dock, "spine-summary-status")[0].props.children, "\u2002·\u20023 parallel branches");
  assert.equal(withClass(dock, "spine-mark-parallel").length, 3);
  assert.equal(titles(dock).includes("hidden parallel"), false);
  assert.equal(withClass(Dock({ cursor: "6", nodes: [...chain, hidden] }), "spine-summary-status").length, 0);
});

test("a wide tree preserves sibling order and indexes children once", async () => {
  const Dock = await loadDock();
  const root = node("root", null, "work", "Live");
  const siblings = Array.from({ length: 400 }, (_, index) => node(`task-${index}`, "root", `task ${index}`, "Closed"));
  const expected = ["work", "397 earlier branches", "task 397", "task 398", "task 399"];
  let parentReads = 0;
  const observed = siblings.map((sibling) => ({
    ...sibling,
    get parentId() {
      parentReads += 1;
      return sibling.parentId;
    },
  }));
  assert.deepEqual(titles(Dock({ cursor: "root", nodes: [root, ...observed] })), expected);
  assert.ok(parentReads <= siblings.length * 3, `expected linear parent lookups, observed ${parentReads}`);
});

test("parallel results use distinct static icons and earlier branches still fold", async () => {
  const Dock = await loadDock();
  const root = node("1", null, "work", "Live");
  const outcomes = [
    ["completed", "complete", "Completed", ["M5 12l5 5l10 -10"]],
    ["errored", "error", "Failed", ["M18 6l-12 12", "M6 6l12 12"]],
    ["aborted", "aborted", "Aborted", ["M12 19v.01", "M12 15v-10"]]
  ];
  for (const [arrived, mark, label, paths] of outcomes) {
    const dock = Dock({ cursor: "1", nodes: [root, spawn("check", "1", { arrived })] });
    assert.equal(withClass(dock, "spine-mark-parallel").length, 0);
    const [indicator] = withClass(dock, `spine-mark-${mark}`);
    assert.equal(indicator.props["aria-label"], label);
    assert.equal(indicator.props.children.type, "svg");
    assert.deepEqual(elements(indicator, (el) => el.type === "path").map((el) => el.props.d), paths);
    assert.equal(withClass(indicator, "spine-spinner").length, 0);
    assert.equal(withClass(dock, "spine-mark-current").flatMap((el) => withClass(el, "spine-spinner")).length, 1);
  }
  const epoch = node("1", null, null, "Live", "RootEpoch");
  const done = ["one", "two", "three"].map((name) => node(name, "1", name, "Closed"));
  const dock = Dock({ cursor: "1", nodes: [epoch, spawn("old error", "1", { arrived: "errored" }), spawn("old abort", "1", { arrived: "aborted" }), ...done] });
  assert.equal(withClass(dock, "spine-summary").length, 0);
  assert.deepEqual(titles(dock), ["2 earlier branches", "one", "two", "three"]);
});

test("only Spine spawn sessions restrict the native composer controls", async () => {
  const { client, layoutEffects } = await loadClient();
  const registered = [];
  const locales = new Map();
  const states = new Map();
  const storeFor = (id) => {
    if (!states.has(id)) states.set(id, { block: undefined, listeners: new Set() });
    const state = states.get(id);
    return {
      getSnapshot: () => state.block,
      subscribe: (listener) => {
        state.listeners.add(listener);
        return () => state.listeners.delete(listener);
      },
    };
  };
  const blocks = {
    storeFor,
    set(id, block) {
      if (storeFor(id).getSnapshot()?.reason === block?.reason) return;
      const state = states.get(id);
      state.block = block;
      for (const listener of state.listeners) listener();
    },
  };
  client.apply({
    slots: { inject: (_name, register) => register(), register: (entry, component) => registered.push([entry, component]) },
    uiConversation: { events: { register: () => () => {} } },
    conversation: { blocks },
    uiSession: { sessionStatus: { getSnapshot: () => new Map() } },
    locale: {
      bind: (namespace) => (key) => {
        assert.equal(namespace, "conversation");
        assert.equal(key, "input.stop");
        return "停止生成";
      },
      register: (name, dictionaries) => { locales.set(name, dictionaries); return () => locales.delete(name); },
    },
    effect: (execute) => execute(),
  });
  assert.ok(registered.every(([entry]) => entry.name !== "conversation.composer"));
  const [entry, Block] = registered.find(([entry]) => entry.name === "conversation.composer.dock");
  const zh = locales.get(entry.locale).zh;
  const address = { mode: "continuable", parentSessionId: "session-parent", childSessionId: "session-parent:spawn:1.2.3" };
  const mount = (address, sessionId = address?.childSessionId ?? "session-parent") => {
    const css = Block({ sessionId, useSession: (select) => select({ subagent: address ? { address } : null }), t: key => zh[key] });
    const shortcut = layoutEffects.pop();
    const hold = layoutEffects.pop();
    assert.equal(shortcut(), undefined, "without a running DOM occurrence no keyboard handler is installed");
    const release = hold();
    if (release === undefined) assert.equal(css, null);
    else {
      assert.equal(css.type, "style");
      assert.equal(css.props["data-spinejit-child-stop"], "");
      assert.ok(css.props.children.includes('button[aria-label="\\505c \\6b62 \\751f \\6210 "]:not([data-slot^="conversation.input."] *)'));
      assert.match(css.props.children, /interactivity: inert; visibility: visible; opacity: 0.4/);
    }
    return release;
  };
  assert.equal(mount(null), undefined, "parent composer remains available");
  assert.equal(mount({ ...address, childSessionId: "session-other" }), undefined, "ordinary DSH child");
  assert.equal(mount({ ...address, parentSessionId: "session-unrelated" }), undefined, "unmatched parent");
  assert.equal(mount({ ...address, mode: "one-shot" }), undefined, "one-shot child");
  assert.equal(mount(address, "session-other"), undefined, "address from a different session");
  assert.equal(states.size, 0);

  const id = address.childSessionId;
  const first = mount(address);
  assert.equal(storeFor(id).getSnapshot().reason, "请在父会话发送消息");
  const second = mount(address);
  first();
  assert.equal(storeFor(id).getSnapshot().reason, zh.placeholder, "a second occurrence still holds the block");
  const nativeBlock = { reason: "Select a model" };
  blocks.set(id, nativeBlock);
  assert.equal(storeFor(id).getSnapshot(), nativeBlock, "DSH can show its own block");
  blocks.set(id, undefined);
  assert.equal(storeFor(id).getSnapshot().reason, zh.placeholder, "reinstalled when the other block clears");
  blocks.set(id, nativeBlock);
  second();
  assert.equal(storeFor(id).getSnapshot(), nativeBlock, "disposing Spine leaves a different block in place");

  const nested = { ...address, parentSessionId: id, childSessionId: `${id}:spawn:1.4` };
  const disposeNested = mount(nested);
  assert.equal(storeFor(nested.childSessionId).getSnapshot().reason, zh.placeholder);
  disposeNested();
  assert.equal(storeFor(nested.childSessionId).getSnapshot(), undefined);
});
