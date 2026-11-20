import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [manifestPath, outputPath, spinePackage = '@spinejit/dsh-spinejit'] = process.argv.slice(2);
if (!manifestPath || !outputPath) {
  throw new Error('Usage: node generate.mjs DSH_PACKAGE_JSON OUTPUT_PATCH [SPINE_PACKAGE]');
}

const manifest = resolve(manifestPath);
const requireFromDsh = createRequire(manifest);
const { version } = requireFromDsh(manifest);
assert.equal(version, '0.2.2-rc.5', 'Verify the shipped Web presets before regenerating for another DSH version');

const { loadOverlayPatches, composeEntries } = await import(pathToFileURL(requireFromDsh.resolve('@deepseek-ai/dsh-app-boot')));
const { entryListSchema } = await import(pathToFileURL(requireFromDsh.resolve('@deepseek-ai/cordis-plugin-include')));
const yaml = requireFromDsh('js-yaml');
const webApp = dirname(requireFromDsh.resolve('@deepseek-ai/dsh-web-app/package.json'));
const overrides = ['standard', 'ptc', 'minimal', 'cordis'].map(id => {
  const patch = loadOverlayPatches('spinejit', join(webApp, `presets/${id}.patch.yml`));
  const preset = composeEntries([patch]).find(row => row.id === `preset-${id}`);
  assert(preset, `The installed Web runtime must contain preset-${id}`);
  const { config } = preset;
  const compaction = config.plugins.find(row => row.id === 'compaction');
  assert(Array.isArray(compaction?.config), `preset-${id} must contain the compaction group`);
  for (const row of compaction.config) {
    if (['@deepseek-ai/dsh-compaction-basic', '@deepseek-ai/dsh-command-compact', '@deepseek-ai/dsh-compaction-tool-result-pruner'].includes(row.name)) {
      row.disabled = true;
    }
  }
  for (const name of ['@deepseek-ai/dsh-compaction-basic', '@deepseek-ai/dsh-command-compact']) {
    assert(compaction.config.some(row => row.name === name && row.disabled), `preset-${id} must disable ${name}`);
  }
  compaction.config.push({ id: 'spine-compact', name: `${spinePackage}/compact` });
  return { id: preset.id, name: preset.name, config };
});

const generated = yaml.dump(overrides, { schema: entryListSchema, noRefs: true, lineWidth: -1 });
writeFileSync(resolve(outputPath), `# Generated from the DSH ${version} Web presets by presets/standard-spinejit/generate.mjs.\n${generated}`);
