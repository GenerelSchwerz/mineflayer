const assert = require('assert')
const { workspaceTest } = require('./plugins/descriptor')

module.exports = () => workspaceTest(async (bot) => {
  await bot.test.runExample('examples/bee.js', async (name) => {
    bot.chat(`/op ${name}`) // to counteract spawn protection
    await bot.test.wait(2000)
    await bot.test.tellAndListen(name, 'fly', (message) => {
      if (message !== 'My flight was amazing !') {
        assert.fail(`Unexpected message: ${message}`) // error
      }
      return true // stop listening
    })
  }, { namePrefix: 'bee' })
}, { workspaceRadius: 12, exampleBot: true })
