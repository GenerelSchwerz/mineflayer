const { Vec3 } = require('vec3')

const { spawn } = require('child_process')
const { logExternal } = require('../../common/externalLog')
const { once } = require('../../../lib/promise_utils')
const process = require('process')
const assert = require('assert')
const { sleep, onceWithCleanup } = require('../../../lib/promise_utils')

const timeout = 20000
module.exports = inject

function inject (bot, wrapOrOptions = {}) {
  const options = normalizeOptions(wrapOrOptions)
  const wrap = options.wrap
  const botId = options.id ?? bot.username
  logExternal('bot', `[bot ${botId}] version ${bot.version}`)

  const defaultGroundY = bot.supportFeature('tallWorld') ? -60 : 4
  const defaultOrigin = options.origin
    ? new Vec3(options.origin.x, options.origin.y, options.origin.z)
    : new Vec3(0, defaultGroundY, 0)
  const defaultWorkspaceSize = options.workspaceSize ?? 48
  const defaultWorkspaceRadius = options.workspaceRadius ?? 8
  let workspaceIdCounter = 0

  bot.test = {}
  bot.test.id = options.id ?? bot.username
  bot.test.groundY = defaultGroundY
  bot.test.origin = defaultOrigin
  bot.test.workspaceSize = defaultWorkspaceSize
  bot.test.workspaceRadius = defaultWorkspaceRadius
  bot.test.defaultExampleOffset = options.defaultExampleOffset ?? new Vec3(10, 0, 0)
  bot.test.configureWorkspace = configureWorkspace
  bot.test.toWorld = toWorld
  bot.test.teleportHome = teleportHome
  bot.test.command = command
  bot.test.commandSelf = commandSelf
  bot.test.makeEntityName = makeEntityName
  bot.test.makeChildUsername = makeChildUsername
  bot.test.sayEverywhere = sayEverywhere
  bot.test.clearInventory = clearInventory
  bot.test.becomeSurvival = becomeSurvival
  bot.test.becomeCreative = becomeCreative
  bot.test.fly = fly
  bot.test.teleport = teleport
  bot.test.resetState = resetState
  bot.test.setInventorySlot = setInventorySlot
  bot.test.placeBlock = placeBlock
  bot.test.runExample = runExample
  bot.test.tellAndListen = tellAndListen
  bot.test.selfKill = selfKill
  bot.test.wait = function (ms) {
    return new Promise((resolve) => { setTimeout(resolve, ms) })
  }

  configureWorkspace({
    origin: defaultOrigin,
    workspaceSize: defaultWorkspaceSize,
    workspaceRadius: defaultWorkspaceRadius
  })

  bot.test.awaitItemReceived = async (command) => {
    const p = once(bot.inventory, 'updateSlot')
    bot.chat(command)
    await p
  }

  bot.test.setBlock = async ({ x = 0, y = 0, z = 0, relative, blockName }) => {
    const position = relative ? bot.entity.position.floored().offset(x, y, z) : new Vec3(x, y, z)
    const block = bot.blockAt(position)
    if (block.name === blockName) return

    const p = once(bot.world, `blockUpdate:(${position.x}, ${position.y}, ${position.z})`)
    const prefix = relative ? '~' : ''
    bot.chat(`/setblock ${prefix}${x} ${prefix}${y} ${prefix}${z} ${blockName}`)
    await p
  }

  let grassName
  if (bot.supportFeature('itemsAreNotBlocks')) {
    grassName = 'grass_block'
  } else if (bot.supportFeature('itemsAreAlsoBlocks')) {
    grassName = 'grass'
  }

  const layerNames = [
    'bedrock',
    'dirt',
    'dirt',
    grassName,
    'air',
    'air',
    'air',
    'air',
    'air'
  ]

  async function resetBlocksToSuperflat () {
    const groundY = 4
    const minX = Math.floor(bot.test.origin.x - bot.test.workspaceRadius)
    const maxX = Math.floor(bot.test.origin.x + bot.test.workspaceRadius)
    const minZ = Math.floor(bot.test.origin.z - bot.test.workspaceRadius)
    const maxZ = Math.floor(bot.test.origin.z + bot.test.workspaceRadius)
    for (let y = groundY + 4; y >= groundY - 1; y--) {
      const realY = y + bot.test.groundY - 4
      bot.chat(`/fill ${minX} ${realY} ${minZ} ${maxX} ${realY} ${maxZ} ${layerNames[y]}`)
    }
    await bot.test.wait(100)
  }

  async function placeBlock (slot, position) {
    bot.setQuickBarSlot(slot - 36)
    const referenceBlock = bot.blockAt(position.plus(new Vec3(0, -1, 0)))
    return bot.placeBlock(referenceBlock, new Vec3(0, 1, 0))
  }

  async function resetState () {
    logExternal('trace', `[trace ${bot.username}] resetState: start`)
    await becomeCreative()
    logExternal('trace', `[trace ${bot.username}] resetState: creative enabled`)
    await clearInventory()
    logExternal('trace', `[trace ${bot.username}] resetState: inventory cleared (pass 1)`)
    bot.creative.startFlying()
    await teleportHome()
    logExternal('trace', `[trace ${bot.username}] resetState: teleport complete ${bot.entity.position.floored().x},${bot.entity.position.floored().y},${bot.entity.position.floored().z}`)
    await bot.waitForChunksToLoad()
    logExternal('trace', `[trace ${bot.username}] resetState: chunks loaded`)
    await resetBlocksToSuperflat()
    logExternal('trace', `[trace ${bot.username}] resetState: workspace reset`)
    await clearInventory()
    logExternal('trace', `[trace ${bot.username}] resetState: inventory cleared (pass 2)`)
    logExternal('trace', `[trace ${bot.username}] resetState: complete`)
  }

  async function becomeCreative () {
    return setCreativeMode(true)
  }

  async function becomeSurvival () {
    return setCreativeMode(false)
  }

  async function setCreativeMode (value) {
    const mode = value ? 'creative' : 'survival'
    const modeId = value ? 1 : 0
    if (bot.game.gameMode === mode) return

    const gameModePromise = onceWithCleanup(bot._client, 'game_state_change', {
      timeout,
      checkCondition: (packet) => {
        const isGameModeChange = packet.reason === 3 || packet.reason === 'change_game_mode'
        return isGameModeChange && Math.floor(packet.gameMode) === modeId
      }
    })

    if (wrap) {
      wrap.writeServer(`gamemode ${mode} ${bot.username}\n`)
    } else {
      bot.chat(`/gamemode ${mode} ${bot.username}`)
    }

    await gameModePromise
  }

  async function clearInventory () {
    const giveStone = onceWithCleanup(bot.inventory, 'updateSlot', {
      timeout,
      checkCondition: (slot, oldItem, newItem) => newItem?.name === 'stone'
    })
    bot.chat(`/give ${bot.username} stone 1`)
    await giveStone

    const clearMsg = onceWithCleanup(bot, 'message', {
      timeout,
      checkCondition: msg => msg.translate === 'commands.clear.success.single' || msg.translate === 'commands.clear.success'
    })
    bot.chat(`/clear ${bot.username}`)
    await clearMsg

    for (const slot of bot.inventory.slots) {
      if (slot && slot.itemCount <= 0) {
        throw new Error('Inventory was not cleared: ' + JSON.stringify(bot.inventory.slots))
      }
    }
  }

  async function setInventorySlot (targetSlot, item) {
    assert(item === null || item.name !== 'unknown', `item should not be unknown ${JSON.stringify(item)}`)
    return bot.creative.setInventorySlot(targetSlot, item)
  }

  async function teleport (position) {
    if (bot.supportFeature('hasExecuteCommand')) {
      bot.test.sayEverywhere(`/execute in overworld run teleport ${bot.username} ${position.x} ${position.y} ${position.z}`)
    } else {
      bot.test.sayEverywhere(`/tp ${bot.username} ${position.x} ${position.y} ${position.z}`)
    }
    return onceWithCleanup(bot, 'move', {
      timeout,
      checkCondition: () => bot.entity.position.distanceTo(position) < 0.9
    })
  }

  function sayEverywhere (message) {
    logExternal('bot', `[bot ${bot.username}] ${message}`)
    bot.chat(message)
  }

  function configureWorkspace ({ origin, workspaceSize, workspaceRadius } = {}) {
    if (origin) {
      bot.test.origin = new Vec3(origin.x, origin.y, origin.z)
    }
    if (workspaceSize !== undefined) {
      bot.test.workspaceSize = workspaceSize
    }
    if (workspaceRadius !== undefined) {
      bot.test.workspaceRadius = workspaceRadius
    }
    bot.test.groundY = bot.test.origin.y
  }

  function toWorld (x = 0, y = 0, z = 0) {
    return bot.test.origin.offset(x, y, z)
  }

  function teleportHome () {
    return teleport(bot.test.origin.clone())
  }

  function command (rawCommand) {
    bot.chat(rawCommand)
  }

  function commandSelf (commandPrefix, args = '') {
    const suffix = args ? ` ${args}` : ''
    bot.chat(`/${commandPrefix} ${bot.username}${suffix}`)
  }

  function makeEntityName (prefix = 'test') {
    const suffix = `${workspaceIdCounter++}`.padStart(2, '0')
    return `${prefix}_${bot.test.id}_${suffix}`.slice(0, 64)
  }

  function makeChildUsername (prefix = 'child') {
    const cleanPrefix = prefix.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 8) || 'child'
    const cleanId = `${bot.test.id}`.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 4) || 'bot'
    const suffix = `${workspaceIdCounter++}`.toString(36).slice(-2)
    return `${cleanPrefix}${cleanId}${suffix}`.slice(0, 16)
  }

  async function fly (delta) {
    return bot.creative.flyTo(bot.entity.position.plus(delta))
  }

  async function tellAndListen (to, what, listen) {
    const chatMessagePromise = onceWithCleanup(bot, 'chat', {
      timeout,
      checkCondition: (username, message) => username === to && listen(message)
    })

    bot.chat(what)

    return chatMessagePromise
  }

  async function runExample (file, run, options = {}) {
    let childBotName
    const childTarget = options.targetPosition
      ? options.targetPosition.clone()
      : bot.test.toWorld(
        bot.test.defaultExampleOffset.x,
        bot.test.defaultExampleOffset.y,
        bot.test.defaultExampleOffset.z
      )
    const requestedName = options.username ?? bot.test.makeChildUsername(options.namePrefix ?? file.split('/').pop().replace(/\.js$/, ''))

    const detectChildJoin = async () => {
      const [message] = await onceWithCleanup(bot, 'message', {
        checkCondition: message => message.json.translate === 'multiplayer.player.joined' && message.json.with[0].insertion === requestedName
      })
      childBotName = message.json.with[0].insertion
      bot.chat(`/tp ${childBotName} ${childTarget.x} ${childTarget.y} ${childTarget.z}`)
      while (!bot.players[childBotName]?.entity ||
             bot.players[childBotName].entity.position.distanceTo(childTarget) > 5) {
        await sleep(100)
      }
      await bot.waitForTicks(60)
      bot.chat('loaded')
    }

    const runExampleOnReady = async () => {
      await onceWithCleanup(bot, 'chat', {
        checkCondition: (username, message) => username === requestedName && message === 'Ready!'
      })
      return run(childBotName)
    }

    const child = spawn('node', [file, '127.0.0.1', `${bot.test.port}`, requestedName])

    child.stdout.on('data', (data) => { console.log(`${data}`) })
    child.stderr.on('data', (data) => { console.error(`${data}`) })

    const closeExample = async (err) => {
      console.log('kill process ' + child.pid)

      try {
        process.kill(child.pid, 'SIGTERM')
        const [code] = await onceWithCleanup(child, 'close', { timeout: 5000 })
        console.log('close requested', code)
      } catch (e) {
        console.log(e)
        console.log('process termination failed, process may already be closed')
      }

      if (err) throw err
    }

    try {
      await Promise.all([detectChildJoin(), runExampleOnReady()])
    } catch (err) {
      console.log(err)
      return closeExample(err)
    }
    return closeExample()
  }

  function selfKill () {
    bot.chat(`/kill ${bot.username}`)
  }

  if (process.env.RUNNER_DEBUG) {
    bot._client.on('packet', function (data, meta) {
      if (['chunk', 'time', 'light', 'alive'].some(e => meta.name.includes(e))) return
      console.log('->', meta.name, JSON.stringify(data)?.slice(0, 250))
    })
    const oldWrite = bot._client.write
    bot._client.write = function (name, data) {
      if (['alive', 'pong', 'ping'].some(e => name.includes(e))) return
      console.log('<-', name, JSON.stringify(data)?.slice(0, 250))
      oldWrite.apply(bot._client, arguments)
    }
    BigInt.prototype.toJSON ??= function () { // eslint-disable-line
      return this.toString()
    }
  }
}

function normalizeOptions (wrapOrOptions) {
  if (
    wrapOrOptions &&
    typeof wrapOrOptions.writeServer === 'function' &&
    !('origin' in wrapOrOptions) &&
    !('workspaceSize' in wrapOrOptions) &&
    !('id' in wrapOrOptions)
  ) {
    return { wrap: wrapOrOptions }
  }
  return wrapOrOptions ?? {}
}
