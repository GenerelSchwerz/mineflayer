function single (run, options = {}) {
  return {
    kind: 'single',
    isolation: options.isolation ?? 'global',
    run,
    compatibility: options.compatibility ?? defaultCompatibility(options.isolation ?? 'global'),
    workspaceRadius: options.workspaceRadius,
    workspaceSize: options.workspaceSize,
    extraBots: options.extraBots,
    exampleBot: options.exampleBot
  }
}

function suite (tests, options = {}) {
  return {
    kind: 'suite',
    isolation: options.isolation ?? 'global',
    tests,
    compatibility: options.compatibility ?? defaultCompatibility(options.isolation ?? 'global'),
    workspaceRadius: options.workspaceRadius,
    workspaceSize: options.workspaceSize,
    extraBots: options.extraBots,
    exampleBot: options.exampleBot
  }
}

function defaultCompatibility (isolation) {
  if (isolation === 'workspace') return []
  return ['global']
}

function workspaceTest (run, options = {}) {
  return single(run, { ...options, isolation: 'workspace' })
}

function globalTest (run, options = {}) {
  return single(run, { ...options, isolation: 'global' })
}

function workspaceSuite (tests, options = {}) {
  return suite(tests, { ...options, isolation: 'workspace' })
}

function globalSuite (tests, options = {}) {
  return suite(tests, { ...options, isolation: 'global' })
}

function normalizeDescriptor (name, exported) {
  if (exported?.kind === 'single') {
    return [{
      name,
      isolation: exported.isolation,
      run: exported.run,
      compatibility: exported.compatibility,
      workspaceRadius: exported.workspaceRadius,
      workspaceSize: exported.workspaceSize,
      extraBots: exported.extraBots,
      exampleBot: exported.exampleBot
    }]
  }

  if (exported?.kind === 'suite') {
    return Object.entries(exported.tests)
      .filter(([, run]) => run !== undefined)
      .map(([testName, run]) => ({
        name: `${name} ${testName}`,
        isolation: exported.isolation,
        run,
        compatibility: exported.compatibility,
        workspaceRadius: exported.workspaceRadius,
        workspaceSize: exported.workspaceSize,
        extraBots: exported.extraBots,
        exampleBot: exported.exampleBot
      }))
  }

  if (typeof exported === 'function') {
    return [{ name, isolation: 'global', run: exported, compatibility: ['global'] }]
  }

  if (exported && typeof exported === 'object') {
    return Object.entries(exported)
      .filter(([, run]) => run !== undefined)
      .map(([testName, run]) => ({
        name: `${name} ${testName}`,
        isolation: 'global',
        run,
        compatibility: ['global']
      }))
  }

  throw new TypeError(`Unsupported external test export for ${name}`)
}

module.exports = {
  globalSuite,
  globalTest,
  normalizeDescriptor,
  suite,
  single,
  workspaceSuite,
  workspaceTest
}
