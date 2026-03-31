const assert = require('assert')
const { workspaceTest } = require('./plugins/descriptor')

const tests = [
  {
    command: 'list',
    wantedMessage: 'dirt x 64, stick x 7, iron_ore x 64, diamond_boots x 1'
  },
  {
    command: 'equip off-hand dirt',
    wantedMessage: 'equipped dirt'
  },
  {
    command: 'list',
    wantedMessage: 'stick x 7, iron_ore x 64, diamond_boots x 1, dirt x 64'
  },
  {
    command: 'equip hand dirt',
    wantedMessage: 'equipped dirt'
  },
  {
    command: 'toss 64 dirt',
    wantedMessage: 'tossed 64 x dirt'
  },
  {
    command: 'craft 1 ladder',
    wantedMessage: 'I can make ladder'
  },
  {
    command: '',
    wantedMessage: 'did the recipe for ladder 1 times'
  },
  {
    command: 'equip feet diamond_boots',
    wantedMessage: 'equipped diamond_boots'
  },
  {
    command: 'toss iron_ore',
    wantedMessage: 'tossed iron_ore'
  },
  {
    command: 'unequip feet',
    wantedMessage: 'unequipped'
  },
  { // after tests layout
    command: 'list',
    wantedMessage: 'ladder x 3, diamond_boots x 1'
  }
]
module.exports = () => workspaceTest(async (bot) => {
  const exampleHome = bot.test.toWorld(0, 0, 0)
  await bot.test.runExample('examples/inventory.js', async (name) => {
    const plannedTests = tests.slice()
    bot.chat(`/op ${name}`) // to counteract spawn protection
    bot.chat(`/clear ${name}`)
    const craftingTablePos = bot.test.toWorld(1, 0, 0)
    bot.chat(`/setblock ${craftingTablePos.x} ${craftingTablePos.y} ${craftingTablePos.z} crafting_table`)
    bot.chat(`/give ${name} dirt 64`)
    bot.chat(`/give ${name} stick 7`)
    bot.chat(`/give ${name} iron_ore 64`)
    bot.chat(`/give ${name} diamond_boots 1`)
    await bot.test.wait(2000)
    if (bot.registry.isOlderThan('1.9')) {
      plannedTests.splice(plannedTests.indexOf(plannedTests.find(t => t.command.includes('off-hand'))), 2) // Delete off-hand command and the command after it as they don't work in 1.9
    }
    const testFuncs = plannedTests.map(test => makeTest(test.command, test.wantedMessage))
    for (const test of testFuncs) {
      await test()
      await bot.test.wait(100)
    }
    // cleanup
    bot.chat(`/setblock ${craftingTablePos.x} ${craftingTablePos.y} ${craftingTablePos.z} air`)

    function makeTest (inStr, outStr) {
      return () => bot.test.tellAndListen(name, inStr, makeListener(outStr))
    }
  }, { namePrefix: 'inventory', targetPosition: exampleHome })
}, { workspaceRadius: 12, exampleBot: true })

function makeListener (wantedMessage) {
  return (message) => {
    if (!message.startsWith(wantedMessage)) {
      assert.fail(`Unexpected message: ${message}, wanted ${wantedMessage}`) // error
    }
    return true // stop listening
  }
}
