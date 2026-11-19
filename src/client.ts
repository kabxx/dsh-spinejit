// The browser entry registers the work tree in the input dock and hides
// Spine's empty context markers. scripts/build-client.mjs bundles it into
// dist/client.js, the client module the DSH web client loads.
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { SpineDock, worktreeText, type SpineDockProps } from "./worktree.js";

export { SpineDock, type SpineDockProps } from "./worktree.js";

const LOCALE = "spinejit";

/** The part of the client's slot service the entry uses. */
interface Slots {
  inject(name: "conversation.input.dock", register: () => unknown): unknown;
  register(
    entry: { name: "conversation.input.dock"; id: string; order: number; locale: string; registrant: string },
    component: (props: SpineDockProps) => unknown,
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

export const inject = ["slots", "uiConversation", "locale"];

export function apply(ctx: {
  slots: Slots;
  uiConversation: { events: { register(definition: typeof emptySpineContextDefinition): () => void } };
  locale: { register(namespace: string, dictionaries: typeof worktreeText): () => void };
  effect(execute: () => () => void, label?: string): unknown;
}): void {
  ctx.effect(() => ctx.locale.register(LOCALE, worktreeText), "spinejit: work tree locale");
  ctx.effect(() => ctx.uiConversation.events.register(emptySpineContextDefinition), "spinejit: hide empty context");
  ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
    name: "conversation.input.dock",
    // Between the official Goal (10) and queue (20) entries.
    id: "spinejit",
    order: 19,
    locale: LOCALE,
    registrant: "@spinejit/dsh-spinejit",
  }, SpineDock));
}
