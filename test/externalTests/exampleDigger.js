const assert = require('assert')
const { workspaceTest } = require('./plugins/descriptor')

module.exports = () => workspaceTest(async (bot) => {
  await bot.test.runExample('examples/digger.js', async (name) => {
    bot.chat(`/op ${name}`) // to counteract spawn protection
    bot.chat(`/give ${name} dirt 64`)
    await bot.test.wait(2000)
    await bot.test.tellAndListen(name, 'dig', (message) => {
      if (message.startsWith('starting')) {
        return false // continue to listen
      } else if (message.startsWith('finished')) {
        return true // stop listening
      }
      assert.fail(`Unexpected message: ${message}`) // error
    })
    await bot.test.tellAndListen(name, 'equip dirt', (message) => {
      if (!message.startsWith('equipped dirt')) {
        assert.fail(`Unexpected message: ${message}`) // error
      }
      return true // stop listening
    })
    await bot.test.tellAndListen(name, 'build', (message) => {
      if (message !== 'Placing a block was successful') {
        assert.fail(`Unexpected message: ${message}`) // error
      }
      return true // stop listening
    })
  }, { namePrefix: 'digger' })
}, { workspaceRadius: 12, exampleBot: true })
