import { CONTEXT_WINDOW_EXCEEDED_CODE, createUserMessage, isContextWindowExceededError, LlmError, } from "@deepseek-ai/dsh-llm";
import { SessionSeq } from "@deepseek-ai/dsh-session";
import { joinContextSections, renderContextSections, renderPrompt, } from "@deepseek-ai/dsh-system-prompt";
import { estimateSystemMessage } from "@deepseek-ai/dsh-token-meter/estimate";
import { SPINE_ATTACHMENT, SpineCompactCommitError, } from "./agent.js";
import { estimateIrreducibleTokens, } from "./compact-range.js";
import { PressureConfigError, resolveCompactConfig, resolvePressureSpec, summarizeConversation, } from "./compact-summarizer.js";
// The Web preset mounts this module only after disabling its native compact handlers.
export const name = "spinejit-compact";
export const inject = ["commands", "llm", "sessions"];
class IrreducibleModelSwitchError extends Error {
    constructor(message) {
        super(message);
        this.name = "IrreducibleModelSwitchError";
    }
}
export function apply(ctx, rawConfig = {}) {
    const config = resolveCompactConfig(rawConfig);
    const active = new Set();
    const warnedPressureTargets = new Set();
    const overflowRetries = new WeakMap();
    const overflowAgents = new WeakMap();
    const oversizedInputAgents = new WeakSet();
    const pendingClaimed = new WeakMap();
    const preparedAssembly = new WeakMap();
    const internalAssembling = new WeakSet();
    const track = (promise) => {
        active.add(promise);
        const retire = () => { active.delete(promise); };
        void promise.then(retire, retire);
        return promise;
    };
    ctx.effect(function* () {
        yield async () => { await Promise.allSettled(active); };
        yield ctx.commands.register({
            // DSH resolves /压缩 by this built-in capability ID.
            definitionId: "@deepseek-ai/dsh-command-compact",
            name: "compact",
            description: "Summarize the conversation and start a new SpineJIT task tree",
            handler(invocation) {
                return track(executeManualCompact(ctx, config, invocation));
            },
        });
    });
    if (!config.auto)
        return;
    // Observe step-time system prompt and model-scoped tool resolution read-only so
    // model-switch budgeting can reuse the step's active toolSet and assembly context.
    ctx.on("system-prompt/assemble", async (_assembly, context, next) => {
        const candidate = context?.agent ?? context?.scope;
        if (isAgentLike(candidate) && internalAssembling.has(candidate)) {
            return next();
        }
        const result = await next();
        if (isAgentLike(candidate)) {
            preparedAssembly.set(candidate, {
                modelSelection: context?.modelSelection,
                toolSet: context?.toolSet,
                assembleContext: context === undefined ? undefined : { ...context },
                renderedSystemTokens: estimateAssembledSystemTokens(result),
            });
        }
        return result;
    });
    const logAutoResult = (result, label) => {
        const retained = result.retainedSeqs.length > 0
            ? `, retained ${result.retainedSeqs.length} live sources`
            : "";
        ctx.logger.info(`spinejit-compact (${label}): shadowed ${result.shadowedSeqs.length} surface nodes `
            + `(seqs ${result.shadowedRange.start}-${result.shadowedRange.end}, ~${result.shadowedTokenCount} tokens${retained})`);
    };
    // 1. Step-boundary pressure compaction (runs after spinejit's prepended pre-step settle).
    ctx.on("agent/pre-step", async (payload, next) => {
        const agent = payload?.agent;
        const signal = payload?.signal;
        if (!agent?.session || signal === undefined || signal.aborted)
            return next();
        oversizedInputAgents.delete(agent);
        const decision = await next();
        if (decision.kind !== "enter")
            return decision;
        const claimed = extractClaimedMessages(decision.messages);
        let admittedIds = new Set();
        if (claimed.some((message) => message.source.kind === "spine-arrival")) {
            const attachment = getAttachment(ctx);
            if (attachment !== undefined && !attachment.signal.aborted) {
                try {
                    const spine = await attachment.ensure(agent);
                    admittedIds = await spine.admitPendingArrivals(claimed);
                }
                catch (error) {
                    if (signal.aborted) {
                        pendingClaimed.delete(agent);
                        restoreClaimedOnUserAbort(ctx, agent, signal, claimed, payload.step);
                        return stripAdmittedArrivals(decision, admittedIds);
                    }
                    const message = error instanceof Error ? error.message : String(error);
                    ctx.logger.warn(`spinejit-compact arrival admission failed: ${message}`);
                }
            }
        }
        const remainingClaimed = admittedIds.size === 0
            ? claimed
            : claimed.filter((message) => !admittedIds.has(message.id));
        if (signal.aborted) {
            pendingClaimed.delete(agent);
            restoreClaimedOnUserAbort(ctx, agent, signal, remainingClaimed, payload.step);
            return stripAdmittedArrivals(decision, admittedIds);
        }
        if (payload.turn !== undefined && payload.step !== undefined) {
            if (remainingClaimed.length > 0) {
                pendingClaimed.set(agent, { turn: payload.turn, step: payload.step, messages: remainingClaimed });
            }
            else {
                pendingClaimed.delete(agent);
            }
        }
        const remainingDecisionMessages = admittedIds.size === 0
            ? decision.messages
            : decision.messages.filter((message) => !admittedIds.has(message.id));
        try {
            const result = await track(maybeCompactPreStep(ctx, config, agent, { ...payload, messages: remainingDecisionMessages }, signal, warnedPressureTargets));
            if (result === "input-exceeds-budget") {
                oversizedInputAgents.add(agent);
            }
            else if (result !== null) {
                logAutoResult(result, "step pressure");
            }
        }
        catch (error) {
            if (signal.aborted) {
                return stripAdmittedArrivals(decision, admittedIds);
            }
            if (error instanceof PressureConfigError) {
                if (!warnedPressureTargets.has(error.targetKey)) {
                    warnedPressureTargets.add(error.targetKey);
                    ctx.logger.warn(`spinejit-compact pressure check skipped: ${error.message}`);
                }
                return stripAdmittedArrivals(decision, admittedIds);
            }
            const message = error instanceof Error ? error.message : String(error);
            ctx.logger.warn(`spinejit-compact step compaction failed: ${message}; continuing the turn`);
        }
        finally {
            if (signal.aborted) {
                pendingClaimed.delete(agent);
                restoreClaimedOnUserAbort(ctx, agent, signal, remainingClaimed, payload.step);
            }
        }
        return stripAdmittedArrivals(decision, admittedIds);
    });
    // 2. Model-switch compaction (prepended so it wraps routing listeners and sees the final config
    //    while session.requestHeader() still identifies the previous model).
    ctx.on("agent/request", async (payload, next) => {
        const nextConfig = await next();
        const agent = payload?.agent;
        const signal = payload?.signal;
        if (!agent?.session || signal === undefined)
            return nextConfig;
        const pending = pendingClaimed.get(agent);
        const sameStep = pending !== undefined && pending.turn === payload.turn && pending.step === payload.step;
        if (signal.aborted) {
            if (sameStep) {
                pendingClaimed.delete(agent);
                restoreClaimedOnUserAbort(ctx, agent, signal, pending.messages, payload.step);
            }
            return nextConfig;
        }
        const previous = agent.session.requestHeader();
        const sameRoute = previous !== undefined
            && nextConfig?.provider === previous.config.provider
            && nextConfig?.model === previous.config.model;
        if (!sameRoute) {
            oversizedInputAgents.delete(agent);
        }
        if (previous === undefined
            || !nextConfig?.provider
            || !nextConfig?.model
            || sameRoute) {
            if (sameStep)
                pendingClaimed.delete(agent);
            return nextConfig;
        }
        const unloggedClaimed = sameStep ? filterUnloggedMessages(agent.session, pending.messages) : [];
        const prepared = preparedAssembly.get(agent);
        const replaceGenBefore = agent.session.surface.replaceGeneration;
        try {
            const result = await track(maybeCompactModelSwitch(ctx, config, agent, previous, nextConfig, unloggedClaimed, prepared, internalAssembling, payload.turn, payload.step, signal));
            if (result !== null)
                logAutoResult(result, "model switch");
            signal.throwIfAborted();
        }
        catch (error) {
            if (signal.aborted) {
                restoreClaimedOnUserAbort(ctx, agent, signal, unloggedClaimed, payload.step);
                signal.throwIfAborted();
            }
            const restored = restoreUnloggedClaimed(agent, unloggedClaimed, payload.step);
            const message = error instanceof Error ? error.message : String(error);
            const committedNotice = agent.session.surface.replaceGeneration > replaceGenBefore
                ? " Note: an earlier compaction checkpoint was already saved for this session, so the conversation history has been compacted."
                : "";
            const guidance = formatModelSwitchFailureGuidance(error instanceof IrreducibleModelSwitchError, restored);
            throw new LlmError(`Cannot switch to ${nextConfig.provider}/${nextConfig.model}: SpineJIT compaction failed: ${message}. `
                + `${guidance}${committedNotice}`, "MODEL_SWITCH_COMPACTION_FAILED", { cause: error });
        }
        finally {
            if (sameStep)
                pendingClaimed.delete(agent);
        }
        return nextConfig;
    }, { prepend: true });
    // Reset per-agent overflow retry counter once idle or after any successful assistant message.
    ctx.on("agent/status", ({ agent, status }) => {
        if (status === "idle") {
            overflowRetries.delete(agent);
            oversizedInputAgents.delete(agent);
            pendingClaimed.delete(agent);
            preparedAssembly.delete(agent);
        }
    });
    ctx.on("session/event", (session, event) => {
        if (event.type !== "assistant/message")
            return;
        const agent = overflowAgents.get(session);
        if (agent !== undefined)
            overflowRetries.delete(agent);
    });
    // 3. Provider-confirmed context-overflow recovery compaction + automatic retry.
    ctx.on("agent/request-error", async (payload, next) => {
        const agent = payload?.agent;
        const failure = payload?.failure;
        const signal = payload?.signal;
        if (!agent?.session || failure === undefined || signal === undefined || signal.aborted)
            return next();
        const overflow = failure.code === CONTEXT_WINDOW_EXCEEDED_CODE
            || isContextWindowExceededError(`${failure.code} ${failure.message}`);
        if (!overflow)
            return next();
        if (oversizedInputAgents.has(agent)) {
            ctx.logger.warn("spinejit-compact: skipping overflow recovery because new input and request overhead alone exceed the model input budget");
            return next();
        }
        overflowAgents.set(agent.session, agent);
        const retries = overflowRetries.get(agent) ?? 0;
        if (retries >= config.maxOverflowRetries)
            return next();
        const attachment = getAttachment(ctx);
        if (attachment === undefined)
            return next();
        const combined = AbortSignal.any([signal, attachment.signal]);
        if (combined.aborted)
            return next();
        const generation = agent.session.surface.replaceGeneration;
        try {
            const result = await track(compactOnOverflow(ctx, config, attachment, agent, combined));
            if (signal.aborted || agent.session.surface.replaceGeneration <= generation)
                return next();
            if (result !== null)
                logAutoResult(result, "context overflow recovery");
            overflowRetries.set(agent, retries + 1);
            return { kind: "retry" };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!signal.aborted && agent.session.surface.replaceGeneration > generation) {
                ctx.logger.warn(`spinejit-compact overflow recovery failed after durable progress: ${message}; retrying from replacement surface`);
                overflowRetries.set(agent, retries + 1);
                return { kind: "retry" };
            }
            ctx.logger.warn(`spinejit-compact overflow recovery failed: ${message}; ${signal.aborted ? "cancellation prevents retry" : "preserving the original request error"}`);
            return next();
        }
    });
}
function getAttachment(ctx) {
    return ctx.reflect.get(SPINE_ATTACHMENT);
}
function getTokenMeter(ctx) {
    const meter = ctx.get?.("tokenMeter")
        ?? ctx.reflect.get("tokenMeter");
    if (meter !== null && typeof meter === "object" && typeof meter.measure === "function") {
        return meter;
    }
    return undefined;
}
function pickRoute(config) {
    return {
        provider: config.provider,
        model: config.model,
        ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
    };
}
function resolveConversationRoute(agent, preferred) {
    if (preferred !== undefined && preferred.provider.length > 0 && preferred.model.length > 0) {
        return pickRoute(preferred);
    }
    const header = agent.session.requestHeader()?.config;
    if (header !== undefined && header.provider.length > 0 && header.model.length > 0) {
        return pickRoute(header);
    }
    const modelAccess = agent.model;
    const selected = typeof modelAccess?.current === "function" ? modelAccess.current() : undefined;
    if (selected !== undefined && selected.provider.length > 0 && selected.model.length > 0) {
        return pickRoute(selected);
    }
    if (agent.options.provider && agent.options.model) {
        return pickRoute({
            provider: agent.options.provider,
            model: agent.options.model,
            ...(agent.options.reasoningEffort === undefined ? {} : { reasoningEffort: agent.options.reasoningEffort }),
        });
    }
    return undefined;
}
function resolveSummaryRoute(config, conversationRoute) {
    if (config.summarizationProvider !== undefined && config.summarizationModel !== undefined) {
        const sameAsConversation = conversationRoute !== undefined
            && conversationRoute.provider === config.summarizationProvider
            && conversationRoute.model === config.summarizationModel;
        return {
            provider: config.summarizationProvider,
            model: config.summarizationModel,
            ...(sameAsConversation && conversationRoute.reasoningEffort !== undefined
                ? { reasoningEffort: conversationRoute.reasoningEffort }
                : {}),
        };
    }
    if (conversationRoute === undefined) {
        throw new Error("No model is available to generate a summary.");
    }
    return conversationRoute;
}
async function runCompactWithSummarizer(ctx, config, spine, options) {
    const { agent } = spine;
    const tokenMeter = getTokenMeter(ctx);
    return spine.compact({
        mode: options.mode,
        trigger: options.trigger,
        retainTokens: options.retainTokens,
        tokenMeter,
        header: options.header,
        signal: options.signal,
        summarize: (selection) => summarizeConversation(ctx, {
            agent,
            config,
            route: typeof options.summaryRoute === "function" ? options.summaryRoute() : options.summaryRoute,
            systemHead: selection.systemHead,
            messages: selection.messages,
            prefixCacheEligible: selection.prefixCacheEligible,
            header: options.header,
            forceClean: options.forceClean,
            calls: options.calls,
            signal: options.signal,
            recoverError: async (error) => recoverSummaryError(ctx, agent.session, selection.shadowedSeqs, error, options.signal),
            refreshMessages: () => refreshSelectionMessages(agent.session, selection),
        }),
        flush: async () => {
            const flushed = await ctx.sessions.flush(agent.session);
            if (options.requirePersistence && !flushed) {
                throw new Error("No session persistence is available.");
            }
        },
    });
}
async function recoverSummaryError(ctx, session, sourceEventSeqs, error, signal) {
    try {
        const recovered = await ctx.waterfall("compaction/summary-error", { session, sourceEventSeqs, error, signal }, () => false);
        return recovered === true;
    }
    catch {
        return false;
    }
}
function refreshSelectionMessages(session, selection) {
    const nodes = session.surface.nodes;
    const headEvent = nodes.length > 0 ? session.eventAt(nodes[0]) : undefined;
    const systemHead = headEvent?.type === "system/message"
        ? session.deriveEventMessage(headEvent)
        : null;
    const messages = [];
    for (const seq of selection.shadowedSeqs) {
        const event = session.eventAt(seq);
        if (event === undefined)
            continue;
        const derived = session.deriveEventMessage(event);
        if (derived !== null)
            messages.push(derived);
    }
    return { systemHead, messages };
}
async function executeManualCompact(ctx, config, { agent, rawInput, signal }) {
    if (rawInput.trim() !== "")
        return { kind: "error", text: "Usage: /compact (no arguments)" };
    const calls = [];
    try {
        const checkpoint = await agent.runMaintenance(async (maintenanceSignal) => {
            const attachment = getAttachment(ctx);
            if (attachment === undefined)
                throw new Error("SpineJIT is unavailable in this session.");
            const combined = AbortSignal.any([signal, maintenanceSignal, attachment.signal]);
            combined.throwIfAborted();
            const spine = await attachment.ensure(agent);
            const header = agent.session.requestHeader();
            return runCompactWithSummarizer(ctx, config, spine, {
                mode: "manual",
                trigger: "manual",
                retainTokens: 0,
                header,
                summaryRoute: () => resolveSummaryRoute(config, resolveConversationRoute(agent)),
                requirePersistence: true,
                calls,
                signal: combined,
            });
        });
        return checkpoint === null
            ? { kind: "success", text: "No new conversation history to compact." }
            : {
                kind: "success",
                text: `${compactHeading(checkpoint.shadowedTokenCount, calls)}\n\n${checkpoint.summary}`,
                sourceEventSeq: checkpoint.seq,
            };
    }
    catch (error) {
        const cause = error instanceof Error ? error.cause : undefined;
        const usageNote = formatCompletedUsageNote(calls);
        const suffix = usageNote === null ? "" : ` ${usageNote}`;
        if (!(cause instanceof SpineCompactCommitError) && signal.aborted) {
            return { kind: "error", text: `Compaction cancelled.${suffix}` };
        }
        const reason = cause instanceof SpineCompactCommitError
            ? cause.message
            : error instanceof Error ? error.message : String(error);
        return { kind: "error", text: `SpineJIT compact failed. ${reason}${suffix}` };
    }
}
async function maybeCompactPreStep(ctx, config, agent, payload, signal, warnedPressureTargets) {
    const header = agent.session.requestHeader();
    if (header === undefined || !header.config.provider || !header.config.model)
        return null;
    // If DSH 0.2.2+ selected a different model for the upcoming step, defer to
    // the agent/request model-switch hook so summarization uses the previous model.
    const sel = payload.modelSelection;
    if (sel?.provider
        && sel?.model
        && (sel.provider !== header.config.provider || sel.model !== header.config.model)) {
        return null;
    }
    const attachment = getAttachment(ctx);
    if (attachment === undefined)
        return null;
    const combined = AbortSignal.any([signal, attachment.signal]);
    combined.throwIfAborted();
    const target = pickRoute(header.config);
    const targetKey = `${target.provider}/${target.model}`;
    const info = await ctx.llm.resolveModelInfo(target.provider, target.model, combined);
    if (info.context === undefined) {
        if (!warnedPressureTargets.has(targetKey)) {
            warnedPressureTargets.add(targetKey);
            ctx.logger.warn(`spinejit-compact: no context capacity for ${targetKey}; skipping automatic pressure check`);
        }
        return null;
    }
    const reservedOutput = header.config.maxTokens ?? info.defaultMaxTokens ?? 0;
    const spec = resolvePressureSpec(config, targetKey, info.context.contextWindow, reservedOutput);
    const spine = await attachment.ensure(agent);
    const tokenMeter = getTokenMeter(ctx);
    const pricing = resolveMessagePricing(ctx, header);
    const effectiveTokens = spine.effectiveTokenCount(tokenMeter, header, payload.messages, pricing);
    if (effectiveTokens < spec.thresholdTokens)
        return null;
    // Do not compact prior history if the irreducible request floor (system prompt +
    // tools + newly claimed input) alone already exceeds the model's input capacity:
    // compacting history could not make the upcoming request fit and would only
    // replace live history before the provider rejects the oversized message.
    const messageBudgetTokens = info.context.contextWindow - reservedOutput;
    const irreducibleTokens = estimateIrreducibleTokens(agent.session, tokenMeter, header, payload.messages, pricing);
    if (irreducibleTokens >= messageBudgetTokens) {
        ctx.logger.warn(`spinejit-compact: skipping step compaction because new input and request overhead alone `
            + `(${irreducibleTokens} estimated tokens) exceed the ${messageBudgetTokens}-token input budget`);
        return "input-exceeds-budget";
    }
    if (spine.hasUnarrivedBirths()) {
        ctx.logger.info("spinejit-compact: deferring automatic compaction while parallel Spawn branches are running");
        return null;
    }
    const calls = [];
    const summaryRoute = resolveSummaryRoute(config, target);
    return runCompactWithSummarizer(ctx, config, spine, {
        mode: "auto",
        trigger: "pressure",
        retainTokens: spec.retainTokens,
        header,
        summaryRoute,
        requirePersistence: false,
        calls,
        signal: combined,
    });
}
async function maybeCompactModelSwitch(ctx, config, agent, previous, nextConfig, claimedMessages, prepared, internalAssembling, turn, step, signal) {
    const attachment = getAttachment(ctx);
    if (attachment === undefined)
        return null;
    const combined = AbortSignal.any([signal, attachment.signal]);
    combined.throwIfAborted();
    const targetKey = `${nextConfig.provider}/${nextConfig.model}`;
    const info = await ctx.llm.resolveModelInfo(nextConfig.provider, nextConfig.model, combined);
    if (info.context === undefined)
        return null;
    const { header: proposedHeader, targetSystemTokens, targetContextSections } = await resolveTargetHeader(ctx, agent, previous, nextConfig, prepared, internalAssembling, combined);
    const targetPricing = resolveMessagePricing(ctx, proposedHeader);
    const reservedOutput = nextConfig.maxTokens ?? info.defaultMaxTokens ?? 0;
    const spec = resolvePressureSpec(config, targetKey, info.context.contextWindow, reservedOutput);
    // DSH's `SystemPromptProjection` clears later in-history `system/message` nodes
    // whenever the target route does not accept mid-history system updates or renders empty.
    const clearLaterSystemMessages = info.systemPromptUpdate !== "in-history" || targetSystemTokens === 0;
    const pendingExtras = (forceReemit) => {
        if (targetContextSections === undefined)
            return claimedMessages;
        const contextMessage = projectPendingRuntimeContext(agent.session, targetContextSections, forceReemit);
        return contextMessage === undefined ? claimedMessages : [...claimedMessages, contextMessage];
    };
    const spine = await attachment.ensure(agent);
    const tokenMeter = getTokenMeter(ctx);
    let effectiveTokens = spine.effectiveTokenCount(tokenMeter, proposedHeader, pendingExtras(false), targetPricing, targetSystemTokens, clearLaterSystemMessages);
    if (effectiveTokens < spec.thresholdTokens)
        return null;
    if (spine.hasUnarrivedBirths()) {
        throw new Error("parallel Spawn branches are still running; wait for them to return before switching to a smaller-window model");
    }
    // Fail fast before summarizing or mutating history if the non-compactable
    // request floor (system prompt + target tools + newly claimed input +
    // re-emitted runtime context) alone already reaches the target threshold.
    const irreducibleTokens = estimateIrreducibleTokens(agent.session, tokenMeter, proposedHeader, pendingExtras(true), targetPricing, targetSystemTokens);
    if (irreducibleTokens >= spec.thresholdTokens) {
        if (claimedMessages.length > 0) {
            throw new IrreducibleModelSwitchError(`new input and request overhead alone (${irreducibleTokens} estimated tokens) exceed target threshold ${spec.thresholdTokens}`);
        }
        throw new IrreducibleModelSwitchError(`system prompt, tools, and runtime context alone (${irreducibleTokens} estimated tokens) exceed target threshold ${spec.thresholdTokens}`);
    }
    // Summarize using the previous (already warm / larger-window) model unless overridden.
    const summaryRoute = resolveSummaryRoute(config, pickRoute(previous.config));
    const firstCalls = [];
    let result = await runCompactWithSummarizer(ctx, config, spine, {
        mode: "auto",
        trigger: "model-switch",
        retainTokens: spec.retainTokens,
        header: previous,
        summaryRoute,
        requirePersistence: false,
        calls: firstCalls,
        signal: combined,
    });
    if (result !== null && turn !== undefined && step !== undefined) {
        await spine.enterStep(turn, step);
    }
    effectiveTokens = spine.effectiveTokenCount(tokenMeter, proposedHeader, pendingExtras(false), targetPricing, targetSystemTokens, clearLaterSystemMessages);
    if (effectiveTokens >= spec.thresholdTokens && spec.retainTokens > 0) {
        const secondCalls = [];
        const full = await runCompactWithSummarizer(ctx, config, spine, {
            mode: "auto",
            trigger: "model-switch",
            retainTokens: 0,
            header: previous,
            summaryRoute,
            requirePersistence: false,
            calls: secondCalls,
            signal: combined,
        });
        if (full !== null) {
            result = full;
            if (turn !== undefined && step !== undefined) {
                await spine.enterStep(turn, step);
            }
        }
        effectiveTokens = spine.effectiveTokenCount(tokenMeter, proposedHeader, pendingExtras(false), targetPricing, targetSystemTokens, clearLaterSystemMessages);
    }
    if (effectiveTokens >= spec.thresholdTokens) {
        throw new Error(`context remains above target threshold after compaction (${effectiveTokens} estimated tokens >= threshold ${spec.thresholdTokens})`);
    }
    return result;
}
async function compactOnOverflow(ctx, config, attachment, agent, signal) {
    const spine = await attachment.ensure(agent);
    if (spine.hasUnarrivedBirths()) {
        ctx.logger.warn("spinejit-compact: cannot run overflow recovery while parallel Spawn branches are running");
        return null;
    }
    const header = agent.session.requestHeader();
    const route = resolveConversationRoute(agent);
    const summaryRoute = resolveSummaryRoute(config, route);
    const calls = [];
    return runCompactWithSummarizer(ctx, config, spine, {
        mode: "auto",
        trigger: "context-overflow",
        retainTokens: 0,
        header,
        summaryRoute,
        // The provider already rejected this exact prefix for exceeding the window,
        // so go directly to the tool-free summarizer with in-memory oversized tool-result pruning.
        forceClean: true,
        requirePersistence: false,
        calls,
        signal,
    });
}
function compactHeading(shadowedTokenCount, calls) {
    let reported = 0;
    let input = 0;
    for (const { usage } of calls) {
        if (usage === undefined)
            continue;
        reported += 1;
        input += usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
    }
    const hasShadowed = shadowedTokenCount > 0;
    const hasUsage = reported > 0 && input > 0;
    if (hasShadowed && hasUsage) {
        return `Compacted conversation (~${shadowedTokenCount.toLocaleString("en-US")} history tokens; `
            + `summary used ~${input.toLocaleString("en-US")} input tokens).`;
    }
    if (hasShadowed) {
        return `Compacted conversation (~${shadowedTokenCount.toLocaleString("en-US")} history tokens).`;
    }
    if (hasUsage) {
        return `Compacted conversation (summary used ~${input.toLocaleString("en-US")} input tokens).`;
    }
    return "Compacted conversation.";
}
function formatCompletedUsageNote(calls) {
    let reported = 0;
    let input = 0;
    let output = 0;
    for (const { usage } of calls) {
        if (usage === undefined)
            continue;
        reported += 1;
        input += usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
        output += usage.outputTokens;
    }
    if (reported === 0 || (input === 0 && output === 0))
        return null;
    const callLabel = reported === 1 ? "1 call" : `${reported} calls`;
    return `Completed summary usage: ~${input.toLocaleString("en-US")} input / ${output.toLocaleString("en-US")} output tokens across ${callLabel}.`;
}
function isAgentLike(value) {
    return value !== null && typeof value === "object" && "session" in value && "id" in value;
}
function getToolsService(ctx) {
    const service = ctx.get?.("tools")
        ?? ctx.reflect.get("tools");
    if (service !== null && typeof service === "object") {
        return service;
    }
    return undefined;
}
function getSystemPromptService(ctx) {
    const service = ctx.get?.("systemPrompt")
        ?? ctx.reflect.get("systemPrompt");
    if (service !== null && typeof service === "object") {
        return service;
    }
    return undefined;
}
function estimateAssembledSystemTokens(assembled) {
    if (assembled === null || typeof assembled !== "object")
        return undefined;
    const candidate = assembled;
    if (!Array.isArray(candidate.sections))
        return undefined;
    try {
        const rendered = renderPrompt({
            sections: candidate.sections,
            contexts: Array.isArray(candidate.contexts) ? candidate.contexts : [],
            variables: candidate.variables !== null && typeof candidate.variables === "object" ? candidate.variables : {},
            tools: [],
        });
        if (rendered.length === 0)
            return 0;
        return estimateSystemMessage({
            role: "system",
            content: [{ type: "text", text: rendered }],
        });
    }
    catch {
        return undefined;
    }
}
async function resolveTargetHeader(ctx, agent, previous, nextConfig, prepared, internalAssembling, signal) {
    const isPtc = previous.tools?.some((tool) => tool.name === "run_code") ?? false;
    const toolsService = getToolsService(ctx);
    const systemPromptService = getSystemPromptService(ctx);
    const preparedMatchesTarget = prepared !== undefined && (prepared.modelSelection === undefined
        || (prepared.modelSelection.provider === nextConfig.provider && prepared.modelSelection.model === nextConfig.model));
    const targetSelection = {
        provider: nextConfig.provider,
        model: nextConfig.model,
        ...(nextConfig.reasoningEffort === undefined ? {} : { reasoningEffort: nextConfig.reasoningEffort }),
    };
    let ownedToolSet;
    let targetToolSet;
    if (preparedMatchesTarget && prepared.toolSet !== undefined) {
        targetToolSet = prepared.toolSet;
    }
    else if (toolsService !== undefined && typeof toolsService.resolve === "function") {
        ownedToolSet = await toolsService.resolve({
            agent,
            modelSelection: targetSelection,
            signal,
        });
        targetToolSet = ownedToolSet;
    }
    let targetSystemTokens = preparedMatchesTarget ? prepared.renderedSystemTokens : undefined;
    let targetContextSections;
    let targetTools;
    try {
        if (systemPromptService !== undefined && typeof systemPromptService.assemble === "function") {
            // Run authoritative prompt assembly for the target model so:
            // 1) `complete: true` persona sections replace default sections exactly as DSH does;
            // 2) provider-owned tools (including model-scoped tools and PTC `run_code`) are exact;
            // 3) live runtime-context providers and suppressors reflect the step's current facts.
            internalAssembling.add(agent);
            try {
                const assembled = await systemPromptService.assemble({
                    ...(prepared?.assembleContext ?? {}),
                    agent,
                    scope: agent,
                    signal,
                    modelSelection: targetSelection,
                    ...(targetToolSet === undefined ? {} : { toolSet: targetToolSet }),
                });
                const rendered = renderPrompt(assembled);
                targetSystemTokens = rendered.length === 0
                    ? 0
                    : estimateSystemMessage({
                        role: "system",
                        content: [{ type: "text", text: rendered }],
                    });
                targetContextSections = renderContextSections(assembled);
                if (toolsService !== undefined || assembled.tools.length > 0) {
                    targetTools = assembled.tools;
                }
            }
            catch {
                // Fall back to captured assembly metadata and toolsService schemas if custom assembly fails.
            }
            finally {
                internalAssembling.delete(agent);
            }
        }
        if (targetTools === undefined && !isPtc && toolsService !== undefined && typeof toolsService.schemas === "function") {
            targetTools = targetToolSet !== undefined
                ? toolsService.schemas(agent, targetToolSet)
                : toolsService.schemas(agent);
        }
    }
    finally {
        ownedToolSet?.dispose?.();
    }
    const { tools: _previousTools, ...rest } = previous;
    const effectiveTools = targetTools !== undefined ? targetTools : previous.tools;
    const header = {
        ...rest,
        config: nextConfig,
        ...(effectiveTools !== undefined && effectiveTools.length > 0 ? { tools: [...effectiveTools] } : {}),
    };
    return { header, targetSystemTokens, targetContextSections };
}
const RUNTIME_CONTEXT_CLEARED_REMINDER = "<system-reminder>\nCurrent runtime context: none. Earlier runtime-context snapshots no longer apply.\n</system-reminder>";
function runtimeContextSectionsEqual(a, b) {
    if (a.length !== b.length)
        return false;
    for (let index = 0; index < a.length; index += 1) {
        if (a[index].name !== b[index].name || a[index].text !== b[index].text)
            return false;
    }
    return true;
}
/**
 * Predict the runtime-context user message DSH's `RuntimeContextProjection`
 * will append right after `agent/request`. When `forceReemit` is true (for
 * irreducible-floor checks), assume compaction will shadow any currently
 * retained snapshot so the re-emitted snapshot is included in the floor.
 */
