import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [manifestPath, pluginDirPath] = process.argv.slice(2);
if (!manifestPath || !pluginDirPath) throw Error('Usage: node --expose-internals smoke.mjs DSH_PACKAGE_JSON SPINEJIT_DIRECTORY');
const manifest = resolve(manifestPath);
const pluginDir = resolve(pluginDirPath);
const req = createRequire(manifest);
const load = spec => import(pathToFileURL(req.resolve(spec)));
const { Context } = await load('@deepseek-ai/cordis');
const { createScope, scopeTarget } = await load('@deepseek-ai/dsh-scope');
const { default: Loader } = await load('@deepseek-ai/cordis-plugin-loader');
const { default: Group } = await load('@deepseek-ai/cordis-plugin-group');
const { default: CommandRuntime } = await load('@deepseek-ai/dsh-commands');
const { resolveCommand } = await load('@deepseek-ai/dsh-commands/builtin');
const registryDir = dirname(req.resolve('@deepseek-ai/dsh-agent-preset-registry/package.json'));
const { mountPreset, serviceForMount, auditRows } = await import(pathToFileURL(join(registryDir, 'lib/types/mount.js')));
const { bundlePatchPaths, loadOverlayPatches, composeEntries } = await load('@deepseek-ai/dsh-app-boot');
const web = dirname(req.resolve('@deepseek-ai/dsh-web-app/package.json'));
const base = dirname(req.resolve('@deepseek-ai/dsh-base/package.json'));
const presets = ['standard', 'ptc', 'minimal', 'cordis'];
const read = path => loadOverlayPatches('spinejit-compaction-smoke', path);
const stockFiles = [join(base, 'cordis.patch.yml'), ...presets.map(id => join(web, `presets/${id}.patch.yml`))];
const bundle = req(join(pluginDir, 'package.json')).dsh.bundle;
const stock = composeEntries(stockFiles.map(read));
const effective = composeEntries([...stockFiles, ...bundlePatchPaths(pluginDir, bundle)].map(read));
const modulePath = pathToFileURL(join(pluginDir, 'dist/compact.js')).href;
const group = row => row.config.plugins.find(child => child.id === 'compaction');
const byId = (entries, id) => entries.find(row => row.id === id);
assert(effective.some(row => row.id === 'spinejit'));
for (const id of ['compaction-basic', 'command-compact', 'tool-result-pruner']) {
  assert.equal(byId(effective, id).disabled, true);
}
assert.deepEqual(byId(effective, 'image-offload'), byId(stock, 'image-offload'));
assert.equal(byId(effective, 'image-offload').disabled, undefined);
for (const id of presets) {
  const before = byId(stock, `preset-${id}`);
  const after = byId(effective, `preset-${id}`);
  const unrelated = row => ({ ...row, config: { ...row.config, plugins: row.config.plugins.filter(child => child.id !== 'compaction') } });
  assert.deepEqual(unrelated(after), unrelated(before), `${id} preserves all entries outside its compaction group`);
  for (const child of group(before).config) {
    assert.deepEqual(byId(group(after).config, child.id), { ...child, disabled: true });
  }
  const spine = byId(group(after).config, 'spine-compact');
  assert.equal(spine.name, `${req(join(pluginDir, 'package.json')).name}/compact`);
  spine.name = modulePath;
}

const ctx = new Context();
ctx.baseUrl = pathToFileURL(manifest).href;
const logger = { info() {}, warn() {}, error(error) { throw error; }, debug() {} };
ctx.logger = Object.assign(() => logger, logger);
for (const service of ['llm', 'tokenMeter', 'sessions']) ctx.reflect.provide(service, {});
const loader = ctx.plugin(Loader);
const commands = ctx.plugin(CommandRuntime);
await Promise.all([loader.await(), commands.await()]);
const { promise, resolve: done, reject } = Promise.withResolvers();
const owner = ctx.inject(['loader', 'commands', 'llm', 'tokenMeter', 'sessions'], ownerCtx => {
  ownerCtx.loader.builtins.group = Group;
  void (async () => {
    for (const id of presets) {
      const ordinaryScope = createScope(ownerCtx, {});
      const spineScope = createScope(ownerCtx, {});
      try {
        const ordinary = await mountPreset(ordinaryScope.ctx, id, [group(byId(stock, `preset-${id}`))]);
        const spine = await mountPreset(spineScope.ctx, id, [group(byId(effective, `preset-${id}`))]);
        assert.deepEqual(await auditRows(ordinary.tree), { failed: [], pending: [] });
        assert.deepEqual(await auditRows(spine.tree), { failed: [], pending: [] });
        const ordinaryCompact = ownerCtx.commands.find(ordinary.key, 'compact');
        const spineCompact = ownerCtx.commands.find(spine.key, 'compact');
        assert.equal(ordinaryCompact?.definitionId, '@deepseek-ai/dsh-command-compact');
        assert.equal(spineCompact?.definitionId, '@deepseek-ai/dsh-command-compact');
        assert.match(spineCompact.description, /new SpineJIT task tree/);
        assert.equal(resolveCommand('compact', [spineCompact]), spineCompact);
        assert.equal(resolveCommand('压缩', [spineCompact]), spineCompact);
        const baseline = serviceForMount(ownerCtx, ordinary, 'compaction');
        assert.equal(typeof baseline?.compactIfNeeded, 'function');
        assert.equal(serviceForMount(ownerCtx, spine, 'compaction'), undefined);
        assert.equal(serviceForMount(ownerCtx, spine, 'toolResultPruner'), undefined);
        const calls = [];
        baseline.compactIfNeeded = async (agent, trigger) => { calls.push([agent, trigger]); return null; };
        const dispatch = async (mount, agent) => ownerCtx.waterfall(scopeTarget(agent, mount.key), 'agent/pre-step',
          { agent, signal: new AbortController().signal }, () => 42);
        const ordinaryAgent = {};
        assert.equal(await dispatch(spine, {}), 42);
        assert.equal(await dispatch(ordinary, ordinaryAgent), 42);
        assert.deepEqual(calls, [[ordinaryAgent, 'pressure']]);
        console.log(`${id}: native /compact and automatic compaction in stock DSH; SpineJIT /compact and no native compaction or pruning with the bundle enabled.`);
      } finally {
        await Promise.all([ordinaryScope.dispose(), spineScope.dispose()]);
      }
    }
  })().then(done, reject);
});
try {
  await promise;
} finally {
  await owner.dispose();
  await Promise.all([commands.dispose(), loader.dispose()]);
}
