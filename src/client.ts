// The browser half: the Spine tree in the conversation's input dock, drawn
// whole as Pi draws it, from the session's "spinejit" projection that the host
// folds from the tree records. scripts/build-client.mjs bundles it into
// dist/client.js, the client module the DSH web client loads.
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { useLayoutEffect, useRef } from "react";
import { jsx, jsxs } from "react/jsx-runtime";
import {
  prettySpineTreeLines,
  prettySpineTreeLineText,
  spineTreeMarkerTone,
  type PrettySpineTreeLine,
  type SpineTreeMarkerTone,
} from "@spinejit/spine-sdk/view";

import { compactStatsDefinition } from "./compact-stats.js";
import { spawnIdentity } from "./spawn-id.js";
import { showsTree, TREE_PROJECTION, type SpineTree } from "./tree.js";

type Style = Record<string, string | number>;

/** The dock seat's props the entry reads. */
export interface SpineDockProps {
  useProjection(key: typeof TREE_PROJECTION): SpineTree | null | undefined;
}

interface ComposerBlock {
  readonly reason: string;
}

interface ComposerBlocks {
  set(sessionId: string, block?: ComposerBlock): void;
  storeFor(sessionId: string): {
    getSnapshot(): ComposerBlock | undefined;
    subscribe(notify: () => void): () => void;
  };
}

type ChildAddress = { mode: string; childSessionId: string; parentSessionId: string };

interface SpawnSendProps {
  sessionId: string;
  useSession(select: (session: { running?: boolean; removed?: boolean; subagent?: { address: ChildAddress } | null }) => boolean): boolean;
  t(key: "placeholder"): string;
}

const SPAWN_LOCALE = "spinejit-spawn";
const SPAWN_COPY = {
  en: { placeholder: "Send messages from the parent conversation" },
  zh: { placeholder: "请在父会话发送消息" },
};

/** The part of the client's slot service the entries use. */
interface Slots {
  inject(name: "conversation.input.dock" | "conversation.composer.dock", register: () => unknown): unknown;
  register(
    entry: { name: "conversation.input.dock"; id: string; order: number; registrant: string },
    component: (props: SpineDockProps) => unknown,
  ): unknown;
  register(
    entry: { name: "conversation.composer.dock"; id: string; locale: typeof SPAWN_LOCALE },
    component: (props: SpawnSendProps) => unknown,
  ): unknown;
}

/** Hide only Spine's empty replay markers and reserved slots, not other events. */
const emptySpineContextDefinition = {
  kind: "spinejit.empty-context",
  target: "chat",
  match: {
    "developer/message"(event: SessionEvent<"developer/message">) {
      const { message } = event.data;
      const kind: string = message.source.kind;
      return kind === "spine" && message.content.length === 0
        ? { id: String(event.seq), role: "start" as const, exclusive: true as const }
        : null;
    },
  },
  start: () => null,
  update: () => null,
  buildViewNode: () => null,
};

interface SessionStatus {
  sessionStatus: { getSnapshot(): ReadonlyMap<string, { pendingInteraction: unknown }> };
}

export const inject = ["slots", "uiConversation", "conversation", "locale", "uiSession"];

export function apply(ctx: {
  slots: Slots;
  uiConversation: {
    events: {
      register(definition: typeof emptySpineContextDefinition | typeof compactStatsDefinition): () => void;
    };
  };
  conversation: { blocks: ComposerBlocks };
  uiSession: SessionStatus;
  locale: {
    bind(namespace: "conversation"): (key: "input.stop") => string;
    register(namespace: typeof SPAWN_LOCALE, dictionaries: typeof SPAWN_COPY): () => void;
  };
  effect(execute: () => () => void, label?: string): unknown;
}): void {
  const { blocks } = ctx.conversation;
  const conversationText = ctx.locale.bind("conversation");
  ctx.effect(() => ctx.uiConversation.events.register(emptySpineContextDefinition), "spinejit: hide empty context");
  ctx.effect(() => ctx.uiConversation.events.register(compactStatsDefinition), "spinejit: compact statistics");
  ctx.effect(() => ctx.locale.register(SPAWN_LOCALE, SPAWN_COPY), "spinejit: child composer copy");
  ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
    name: "conversation.composer.dock",
    id: "spinejit.spawn-send-block",
    locale: SPAWN_LOCALE,
  }, function SpineSpawnSendBlock({ sessionId, useSession, t }: SpawnSendProps): unknown {
    const spawned = useSession(session => {
      const address = session.subagent?.address;
      return address?.mode === "continuable" && address.childSessionId === sessionId
        && spawnIdentity(address.childSessionId)?.parent === address.parentSessionId;
    });
    const running = useSession(session => session.running === true && session.removed !== true);
    const styleRef = useRef<HTMLStyleElement | null>(null);
    const reason = t("placeholder");
    useLayoutEffect(() => {
      if (!spawned) return;
      return holdComposerBlock(blocks, sessionId, reason);
    }, [sessionId, spawned, reason]);
    useLayoutEffect(() => {
      if (spawned && running && styleRef.current !== null) {
        return suppressStopShortcut(styleRef.current, sessionId, ctx.uiSession);
      }
    }, [sessionId, spawned, running]);
    if (!spawned) return null;
    return jsx("style", {
      ref: styleRef,
      "data-spinejit-child-stop": "",
      children: stopButtonCss(conversationText("input.stop")),
    });
  }));
  ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
    name: "conversation.input.dock",
    // After the official entries: todo 0, goal 10, activity 15, queue 20.
    id: "spinejit",
    order: 30,
    registrant: "@spinejit/dsh-spinejit",
  }, SpineDock));
}