function projectPendingRuntimeContext(session, sections, forceReemit) {
    const surface = new Set(session.surface.nodes);
    let state = "never";
    let retainedSections;
    let retainedText;
    for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
        const event = session.eventAt(SessionSeq(seq));
        if (event?.type !== "user/message" || event.data.source.kind !== "runtime-context")
            continue;
        if (surface.has(event.seq)) {
            state = "retained";
            const src = event.data.source;
            if (src.form === "snapshot" && Array.isArray(src.sections)) {
                retainedSections = src.sections;
            }
            const firstBlock = event.data.content[0];
            if (event.data.content.length === 1 && firstBlock?.type === "text") {
                retainedText = firstBlock.text;
            }
        }
        else {
            state = "shadowed";
        }
        break;
    }
    if (forceReemit && state === "retained") {
        state = "shadowed";
    }
    if (state === "never" && sections.length === 0)
        return undefined;
    if (state === "retained") {
        if (retainedSections !== undefined && runtimeContextSectionsEqual(retainedSections, sections)) {
            return undefined;
        }
        if (retainedSections === undefined && retainedText !== undefined) {
            if (sections.length === 0 && retainedText.includes("Current runtime context: none")) {
                return undefined;
            }
            if (sections.length > 0 && retainedText === joinContextSections(sections)) {
                return undefined;
            }
        }
    }
    const intro = state === "never"
        ? "The following information describes your current session:"
        : "The following information describes your current session. It replaces earlier versions of this context, including any retained in conversation summaries.";
    const body = sections.map((section) => section.text).join("\n\n")
        .replace(/<\/system-reminder\s*>/gi, (tag) => `<\\${tag.slice(1)}`);
    const snapshot = sections.length === 0
        ? RUNTIME_CONTEXT_CLEARED_REMINDER
        : `<system-reminder>\n${intro}\n\n${body}\n</system-reminder>`;
    return createUserMessage({
        content: [{ type: "text", text: snapshot }],
        source: { kind: "runtime-context" },
    });
}
function resolveMessagePricing(ctx, header) {
    const llm = ctx.llm;
    const config = header?.config;
    const imagePricing = config !== undefined && typeof llm.imageRequestPricing === "function"
        ? llm.imageRequestPricing(config.provider, config.model)
        : undefined;
    const fileText = typeof llm.fileRequestText === "function"
        ? (ref) => llm.fileRequestText(ref)
        : undefined;
    if (imagePricing === undefined && fileText === undefined)
        return undefined;
    return { imagePricing, fileText };
}
function stripAdmittedArrivals(decision, admittedArrivalIds) {
    if (admittedArrivalIds.size === 0 || decision.kind !== "enter")
        return decision;
    const filtered = decision.messages.filter((message) => !admittedArrivalIds.has(message.id));
    if (filtered.length > 0) {
        return { ...decision, messages: filtered };
    }
    // Keep a non-empty enter decision so the agent loop does not short-circuit
    // step 0 as an empty turn; runtime-context markers with no active context
    // snapshot are not appended to the session log.
    const keepalive = createUserMessage({
        content: [],
        source: { kind: "runtime-context" },
    });
    return { ...decision, messages: [keepalive] };
}
function extractClaimedMessages(messages) {
    if (!Array.isArray(messages) || messages.length === 0)
        return [];
    return messages.filter((message) => message?.role === "user" && message.source?.kind !== "runtime-context");
}
function sessionHasUserMessageId(session, id) {
    for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
        const event = session.eventAt(SessionSeq(seq));
        if (event?.type === "user/message" && event.data.id === id)
            return true;
    }
    return false;
}
function filterUnloggedMessages(session, messages) {
    return messages.filter((message) => !sessionHasUserMessageId(session, message.id));
}
function resolveOriginalInboxTarget(session, message, step) {
    for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
        const event = session.eventAt(SessionSeq(seq));
        if (event?.type !== "agent/inbox/spliced")
            continue;
        if (event.data.inserted.some((item) => item.id === message.id)) {
            return event.data.target;
        }
    }
    return step === 0 && message.source.kind === "user" ? "next-turn" : "next-step";
}
function isUserCancelAbort(signal) {
    if (!signal.aborted)
        return false;
    const reason = signal.reason;
    return typeof reason === "object"
        && reason !== null
        && reason.kind === "user";
}
function isAgentArchived(ctx, agent) {
    const registry = (ctx.get?.("workspaceRegistry")
        ?? ctx.reflect.get("workspaceRegistry"));
    return registry?.archivedSessionIds?.includes(agent.session.id) ?? false;
}
function restoreClaimedOnUserAbort(ctx, agent, signal, messages, step) {
    if (messages.length === 0 || !isUserCancelAbort(signal) || isAgentArchived(ctx, agent)) {
        return;
    }
    restoreUnloggedClaimed(agent, messages, step);
}
function restoreUnloggedClaimed(agent, messages, step) {
    if (messages.length === 0)
        return { nextTurn: 0, nextStep: 0 };
    const inbox = agent.inbox;
    if (inbox === undefined || typeof inbox.splice !== "function")
        return { nextTurn: 0, nextStep: 0 };
    const pendingIds = new Set();
    for (const item of inbox.nextStep)
        pendingIds.add(item.id);
    for (const item of inbox.nextTurn)
        pendingIds.add(item.id);
    const toRestoreNextTurn = [];
    const toRestoreNextStep = [];
    for (const message of messages) {
        if (pendingIds.has(message.id) || sessionHasUserMessageId(agent.session, message.id))
            continue;
        if (resolveOriginalInboxTarget(agent.session, message, step) === "next-turn") {
            toRestoreNextTurn.push(message);
        }
        else {
            toRestoreNextStep.push(message);
        }
    }
    if (toRestoreNextTurn.length > 0)
        inbox.splice("next-turn", 0, 0, toRestoreNextTurn);
    if (toRestoreNextStep.length > 0)
        inbox.splice("next-step", 0, 0, toRestoreNextStep);
    return { nextTurn: toRestoreNextTurn.length, nextStep: toRestoreNextStep.length };
}
function formatModelSwitchFailureGuidance(irreducible, restored) {
    if (irreducible) {
        if (restored.nextTurn > 0 && restored.nextStep === 0) {
            return "The previous request model is preserved and the original message was returned to the pending queue — edit or remove that queued message before retrying on this model, or switch back to a larger-window model.";
        }
        if (restored.nextStep > 0 && restored.nextTurn === 0) {
            return "The previous request model is preserved and the pending next-step input was returned to the inbox — switch back to a larger-window model to deliver it.";
        }
        if (restored.nextTurn > 0 && restored.nextStep > 0) {
            return "The previous request model is preserved; queued messages were returned to the pending queue (edit or remove them there) and pending next-step input was returned to the inbox, or switch back to a larger-window model.";
        }
        return "The previous request model is preserved; select a model with a larger context window.";
    }
    if (restored.nextTurn + restored.nextStep > 0) {
        return "The previous request model is preserved and the pending input was returned to the queue; retry or select a model with a larger context window.";
    }
    return "The previous request model is preserved; retry or select a model with a larger context window.";
}
//# sourceMappingURL=compact.js.map