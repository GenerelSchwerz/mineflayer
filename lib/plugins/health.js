module.exports = inject

function inject (bot, options) {
  bot.isAlive = true

  function spawn () {
    if (bot.registry.version['>=']('1.21.4')) bot._client.write('player_loaded', {})
    bot.emit('spawn')
  }

  bot._client.on('respawn', (packet) => {
    bot.isAlive = false
    bot.emit('respawn')
  })

  bot._client.once('update_health', (packet) => {
    if (packet.health > 0) {
      spawn()
    }
  })

  bot._client.on('update_health', (packet) => {
    bot.health = packet.health
    bot.food = packet.food
    bot.foodSaturation = packet.foodSaturation
    bot.emit('health')
    if (bot.health <= 0) {
      if (bot.isAlive) {
        bot.isAlive = false
        bot.emit('death')
      }
      if (!options.respawn) return
      bot.respawn()
    } else if (bot.health > 0 && !bot.isAlive) {
      bot.isAlive = true
      spawn()
    }
  })

  const respawn = () => {
    if (bot.isAlive) return
    bot._client.write('client_command', bot.supportFeature('respawnIsPayload') ? { payload: 0 } : { actionId: 0 })
  }

  bot.respawn = respawn
}
