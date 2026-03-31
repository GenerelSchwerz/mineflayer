/* eslint-env mocha */

const assert = require('assert')
const path = require('path')
const mc = require('minecraft-protocol')
const mineflayer = require('../')
const commonTest = require('./externalTests/plugins/testCommon')
const { loadExternalTests } = require('./externalTests/plugins/loadTests')
const { formatValue, logExternal } = require('./common/externalLog')
const { getPort } = require('./common/util')

const Wrap = require('minecraft-wrap').Wrap
const download = require('minecraft-wrap').download

const START_THE_SERVER = true
const TEST_TIMEOUT_MS = 90000
const WORKSPACE_TIMEOUT_MS = 10 * 60 * 1000
const DEFAULT_CONCURRENCY = parseInt(process.env.EXTERNAL_PARALLEL_CONCURRENCY ?? '4', 10)
const DEFAULT_WORKSPACE_SIZE = parseInt(process.env.EXTERNAL_WORKSPACE_SIZE ?? '256', 10)
const DEFAULT_SERVER_MIN_MEM_MB = parseInt(process.env.EXTERNAL_SERVER_MIN_MEM_MB ?? '2048', 10)
const DEFAULT_SERVER_MAX_MEM_MB = parseInt(process.env.EXTERNAL_SERVER_MAX_MEM_MB ?? '4096', 10)
const ENABLE_WORKSPACE_PREFLIGHT = process.env.EXTERNAL_WORKSPACE_PREFLIGHT !== '0'
const TEST_MODE = process.env.EXTERNAL_TEST_MODE ?? 'all'

const excludedTests = ['digEverything', 'book', 'anvil', 'placeEntity']
logExternal('runner', `Parallel external excluded tests: ${formatValue(excludedTests)}`)

const propOverrides = {
  'level-type': 'FLAT',
  'spawn-npcs': 'true',
  'spawn-animals': 'false',
  'online-mode': 'false',
  gamemode: '1',
  'spawn-monsters': 'false',
  'generate-structures': 'false',
  'enable-command-block': 'true',
  'use-native-transport': 'false'
}

const MC_SERVER_PATH = path.join(__dirname, 'server_parallel')