// The native composer owns the button. Scope its inert state to the card next
// to this dock, using the button's localized accessible name.
function stopButtonCss(label: string): string {
  const escaped = Array.from(label, char => `\\${char.codePointAt(0)!.toString(16)} `).join("");
  const stop = `:has(> [data-composer-dock] [data-spinejit-child-stop]) > [data-composer-card] button[aria-label="${escaped}"]:not([data-slot^="conversation.input."] *)`;
  return `
${stop} { pointer-events: none; visibility: hidden; }
@supports (interactivity: inert) {
  ${stop} { interactivity: inert; visibility: visible; opacity: 0.4; }
}`;
}

function suppressStopShortcut(seat: HTMLStyleElement, sessionId: string, uiSession: SessionStatus): (() => void) | undefined {
  const occurrence = seat.closest<HTMLElement>("[data-conversation-session]");
  if (occurrence?.dataset.conversationSession !== sessionId) return;
  const document = seat.ownerDocument;
  const keydown = (event: KeyboardEvent): void => {
    if (event.code !== "Escape" || event.defaultPrevented || event.repeat || event.isComposing
      || event.ctrlKey || event.altKey || event.shiftKey || event.metaKey || event.keyCode === 229) return;
    const target = event.composedPath().find((node): node is Element => node instanceof Element);
    if (!target || target.closest("[data-conversation-session]") !== occurrence) return;
    const region = target.closest("[data-conversation-region]");
    // A collapsed drawer keeps data-shortcut-modal. Use DSH's active layer selector.
    if (!region || !occurrence.contains(region)
      || target.closest('[data-approval-key], [data-question-key], iframe, .xterm, [inert]')
      || uiSession.sessionStatus.getSnapshot().get(sessionId)?.pendingInteraction !== undefined
      || document.querySelector('[role="dialog"][aria-modal="true"], [role="menu"]')) return;
    // Local handlers run first. DSH's native window listener skips handled keys.
    event.preventDefault();
  };
  document.addEventListener("keydown", keydown);
  return () => document.removeEventListener("keydown", keydown);
}

function holdComposerBlock(blocks: ComposerBlocks, sessionId: string, reason: string): () => void {
  const block = { reason };
  const store = blocks.storeFor(sessionId);
  // Let the native composer show any existing block's reason first.
  const apply = (): void => {
    if (store.getSnapshot() === undefined) blocks.set(sessionId, block);
  };
  const unsubscribe = store.subscribe(apply);
  apply();
  return () => {
    unsubscribe();
    if (store.getSnapshot() === block) blocks.set(sessionId, undefined);
  };
}
// Sized to the composer card, as the official dock rows are.
const BLOCK: Style = {
  boxSizing: "border-box",
  width: "100%",
  maxWidth: "var(--dsh-composer-card-max-width)",
  margin: "0 auto",
  padding: "4px 16px 0",
  fontFamily: "var(--dsw-font-mono, monospace)",
  fontSize: 12,
  lineHeight: "18px",
  color: "var(--dsw-alias-label-secondary)",
};
const ROW: Style = { whiteSpace: "pre", overflow: "hidden", textOverflow: "ellipsis" };
const DIM: Style = { color: "var(--dsw-alias-label-tertiary)" };
const TONE: Record<SpineTreeMarkerTone, Style> = {
  brand: { color: "var(--dsw-alias-state-success-primary)", fontWeight: 600 },
  error: { color: "var(--dsw-alias-state-error-primary)", fontWeight: 600 },
  warning: { color: "var(--dsw-alias-state-warn-primary)", fontWeight: 600 },
  dim: DIM,
};

/** Hook-free but for `useProjection`, so the dock can also call it as a plain function. */
export function SpineDock({ useProjection }: SpineDockProps): unknown {
  const tree = useProjection(TREE_PROJECTION);
  if (!showsTree(tree)) return null;
  return jsx("div", {
    style: BLOCK,
    children: prettySpineTreeLines(tree.cursor, tree.nodes).map((line, index) =>
      jsxs("div", { style: ROW, children: rowParts(line) }, index)),
  });
}

function rowParts(line: PrettySpineTreeLine): unknown[] {
  switch (line.type) {
    case "header":
      return [span(DIM, "• "), span(TONE.brand, "Spine Tree")];
    case "node":
      return [span(DIM, line.prefix), span(TONE[spineTreeMarkerTone(line.marker)], line.marker), ` ${line.label}`];
    default:
      return [span(DIM, prettySpineTreeLineText(line))];
  }
}

function span(style: Style, text: string): unknown {
  return jsx("span", { style, children: text });
}
