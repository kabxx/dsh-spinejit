import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { encodeInit, SPINE_SDK_SCHEMA, SpineProtocolError, SpineRuntimeClient } from "@spinejit/spine-sdk";
const require = createRequire(import.meta.url);
const bindingUrl = new URL("../vendor/spine-checkpoint/spine_wasm.cjs", import.meta.url);
const wasmUrl = new URL("spine_wasm_bg.wasm", bindingUrl);
const binding = require("../vendor/spine-checkpoint/spine_wasm.cjs");
const build = createHash("sha256")
    .update(readFileSync(new URL(import.meta.url)))
    .update(readFileSync(bindingUrl))
    .update(readFileSync(wasmUrl))
    .digest("hex");
export function checkpointBuild() {
    return build;
}
export function validateSpineToolInput(tool, input) {
    return JSON.parse(binding.validate_tool_input(tool, JSON.stringify(input)));
}
/** Use the stock JS SDK protocol client with the checkpoint-capable native binding. */
export function createCheckpointNodeRuntime(options) {
    const { thread, epoch, configToml, features } = options;
    const native = new binding.SpineRuntime(encodeInit({
        thread,
        ...(epoch === undefined ? {} : { epoch }),
        ...(configToml === undefined ? {} : { config_toml: configToml }),
        ...(features === undefined ? {} : { features }),
    }));
    let disposed = false;
    function current() {
        if (disposed)
            throw new Error("Spine Node runtime is disposed");
        return native;
    }
    function checkpointCommand(request) {
        const response = JSON.parse(current().dispatch(JSON.stringify({ schema: SPINE_SDK_SCHEMA, request })));
        if (!record(response) || response.schema !== SPINE_SDK_SCHEMA) {
            throw new SpineProtocolError("invalid_envelope", "invalid Spine SDK response envelope");
        }
        if (response.ok === false && record(response.error) &&
            typeof response.error.code === "string" && typeof response.error.message === "string") {
            throw new SpineProtocolError(response.error.code, response.error.message);
        }
        if (response.ok !== true || !record(response.result)) {
            throw new SpineProtocolError("invalid_result", "invalid Spine SDK checkpoint result");
        }
        return response.result;
    }
    function exportState(type) {
        const result = checkpointCommand({ type });
        if (result.type !== "checkpoint_exported" || typeof result.state !== "string") {
            throw new SpineProtocolError("invalid_result", "invalid Spine SDK checkpoint export");
        }
        return result.state;
    }
    return {
        client: new SpineRuntimeClient({ dispatch: (json) => current().dispatch(json) }),
        extendSystemPrompt: (base) => current().extend_system_prompt(base),
        nodePrompt: () => current().node_prompt(),
        toolCatalog: () => JSON.parse(current().tool_catalog_json()),
        async exportCheckpoint() { return exportState("export_checkpoint"); },
        async exportPreSamplingCheckpoint() { return exportState("export_pre_sampling_checkpoint"); },
        async importCheckpoint(state) {
            if (checkpointCommand({ type: "import_checkpoint", state }).type !== "checkpoint_imported") {
                throw new SpineProtocolError("invalid_result", "invalid Spine SDK checkpoint import");
            }
        },
        dispose() {
            if (disposed)
                return;
            disposed = true;
            native.free();
        },
    };
}
function record(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=checkpoint-runtime.js.map