for (const supportedVersion of mineflayer.testedVersions) {
  const registry = require('prismarine-registry')(supportedVersion)
  const version = registry.version
  const MC_SERVER_JAR_DIR = process.env.MC_SERVER_JAR_DIR || `${process.cwd()}/server_jars`
  const MC_SERVER_JAR = `${MC_SERVER_JAR_DIR}/minecraft_server.${version.minecraftVersion}.jar`
  const wrap = new Wrap(MC_SERVER_JAR, `${MC_SERVER_PATH}_${supportedVersion}`, {
    minMem: DEFAULT_SERVER_MIN_MEM_MB,
    maxMem: DEFAULT_SERVER_MAX_MEM_MB
  })
  const externalTestsFolder = path.resolve(__dirname, './externalTests')
  const loadedTests = loadExternalTests({
    externalTestsFolder,
    supportedVersion,
    excludedTests
  })
  const workspaceTests = loadedTests.filter(test => test.isolation === 'workspace')
  const globalTests = loadedTests.filter(test => test.isolation !== 'workspace')
  const slotSize = Math.max(DEFAULT_WORKSPACE_SIZE, ...workspaceTests.map(test => test.workspaceSize ?? 0), 32)

  wrap.on('line', (line) => {
    logExternal('server', line)
  })

  describe(`mineflayer_external_parallel ${supportedVersion}v`, function () {
    let port = 25565
    let botCounter = 0
    let connectedBots = 0

    this.timeout(WORKSPACE_TIMEOUT_MS)

    before(async function () {
      port = await getPort()
      logExternal('runner', `Parallel port chosen (${supportedVersion}): ${port}`)
    })

    before(function (done) {
      this.timeout(1000 * 120)

      function begin () {
        done()
      }

      if (!START_THE_SERVER) {
        begin()
        return
      }

      download(version.minecraftVersion, MC_SERVER_JAR, (err) => {
        if (err) return done(err)

        propOverrides['server-port'] = port
        wrap.startServer(propOverrides, (err) => {
          if (err) return done(err)

          mc.ping({
            port,
            host: '127.0.0.1',
            version: supportedVersion
          }, (err, results) => {
            if (err) return done(err)
            assert.ok(results.latency >= 0)
            assert.ok(results.latency <= 1000)
            begin()
          })
        })
      })
    })

    after((done) => {
      wrap.stopServer((err) => {
        if (err) console.log(err)
        wrap.deleteServerData((deleteErr) => {
          if (deleteErr) console.log(deleteErr)
          done(err || deleteErr)
        })
      })
    })

    if ((TEST_MODE === 'all' || TEST_MODE === 'workspace') && workspaceTests.length > 0) {
      it('runs workspace-compatible tests in parallel on a shared same-version server', async function () {
        this.timeout(WORKSPACE_TIMEOUT_MS)
        if (ENABLE_WORKSPACE_PREFLIGHT) {
          logExternal('scheduler', '[scheduler] preflight: starting workspace isolation check')
          await verifyWorkspaceIsolation()
          logExternal('scheduler', '[scheduler] preflight: completed workspace isolation check')
        } else {
          logExternal('scheduler', '[scheduler] preflight: skipped workspace isolation check')
        }
        const failures = await runWorkspaceScheduler(workspaceTests)
        if (failures.length > 0) {
          const error = new Error(formatFailures(failures))
          error.failures = failures
          throw error
        }
      })
    }

    if (TEST_MODE === 'all' || TEST_MODE === 'global') {
      for (const test of globalTests) {
        it(test.name, async function () {
          this.timeout(TEST_TIMEOUT_MS)
          await runManagedTest(test, {
            slotIndex: 0,
            workspaceSize: slotSize,
            workspaceOrigin: getWorkspaceOrigin(0, slotSize, supportedVersion)
          })
        })
      }
    }

    async function verifyWorkspaceIsolation () {
      const originA = getWorkspaceOrigin(0, slotSize, supportedVersion)
      const originB = getWorkspaceOrigin(1, slotSize, supportedVersion)
      logExternal('scheduler', `[scheduler] preflight bot: isoa -> origin ${originA.x},${originA.y},${originA.z}`)
      const botA = await createManagedBot({
        username: nextBotUsername('isoa'),
        slotIndex: 0,
        workspaceOrigin: originA,
        workspaceRadius: 6,
        workspaceSize: slotSize
      })
      logExternal('scheduler', `[scheduler] preflight bot: isob -> origin ${originB.x},${originB.y},${originB.z}`)
      const botB = await createManagedBot({
        username: nextBotUsername('isob'),
        slotIndex: 1,
        workspaceOrigin: originB,
        workspaceRadius: 6,
        workspaceSize: slotSize
      })

      try {
        await botA.test.resetState()
        await botB.test.resetState()

        const worldPosA = botA.test.toWorld(0, 0, 0)
        const worldPosB = botB.test.toWorld(0, 0, 0)
        await botA.test.setBlock({ x: worldPosA.x, y: worldPosA.y, z: worldPosA.z, blockName: 'gold_block', relative: false })

        assert.strictEqual(botA.blockAt(worldPosA).name, 'gold_block')
        assert.notStrictEqual(botB.blockAt(worldPosB).name, 'gold_block')

        await botB.test.resetState()
        assert.strictEqual(botA.blockAt(worldPosA).name, 'gold_block')
      } finally {
        await closeBot(botA)
        await closeBot(botB)
      }
    }

    async function runWorkspaceScheduler (tests) {
      const queue = tests.map((test, index) => ({ ...test, queueIndex: index }))
      const active = new Map()
      const usedSlots = new Set()
      const activeResources = new Set()
      const failures = []
      const maxConcurrency = Math.max(1, Math.min(DEFAULT_CONCURRENCY, tests.length))

      while (queue.length > 0 || active.size > 0) {
        let launchedWork = false

        while (active.size < maxConcurrency) {
          const nextIndex = findRunnableTestIndex(queue, activeResources)
          if (nextIndex === -1) break

          const slotIndex = findAvailableSlot(maxConcurrency, usedSlots)
          if (slotIndex === -1) break

          const test = queue.splice(nextIndex, 1)[0]
          launchedWork = true
          usedSlots.add(slotIndex)
          for (const resource of test.compatibility ?? []) activeResources.add(resource)
          logSchedulerState({
            action: 'launching',
            currentTest: test.name,
            nextTests: queue.map(nextTest => nextTest.name),
            remainingTests: queue.length,
            activeTests: Array.from(active.values()).map(entry => entry.test.name),
            connectedBots
          })

          const promise = runManagedTest(test, {
            slotIndex,
            workspaceOrigin: getWorkspaceOrigin(slotIndex, slotSize, supportedVersion),
            workspaceRadius: test.workspaceRadius,
            workspaceSize: test.workspaceSize ?? slotSize
          }).then(() => {
            logSchedulerState({
              action: 'cleared',
              currentTest: test.name,
              nextTests: queue.map(nextTest => nextTest.name),
              remainingTests: queue.length,
              activeTests: Array.from(active.values())
                .map(entry => entry.test.name)
                .filter(name => name !== test.name),
              connectedBots
            })
          }).catch(error => {
            logSchedulerState({
              action: 'failed',
              currentTest: test.name,
              nextTests: queue.map(nextTest => nextTest.name),
              remainingTests: queue.length,
              activeTests: Array.from(active.values())
                .map(entry => entry.test.name)
                .filter(name => name !== test.name),
              connectedBots
            })
            failures.push({ name: test.name, error })
          }).finally(() => {
            active.delete(promise)
            usedSlots.delete(slotIndex)
            for (const resource of test.compatibility ?? []) activeResources.delete(resource)
          })

          active.set(promise, { test, slotIndex })
        }

        if (active.size === 0 && !launchedWork) {
          throw new Error(`Scheduler deadlock while waiting for compatible workspace tests: ${queue.map(test => test.name).join(', ')}`)
        }

        if (active.size > 0) {
          await Promise.race(active.keys())
        }
      }

      return failures
    }

    async function runManagedTest (test, { slotIndex, workspaceOrigin, workspaceRadius, workspaceSize }) {
      const username = nextBotUsername(test.name)
      const bot = await createManagedBot({
        username,
        slotIndex,
        workspaceOrigin,
        workspaceRadius: workspaceRadius ?? 8,
        workspaceSize
      })

      try {
        bot.test.sayEverywhere(`### Starting ${test.name}`)
        await bot.test.resetState()
        await test.run(bot)
      } finally {
        await closeBot(bot)
      }
    }

    async function createManagedBot ({ username, slotIndex, workspaceOrigin, workspaceRadius, workspaceSize }) {
      const bot = mineflayer.createBot({
        username,
        viewDistance: 'tiny',
        port,
        host: '127.0.0.1',
        version: supportedVersion
      })

      commonTest(bot, {
        id: `${supportedVersion}_${slotIndex}_${username}`,
        origin: workspaceOrigin,
        workspaceRadius,
        workspaceSize
      })
      bot.test.port = port

      await onceSpawn(bot)
      connectedBots++
      await opBot(bot)
      return bot
    }

    function nextBotUsername (seed) {
      const cleaned = seed.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'bot'
      const suffix = (botCounter++).toString(36)
      return `${cleaned}${suffix}`.slice(0, 16)
    }

    async function opBot (bot) {
      const opAck = onceMessage(bot, (msg) => msg.includes(`Made ${bot.username} a server operator`) || msg === `[Server: Opped ${bot.username}]`)
      wrap.writeServer(`op ${bot.username}\n`)
      await opAck
    }

    function onceSpawn (bot) {
      return new Promise((resolve, reject) => {
        const cleanup = () => {
          bot.removeListener('spawn', onSpawn)
          bot.removeListener('error', onError)
          bot.removeListener('kicked', onKicked)
        }

        const onSpawn = () => {
          cleanup()
          resolve()
        }
        const onError = (err) => {
          cleanup()
          reject(err)
        }
        const onKicked = (reason) => {
          cleanup()
          reject(new Error(`Bot kicked while connecting: ${reason}`))
        }

        bot.once('spawn', onSpawn)
        bot.once('error', onError)
        bot.once('kicked', onKicked)
      })
    }

    function onceMessage (bot, predicate) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          bot.removeListener('messagestr', onMessage)
          reject(new Error(`Timed out waiting for message for ${bot.username}`))
        }, timeoutForMessages())

        const onMessage = (message) => {
          if (!predicate(message)) return
          clearTimeout(timer)
          bot.removeListener('messagestr', onMessage)
          resolve(message)
        }
        bot.on('messagestr', onMessage)
      })
    }

    async function closeBot (bot) {
      if (!bot || bot._client.ended) return
      await new Promise((resolve) => {
        bot.once('end', resolve)
        bot.quit()
      })
      connectedBots = Math.max(0, connectedBots - 1)
    }
  })
}

