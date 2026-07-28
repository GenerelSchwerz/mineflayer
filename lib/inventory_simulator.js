const assert = require('assert')

module.exports = Item => {
  const quickCrafts = new WeakMap()

  function cloneItem (item, count = item?.count) {
    if (!item || count <= 0) return null
    return Object.assign(Object.create(Object.getPrototypeOf(item)), item, { count })
  }

  function sameItem (a, b) {
    return Item.equal(a, b, false)
  }

  function changedSlots (before, window) {
    const changed = []
    for (let slot = 0; slot < window.slots.length; slot++) {
      if (!Item.equal(before[slot], window.slots[slot])) changed.push(slot)
    }
    return changed
  }

  function canQuickCraft (item, carried) {
    return !item || (sameItem(item, carried) && item.count < item.stackSize)
  }

  function quickCraft (window, click, gamemode) {
    const kind = Math.floor(click.mouseButton / 4)
    const stage = click.mouseButton % 4
    assert.ok(kind <= 2 && stage <= 2, 'invalid operation')

    if (stage === 0) {
      if (!window.selectedItem || (kind === 2 && gamemode !== 1)) {
        quickCrafts.delete(window)
        return
      }
      quickCrafts.set(window, { kind, slots: new Set() })
      return
    }

    const state = quickCrafts.get(window)
    if (!state || state.kind !== kind) {
      quickCrafts.delete(window)
      return
    }

    if (stage === 1) {
      const item = window.slots[click.slot]
      if (canQuickCraft(item, window.selectedItem) &&
          (kind === 2 || window.selectedItem.count > state.slots.size)) {
        state.slots.add(click.slot)
      }
      return
    }

    quickCrafts.delete(window)
    if (!window.selectedItem || state.slots.size === 0) return

    const carried = window.selectedItem
    const perSlot = kind === 0 ? Math.floor(carried.count / state.slots.size) : 1
    let remaining = carried.count

    for (const slot of state.slots) {
      const item = window.slots[slot]
      const max = item?.stackSize ?? carried.stackSize
      const amount = kind === 2 ? max - (item?.count ?? 0) : Math.min(perSlot, max - (item?.count ?? 0), remaining)
      if (amount <= 0) continue
      window.updateSlot(slot, cloneItem(item ?? carried, (item?.count ?? 0) + amount))
      if (kind !== 2) remaining -= amount
    }

    window.selectedItem = kind === 2 ? null : cloneItem(carried, remaining)
  }

  function pickupAll (window, click) {
    const carried = window.selectedItem
    if (!carried || window.slots[click.slot]) return

    let remaining = carried.stackSize - carried.count
    for (let pass = 0; pass < 2 && remaining > 0; pass++) {
      for (let slot = 0; slot < window.slots.length && remaining > 0; slot++) {
        const item = window.slots[slot]
        if (!sameItem(item, carried) || (pass === 0 && item.count === item.stackSize)) continue
        const taken = Math.min(item.count, remaining)
        remaining -= taken
        carried.count += taken
        window.updateSlot(slot, cloneItem(item, item.count - taken))
      }
    }
  }

  function offhandSwap (window, click, offhandWindow) {
    if (window.selectedItem) return
    const source = window.slots[click.slot]
    const offhand = offhandWindow.slots[45]
    window.updateSlot(click.slot, cloneItem(offhand))
    offhandWindow.updateSlot(45, cloneItem(source))
  }

  function moveToRange (window, source, start, end, reversed = false) {
    const slots = Array.from({ length: end - start }, (_, index) => start + index)
    if (reversed) slots.reverse()

    for (const slot of slots) {
      const target = window.slots[slot]
      if (slot === source.slot || !sameItem(target, source) || target.count >= target.stackSize) continue
      const moved = Math.min(source.count, target.stackSize - target.count)
      window.updateSlot(slot, cloneItem(target, target.count + moved))
      source.count -= moved
      if (source.count === 0) break
    }

    for (const slot of slots) {
      if (source.count === 0) break
      if (window.slots[slot] || slot === source.slot) continue
      const moved = Math.min(source.count, source.stackSize)
      window.updateSlot(slot, cloneItem(source, moved))
      source.count -= moved
    }

    window.updateSlot(source.slot, cloneItem(source))
  }

  function quickMove (window, click) {
    const source = window.slots[click.slot]
    if (!source) return

    if (window.type === 'minecraft:inventory') {
      if (click.slot < window.inventoryStart) {
        moveToRange(window, source, window.inventoryStart, window.inventoryEnd, click.slot === window.craftingResultSlot)
      } else if (click.slot < window.hotbarStart) {
        moveToRange(window, source, window.hotbarStart, window.inventoryEnd)
      } else {
        moveToRange(window, source, window.inventoryStart, window.hotbarStart)
      }
    } else if (click.slot < window.inventoryStart) {
      moveToRange(window, source, window.inventoryStart, window.inventoryEnd, true)
    } else {
      moveToRange(window, source, 0, window.inventoryStart)
      if (source.count > 0) {
        if (click.slot < window.hotbarStart) {
          moveToRange(window, source, window.hotbarStart, window.inventoryEnd)
        } else {
          moveToRange(window, source, window.inventoryStart, window.hotbarStart)
        }
      }
    }
  }

  return function simulateInventoryClick (window, click, gamemode = 0, offhandWindow = window) {
    const before = window.slots.map(item => cloneItem(item))

    if (click.mode === 1) {
      quickMove(window, click)
    } else if (click.mode === 2 && click.mouseButton === 40) {
      offhandSwap(window, click, offhandWindow)
    } else if (click.mode === 5) {
      quickCraft(window, click, gamemode)
    } else if (click.mode === 6) {
      assert.strictEqual(click.mouseButton, 0, 'invalid operation')
      pickupAll(window, click)
    } else {
      window.acceptClick(click, gamemode)
    }

    return changedSlots(before, window)
  }
}
