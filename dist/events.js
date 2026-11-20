import { createDeveloperMessage, createUserMessage, lastAssistantStreamChunk, } from "@deepseek-ai/dsh-llm";
import { isAppendSurfaceEvent } from "@deepseek-ai/dsh-session";
import { spineArrivalText } from "@spinejit/spine-sdk/host";
import { withoutAnchor } from "./anchors.js";
import { COMPACT_CHECKPOINT_PREFIX } from "./compact-format.js";
export class SpineDshError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = "SpineDshError";
    }
}
/** The message a surface event derives, before any later replacement. */
export function eventMessage(event) {
    switch (event.type) {
        case "user/message":
            return event.data;
        case "system/message":
        case "developer/message":
        case "assistant/message":
        case "tool/result":
            return event.data.message;
        default:
            throw new SpineDshError(`session event ${event.seq} (${event.type}) carries no message`);
    }
}
export function surfaceRole(event) {
    const message = eventMessage(event);
    const kind = message.source.kind;
    if (kind === "spine")
        return "spine";
    if (message.role === "system" || message.role === "developer")
        return "host";
    if (message.role === "user" && kind === "runtime-context")
        return "host";
    return "source";
}
/** A message the user wrote. The Spine core numbers these as `[U<n>]`. */
export function isUserSource(event) {
    return event.type === "user/message" && event.data.source.kind === "user";
}
/**
 * What the Spine core observes for one source event; the boundary is the event
 * seq. `anchorInText`: a user message logged by 0.1.1 or earlier, whose text
 * starts with its own `[U<n>]`; the core sees it without the number.
 */
export function sourceCharacter(event, anchorInText = false) {
    const boundary = event.seq;
    if (event.type === "tool/result")
        return { type: "opaque", boundary };
    const arrival = arrivalOf(event);
    if (arrival !== null)
        return { type: "arrival", boundary, arrival };
    const message = eventMessage(event);
    const content = contentText(message.content);
    if (event.type === "assistant/message") {
        return { type: "message", boundary, role: isReply(event) ? "reply" : "assistant", content };
    }
    if (isUserSource(event)) {
        return { type: "message", boundary, role: "user", content: anchorInText ? withoutAnchor(content) : content };
    }
    if (message.role === "user") {
        return { type: "message", boundary, role: "contextual_user", content };
    }
    throw new SpineDshError(`session event ${event.seq} (${event.type}) is not a Spine source`);
}
/** An empty developer message: on the surface, but derives no model message. */
export function emptySlot() {
    return createDeveloperMessage({ content: [], source: { kind: "spine" } });
}
/** The empty slot a sampling appends first, marking in the log where it began. */
export function samplingSlot() {
    return createDeveloperMessage({ content: [], source: { kind: "spine", sampling: true } });
}
export function beginsSampling(event) {
    if (event.type !== "developer/message" || !isAppendSurfaceEvent(event))
        return false;
    const source = event.data.message.source;
    return source.kind === "spine" && source.sampling === true;
}
/** Where an open sampling's stretch of the log ends: the next sampling begins, or its step ends. */
export function endsSampling(event) {
    return beginsSampling(event) || event.type === "step/end";
}
/** A Spawn child's arrival as the message its parent receives. */
export function arrivalMessage(arrival) {
    return createUserMessage({ content: [{ type: "text", text: spineArrivalText(arrival) }], source: { kind: "spine-arrival", arrival } });
}
/** The arrival a logged message carries, or null. */
export function arrivalOf(event) {
    if (event.type !== "user/message")
        return null;
    const source = event.data.source;
    return source.kind === "spine-arrival" ? source.arrival : null;
}
/** One durable event holds both the epoch barrier and its model-visible replacement. */
export function compactMessage(barrier, summary) {
    return createUserMessage({
        content: [{ type: "text", text: `${COMPACT_CHECKPOINT_PREFIX}${summary.text}` }],
        source: { kind: "spine-compact", barrier, calls: summary.calls },
    });
}
export function compactBarrierOf(event) {
    return event.type === "user/message" && event.data.source.kind === "spine-compact"
        ? event.data.source.barrier : undefined;
}
/** A Spine item (node descriptor, memory, birth) as a model-visible user message. */
export function spineMessage(text) {
    return createUserMessage({ content: [{ type: "text", text }], source: { kind: "spine" } });
}
/** The visible text of a message this plugin wrote; null for an empty slot. */
export function spineText(message) {
    return message.content.length === 0 ? null : contentText(message.content);
}
/**
 * The agent's reply to the user: the response stopped by itself, with text and
 * no tool call. A stream that ends without a finish chunk stopped by itself;
 * DSH logs a finish for every failed or aborted one.
 */
function isReply(event) {
    const content = event.data.message.content;
    return (lastAssistantStreamChunk(event.data.stream, "finish")?.reason.kind ?? "stop") === "stop" &&
        event.data.interrupted !== true &&
        content.every((block) => block.type !== "tool-call") &&
        content.some((block) => block.type === "text" && block.text.trim().length > 0);
}
function contentText(content) {
    let text = "";
    for (const block of content) {
        if (block.type === "text")
            text += block.text;
        else if (block.type === "image")
            text += "<image>";
    }
    return text;
}
//# sourceMappingURL=events.js.map