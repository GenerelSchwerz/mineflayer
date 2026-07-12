const assert = require('assert')
const mineflayer = require('mineflayer')
const { Vec3 } = require('vec3')

const { once, onceWithCleanup } = require('../../lib/promise_utils')

const timeout = 10000

module.exports = () => async (bot) => {
  let target

  try {
    // Spawn the second bot inside the first bot's tracking range. Some older
    // servers do not begin tracking a player teleported in from far away.
    bot.chat('/gamerule spawnRadius 0')
    bot.chat(`/setworldspawn 0 ${bot.test.groundY} 2`)
    await bot.waitForTicks(10)

    target = mineflayer.createBot({
      username: 'knockbackbot',
      viewDistance: 'tiny',
      port: bot.test.port,
      host: '127.0.0.1',
      version: bot.version
    })
    await once(target, 'spawn')

    const attackerPosition = new Vec3(0, bot.test.groundY, 0)
    const targetPosition = attackerPosition.offset(0, 0, 2)

    await bot.test.becomeSurvival()

    const targetSurvival = onceWithCleanup(target._client, 'game_state_change', {
      timeout,
      checkCondition: packet => {
        const isGameModeChange = packet.reason === 3 || packet.reason === 'change_game_mode'
        return isGameModeChange && Math.floor(packet.gameMode) === 0
      }
    })
    bot.chat(`/gamemode survival ${target.username}`)
    await targetSurvival

    await bot.test.teleport(attackerPosition)
    const targetTeleported = onceWithCleanup(target, 'move', {
      timeout,
      checkCondition: () => target.entity.position.distanceTo(targetPosition) < 0.9
    })
    bot.chat(`/tp ${target.username} ${targetPosition.x} ${targetPosition.y} ${targetPosition.z}`)
    await targetTeleported

    // Newly joined players are temporarily invulnerable on vanilla servers.
    await bot.waitForTicks(80)

    const primaryEntity = target.players[bot.username]?.entity
    assert.ok(primaryEntity, 'second bot must track the primary bot before attacking')

    const start = bot.entity.position.clone()
    const away = attackerPosition.minus(targetPosition).normalize()

    const velocityPacketReceived = onceWithCleanup(bot._client, 'entity_velocity', {
      timeout,
      checkCondition: packet => packet.entityId === bot.entity.id
    }).then(([packet]) => new Vec3(packet.velocity.x, packet.velocity.y, packet.velocity.z))
    const velocityReceived = onceWithCleanup(bot, 'entityVelocity', {
      timeout,
      checkCondition: entity => entity === bot.entity
    }).then(([entity]) => entity.velocity.clone())
    const movedAway = onceWithCleanup(bot, 'move', {
      timeout,
      checkCondition: () => {
        const displacement = bot.entity.position.minus(start)
        return displacement.x * away.x + displacement.z * away.z > 0.1
      }
    })

    target.attack(primaryEntity)

    const [packetVelocity, velocity] = await Promise.all([velocityPacketReceived, velocityReceived])
    assert.ok([packetVelocity.x, packetVelocity.y, packetVelocity.z].every(Number.isFinite),
      `expected finite entity_velocity packet values, got ${packetVelocity}`)
    assert.ok([velocity.x, velocity.y, velocity.z].every(Number.isFinite),
      `expected finite entity velocity, got ${velocity}`)

    const packetHorizontalSpeed = Math.hypot(packetVelocity.x, packetVelocity.z)
    const horizontalSpeed = Math.hypot(velocity.x, velocity.z)

    assert.ok(packetHorizontalSpeed > 0.05,
      `expected nontrivial entity_velocity packet, got ${packetHorizontalSpeed} (${packetVelocity})`)
    assert.ok(horizontalSpeed > 0.05,
      `expected knockback velocity above 0.05 blocks/tick, got ${horizontalSpeed} (${velocity}); packet was ${packetHorizontalSpeed} (${packetVelocity})`)
    await movedAway
  } finally {
    target?.end()
  }
}
