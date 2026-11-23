import { freezeMessage } from "@deepseek-ai/dsh-llm";
import { appendPluginRecord } from "@deepseek-ai/dsh-session";
// A model output Spine moved behind another prefix (a sampling made with a
// node in view that has since folded, a kept reply) loses its reasoning: what the Spine plan labels
// `WithoutReasoning`. DSH keeps logged messages immutable, so the plugin logs
// the decision and a message projection applies it, the same way for a live
// session, a resumed one and a fork.
//
// Stock DSH 0.2.1 admits only its own message-projection event types; a
// session holding an unknown required event cannot be resumed. The decision
// is therefore an ignorable plugin record: DSH applies a registered
// projection by event type before it skips an unknown ignorable event
// (dsh-session planSurfaceEvent, rc.2 and rc.4), and DSH without this plugin
// resumes the session showing the reasoning again.
export const WITHOUT_REASONING = "plugin:spinejit/without-reasoning";
/** The message without its reasoning blocks and provider replay state. */
export function withoutReasoning(message) {
    const content = message.content.filter((block) => block.type !== "reasoning");
    const source = { ...message.source };
    delete source.replayState;
    return freezeMessage({ ...message, content, source });
}
/** Whether the message carries pi-ai replay metadata from the Anthropic Messages API. */
export function isAnthropicMessagesReplay(message) {
    const replayState = message.source.replayState;
    return replayState?.response?.kind === "pi-ai" && replayState.response.api === "anthropic-messages";
}
/**
 * Whether the message still carries reasoning the label asks to drop.
 *
 * Gemini's reasoning is not tied to the prefix: Gemini accepts its thought
 * signatures after the prefix changed, and requires them on the function
 * calls of its current turn, where the sampling after a close sits once the
 * node folds. A Gemini output keeps its reasoning. Only the pi-ai adapter's
 * replay state names the API that produced a message.
 */
export function hasReasoning(message) {
    const replayState = message.source.replayState;
    const api = replayState?.response?.kind === "pi-ai" ? replayState.response.api : undefined;
    if (typeof api === "string" && api.startsWith("google-"))
        return false;
    return message.content.some((block) => block.type === "reasoning") || replayState !== undefined;
}
export const withoutReasoningProjection = {
    type: WITHOUT_REASONING,
    project(event, context) {
        const seqs = event.data?.seqs;
        if (!Array.isArray(seqs) || seqs.length === 0) {
            throw new Error(`${WITHOUT_REASONING}: data must name a nonempty seqs array`);
        }
        const nodes = new Set(context.nodes);
        const messages = new Map();
        for (const seq of seqs) {
            if (typeof seq !== "number" || messages.has(seq))
                throw new Error(`${WITHOUT_REASONING}: bad or duplicate seq ${seq}`);
            if (!nodes.has(seq))
                throw new Error(`${WITHOUT_REASONING}: seq ${seq} is not a current surface node`);
            const source = context.events[seq - context.baseSeq];
            if (source?.type !== "assistant/message") {
                throw new Error(`${WITHOUT_REASONING}: seq ${seq} must be an assistant/message`);
            }
            messages.set(seq, withoutReasoning(context.messages.get(seq) ?? source.data.message));
        }
        return messages;
    },
};
/** Log one decision for the plan's labelled sources that still show reasoning. */
export function dropReasoning(session, seqs) {
    const pending = seqs.filter((seq) => {
        const event = session.eventAt(seq);
        const message = event === undefined ? null : session.deriveEventMessage(event);
        return message !== null && hasReasoning(message);
    });
    if (pending.length > 0)
        appendPluginRecord(session, WITHOUT_REASONING, { seqs: pending });
}
//# sourceMappingURL=reasoning.js.map