function findRunnableTestIndex (queue, activeResources) {
  return queue.findIndex(test => (test.compatibility ?? []).every(resource => !activeResources.has(resource)))
}

function findAvailableSlot (maxConcurrency, usedSlots) {
  for (let slot = 0; slot < maxConcurrency; slot++) {
    if (!usedSlots.has(slot)) return slot
  }
  return -1
}

function getWorkspaceOrigin (slotIndex, slotSize, supportedVersion) {
  const groundY = isTallWorldVersion(supportedVersion) ? -60 : 4
  const columns = Math.ceil(Math.sqrt(Math.max(DEFAULT_CONCURRENCY, 1)))
  const x = slotIndex % columns
  const z = Math.floor(slotIndex / columns)
  return { x: x * slotSize, y: groundY, z: z * slotSize }
}

function isTallWorldVersion (supportedVersion) {
  const [major, minor] = supportedVersion.split('.').map(Number)
  return major > 1 || (major === 1 && minor >= 18)
}

function timeoutForMessages () {
  return 20000
}

function formatFailures (failures) {
  return failures.map(({ name, error }) => {
    const details = error?.stack ?? error?.message ?? String(error)
    return `- ${name}\n${details}`
  }).join('\n\n')
}

function logSchedulerState ({ action, currentTest, nextTests, remainingTests, activeTests, connectedBots }) {
  const nextPreview = nextTests.slice(0, 5).join(', ') || 'none'
  const activePreview = activeTests.join(', ') || 'none'
  logExternal('scheduler', `[scheduler] ${action}: ${currentTest}`)
  logExternal('scheduler', `[scheduler] active: ${activePreview}`)
  logExternal('scheduler', `[scheduler] next: ${nextPreview}`)
  logExternal('scheduler', `[scheduler] remaining: ${remainingTests}`)
  logExternal('scheduler', `[scheduler] connected bots: ${connectedBots}`)
}
