// The gate list formerly encoded in .github/workflows/pe3.yml, kept as the
// single local source of truth so `npm run verify:pe3` and its test agree.
export function requiresOpenCodeSource(step) {
  return step.arguments.some((argument) => argument.startsWith('--source='))
}

export function pe3VerificationSteps(source, patchedSource) {
  const substitute = (value) => value.replace('${PATCHED_SOURCE}', patchedSource)
  const nodeTest = (path) => ({ command: 'node', arguments: ['--import', 'tsx', '--test', path] })
  const workspaceScript = (script) => ({
    command: 'npm',
    arguments: ['run', script, '--workspace=cuppet', '--workspace=@cuppet-code/opencode-plugin'],
  })
  return [
    {
      name: 'verify-opencode-patch-stack',
      command: 'node',
      arguments: ['scripts/check-opencode-patches.mjs', `--source=${source}`, '--output=${PATCHED_SOURCE}'].map(substitute),
    },
    { name: 'build-workspaces', ...workspaceScript('build') },
    { name: 'typecheck-pe3', ...workspaceScript('typecheck') },
    { name: 'pe3-regression-suite', command: 'npm', arguments: ['run', 'test:pe3'] },
    { name: 'task-affinity-router', ...nodeTest('packages/cli/test/task-agents.test.ts') },
    { name: 'control-routing-boundary', ...nodeTest('packages/cli/test/control.test.ts') },
    { name: 'native-tui-handoff', ...nodeTest('packages/opencode-plugin/test/pe3-tui.test.ts') },
    { name: 'routing-benchmark', command: 'npm', arguments: ['run', 'eval:pe3:routing'] },
    {
      name: 'build-opencode-derivative',
      command: 'node',
      arguments: ['scripts/build-opencode.mjs', `--source=${source}`, '--output=.opencode/opencode'],
    },
  ].map((step) => ({ ...step, arguments: step.arguments.map(substitute) }))
}
