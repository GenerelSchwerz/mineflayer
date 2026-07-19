const { Vec3 } = require('vec3')
const assert = require('assert')
const conv = require('../conversions')
const math = require('../math')
const { performance } = require('perf_hooks')
const { createDoneTask, createTask } = require('../promise_utils')
const {
  BotcraftPhysics,
  EPhysicsCtx,
  PhysicsWorldSettings,
  initSetup,
  convertPlayerState,
  applyToPlayerState
} = require('@nxg-org/mineflayer-physics-util')
const { JavaFloat } = require('../javamath')

const mouseSensitivity = 100.0
// default is 0.5F (corresponds to 100%), so we just translate according to that
const rawSensitivity = new JavaFloat(mouseSensitivity).divide(new JavaFloat(200.0))
const f = rawSensitivity.multiply(new JavaFloat(0.6)).add(new JavaFloat(0.2))
const roundingGCD = new JavaFloat(0.15).multiply(new JavaFloat(8.0)).multiply(f).multiply(f).multiply(f)

const DEFAULT_PHYSICS_INTERVAL_MS = 50
const DEFAULT_PHYSICS_TIMESTEP = DEFAULT_PHYSICS_INTERVAL_MS / 1000
// Vanilla LocalPlayer.sendPosition uses a 2.0E-4 squared-distance threshold,
// not the server-side 0.03 movement lenience.
const MIN_DELTA_DIST_SQUARED = 4.0E-8

function checkInputEquality (oldInput, newInput) {
  const oldKeys = Object.keys(oldInput)
  const newKeys = Object.keys(newInput)
  if (oldKeys.length !== newKeys.length) return false
  for (const key of oldKeys) {
    if (oldInput[key] !== newInput[key]) return false
  }
  return true
}

function cloneInput (input) {
  return {
    forward: input.forward,
    back: input.back,
    left: input.left,
    right: input.right,
    jump: input.jump,
    sprint: input.sprint,
    sneak: input.sneak
  }
}

function deltaYawRadians (yaw1, yaw2) {
  const PI = Math.PI
  const PI_2 = Math.PI * 2
  let dYaw = (yaw1 - yaw2) % PI_2
  if (dYaw < -PI) dYaw += PI_2
  else if (dYaw > PI) dYaw -= PI_2
  return dYaw
}

function deltaYawDegrees (yaw1, yaw2) {
  let dYaw = new JavaFloat((yaw1.subtract(yaw2)) % new JavaFloat(360))
  if (dYaw.valueOf() < -180) dYaw = dYaw.add(new JavaFloat(360))
  else if (dYaw.valueOf() > 180) dYaw = dYaw.subtract(new JavaFloat(360))
  return dYaw
}

function setAngleDegrees (bot, newYaw, newPitch, autoround = true) {
  if (typeof bot.entity.yawDegrees === 'undefined') {
    bot.entity.yawDegrees = new JavaFloat(0)
    bot.entity.pitchDegrees = new JavaFloat(0)
  }

  if (autoround) {
    const dYaw = deltaYawDegrees(new JavaFloat(newYaw), bot.entity.yawDegrees)
    const normYaw = bot.entity.yawDegrees.add(dYaw)
    bot.entity.yawDegrees = normYaw.divide(roundingGCD).round().multiply(roundingGCD)
    bot.entity.pitchDegrees = new JavaFloat(newPitch).divide(roundingGCD).round().multiply(roundingGCD)
  } else {
    bot.entity.yawDegrees = new JavaFloat(newYaw)
    bot.entity.pitchDegrees = new JavaFloat(newPitch)
  }

  bot.entity.pitchDegrees = bot.entity.pitchDegrees.clamp(new JavaFloat(-90.0), new JavaFloat(90.0))
  bot.entity.yaw = conv.fromNotchianYaw(bot.entity.yawDegrees)
  bot.entity.pitch = conv.fromNotchianPitch(bot.entity.pitchDegrees)
}

/**
 * @param {import('mineflayer').Bot} bot
 * @param {*} param1
 */
function inject (bot, { physicsEnabled, maxCatchupTicks }) {
  const POSITION_EVERY_N_TICKS = (bot.version === '1.21.5' ? 19 : 20)
  const PHYSICS_CATCHUP_TICKS = maxCatchupTicks ?? 4
  const world = { getBlock: (pos) => bot.blockAt(pos, false) }

  const physics = new BotcraftPhysics(bot.registry)
  initSetup(bot.registry)

  const positionUpdateSentEveryTick = bot.supportFeature('positionUpdateSentEveryTick')

  bot.jumpQueued = false
  bot.jumpTicks = 0

  const controlState = {
    forward: false,
    back: false,
    left: false,
    right: false,
    jump: false,
    sprint: false,
    sneak: false
  }

  let lastSentYaw = null
  let lastSentPitch = null
  let doPhysicsTimer = null
  let lastPhysicsFrameTime = null
  let shouldUsePhysics = false
  bot.physicsEnabled = physicsEnabled ?? true
  let deadTicks = 21
  let physicsIntervalMs = DEFAULT_PHYSICS_INTERVAL_MS
  let physicsTimestep = DEFAULT_PHYSICS_TIMESTEP

  const settings = new PhysicsWorldSettings(bot.registry)
  settings.yawSpeed = 6000 // default speed is 60 for upstream mineflayer * 20. Bumped to allow instant turns.
  settings.pitchSpeed = 6000
  settings.overrides = {}

  /**
   * @type {EPhysicsCtx<PlayerState> | undefined}
   */
  let ectx

  let lastSent = {
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    pitch: 0,
    onGround: false,
    ticker: POSITION_EVERY_N_TICKS,
    flags: { onGround: false, hasHorizontalCollision: false },
    sprintState: false,
    sneakState: false,
    previousInputState: cloneInput(controlState)
  }

  let elytraFlyTask = createDoneTask()
  let elytraFlyTimeout = null
  let pendingElytraFly = false
  let forceElytraFly = false
  let resolveForcedElytraFlyImmediately = false
  let speculativeElytraFly = false
  let elytraTakeoffControl = null

  bot._lastSent = lastSent

  const lastUpdated = {
    yaw: 0,
    pitch: 0
  }

  let timeAccumulator = 0
  let catchupTicks = 0

  function getHorizontalCollision () {
    return bot.registry.isNewerOrEqualTo('1.21.3') &&
      !!(bot.entity.horizontalCollision ?? bot.entity.isCollidedHorizontally)
  }

  function setPendingElytraFlyRequestState (enabled) {
    if (bot.entity == null) return
    bot.entity._pendingElytraFlyRequest = enabled
  }

  function isElytraTakeoffControlActive () {
    return elytraTakeoffControl != null && (pendingElytraFly || speculativeElytraFly)
  }

  function hasConfirmedElytraFlightState () {
    return (bot.entity.fallFlying || bot.entity.elytraFlying) &&
      bot.entity._pendingElytraFlightConfirmation !== true
  }

  function startElytraTakeoffControl (assistTakeoff) {
    if (elytraTakeoffControl != null) return

    elytraTakeoffControl = {
      previousControls: cloneInput(controlState),
      overrideMovement: assistTakeoff === true,
      phase: (bot.entity.onGround || lastSent.onGround)
        ? (controlState.jump ? 'ground_release' : 'ground_jump')
        : (controlState.jump ? 'air_release' : 'air_press')
    }
  }

  function clearElytraTakeoffControl () {
    if (elytraTakeoffControl == null) return

    const { previousControls, overrideMovement } = elytraTakeoffControl
    elytraTakeoffControl = null

    controlState.jump = previousControls.jump
    if (overrideMovement) {
      for (const key of Object.keys(previousControls)) {
        if (key === 'jump') continue
        controlState[key] = previousControls[key]
      }
    }
  }

  function advanceElytraTakeoffControlBeforePackets () {
    if (elytraTakeoffControl == null) return

    // Vanilla clears the glide flag when gliding is no longer valid rather than
    // treating every local fallFlying flip as authoritative; see
    // LivingEntity.updateFallFlying()/canGlide() in 1.21.4. Keep the takeoff
    // controller alive until flight is speculative or confirmed so the
    // START_FLYING_WITH_ELYTRA packet is not dropped while a stale local
    // fall-flying bit is still set. Grim is sensitive to that packet/input
    // ordering and will see an orphaned pending request as invalid.
    if (speculativeElytraFly || hasConfirmedElytraFlightState() || !pendingElytraFly) {
      clearElytraTakeoffControl()
      return
    }

    if (elytraTakeoffControl.overrideMovement) {
      controlState.forward = true
      controlState.back = false
      controlState.left = false
      controlState.right = false
      controlState.sprint = true
      controlState.sneak = false
    }

    if (elytraTakeoffControl.phase === 'ground_release') {
      controlState.jump = false
      return
    }

    if (elytraTakeoffControl.phase === 'ground_jump') {
      if (!controlState.jump) {
        controlState.jump = true
        bot.jumpQueued = true
      }
      return
    }

    if (elytraTakeoffControl.phase === 'air_release') {
      controlState.jump = false
      return
    }

    if (elytraTakeoffControl.phase === 'air_press' && !controlState.jump) {
      controlState.jump = true
      bot.jumpQueued = true
    }
  }

  function advanceElytraTakeoffControlAfterPackets () {
    if (elytraTakeoffControl == null) return

    if (speculativeElytraFly || hasConfirmedElytraFlightState() || !pendingElytraFly) {
      clearElytraTakeoffControl()
      return
    }

    if ((elytraTakeoffControl.phase === 'air_release' || elytraTakeoffControl.phase === 'air_press') &&
        bot.entity.onGround && lastSent.onGround) {
      elytraTakeoffControl.phase = controlState.jump ? 'ground_release' : 'ground_jump'
      return
    }

    if (elytraTakeoffControl.phase === 'ground_release') {
      if (lastSent.previousInputState.jump === false) {
        elytraTakeoffControl.phase = 'ground_jump'
      }
      return
    }

    if (elytraTakeoffControl.phase === 'ground_jump') {
      if (!bot.entity.onGround && !lastSent.onGround) {
        elytraTakeoffControl.phase = 'air_release'
      }
      return
    }

    if (elytraTakeoffControl.phase === 'air_release' && lastSent.previousInputState.jump === false) {
      elytraTakeoffControl.phase = 'air_press'
    }
  }

  function restartPhysicsTimer () {
    if (doPhysicsTimer === null) return
    clearInterval(doPhysicsTimer)
    doPhysicsTimer = setInterval(doPhysics, physicsIntervalMs)
  }

  function doPhysics () {
    const now = performance.now()
    const deltaSeconds = (now - lastPhysicsFrameTime) / 1000
    lastPhysicsFrameTime = now

    timeAccumulator += deltaSeconds
    catchupTicks = 0
    while (timeAccumulator >= physicsTimestep) {
      tickPhysics(now)
      timeAccumulator -= physicsTimestep
      catchupTicks++
      if (catchupTicks >= PHYSICS_CATCHUP_TICKS) break
    }
  }

  function tickPhysics (now) {
    const timestep = physicsTimestep

    if (bot.blockAt(bot.entity.position) == null) return

    bot.emit('physicsTickBegin')

    // Vanilla has the current tick's input settled before movement and packet
    // emission. Keep assisted elytra takeoff control in sync with physics so
    // the movement packet matches the input state Grim sees for that tick.
    advanceElytraTakeoffControlBeforePackets()

    if (lastSentYaw === null) lastSentYaw = bot.entity.yaw
    if (lastSentPitch === null) lastSentPitch = bot.entity.pitch

    if (shouldUsePhysics) {
      const dYaw = deltaYawRadians(bot.entity.yaw, lastSentYaw)
      const dPitch = bot.entity.pitch - lastSentPitch

      const maxDeltaYaw = timestep * bot.physicsSettings.yawSpeed
      const maxDeltaPitch = timestep * bot.physicsSettings.pitchSpeed

      lastSentYaw += math.clamp(-maxDeltaYaw, dYaw, maxDeltaYaw)
      lastSentPitch += math.clamp(-maxDeltaPitch, dPitch, maxDeltaPitch)
    }

    if (bot.physicsEnabled && shouldUsePhysics) {
      ectx ??= EPhysicsCtx.FROM_BOT(physics, bot, settings)
      ectx.state.update(bot)

      ectx.state.yaw = lastSentYaw
      ectx.state.pitch = lastSentPitch

      Object.assign(ectx, settings.overrides)

      const targetYaw = bot.entity.yaw
      const targetPitch = bot.entity.pitch

      physics.simulate(ectx, world).apply(bot)
      bot.entity.yaw = targetYaw
      bot.entity.pitch = targetPitch
      bot.emit('entityPhysicsTick')
    }

    if (shouldUsePhysics) updatePosition(now)

    // move this afterward to sync inputs.
    if (bot.physicsEnabled && shouldUsePhysics) {
      bot.emit('physicsTick')
      bot.emit('physicTick')
    }

    if (bot.registry.isNewerOrEqualTo('1.21.3')) {
      bot._client.write('tick_end', {})
    }
  }

  bot.on('newListener', (name) => {
    if (name === 'physicTick') {
      console.warn('Mineflayer detected that you are using a deprecated event (physicTick)! Please use physicsTick instead.')
    }
  })

  function cleanup () {
    clearInterval(doPhysicsTimer)
    doPhysicsTimer = null
  }

  function sendPacketPosition (position, onGround, hasHorizontalCollision) {
    // Don't send position packets during configuration phase (Velocity support)
    if (bot.inConfigurationPhase) return

    // console.log(`sendPacketPosition: position=${position.toString()} onGround=${onGround} hasHorizontalCollision=${hasHorizontalCollision}`)

    // sends data, no logic
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y) || !Number.isFinite(position.z)) return
    const oldPos = new Vec3(lastSent.x, lastSent.y, lastSent.z)
    lastSent.x = position.x
    lastSent.y = position.y
    lastSent.z = position.z
    lastSent.onGround = onGround
    lastSent.flags = { onGround, hasHorizontalCollision }
    bot._client.write('position', lastSent)
    bot.emit('move', oldPos)
  }

  function sendPacketLook (yaw, pitch, onGround, hasHorizontalCollision) {
    // Don't send look packets during configuration phase (Velocity support)
    if (bot.inConfigurationPhase) return

    // sends data, no logic
    const oldPos = new Vec3(lastSent.x, lastSent.y, lastSent.z)
    lastSent.yaw = yaw
    lastSent.pitch = pitch
    lastSent.onGround = onGround
    lastSent.flags = { onGround, hasHorizontalCollision }
    bot._client.write('look', lastSent)
    bot.emit('move', oldPos)
  }

  function sendPacketPositionAndLook (position, yaw, pitch, onGround, hasHorizontalCollision = getHorizontalCollision()) {
    // Don't send position_look packets during configuration phase (Velocity support)
    if (bot.inConfigurationPhase) return

    // console.log(`sendPacketPositionAndLook: position=${position.toString()} yaw=${yaw} pitch=${pitch} onGround=${onGround} hasHorizontalCollision=${hasHorizontalCollision}`)
    // sends data, no logic
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y) || !Number.isFinite(position.z)) return
    const oldPos = new Vec3(lastSent.x, lastSent.y, lastSent.z)
    lastSent.x = position.x
    lastSent.y = position.y
    lastSent.z = position.z
    lastSent.yaw = yaw
    lastSent.pitch = pitch
    lastSent.onGround = onGround
    lastSent.flags = { onGround, hasHorizontalCollision }
    bot._client.write('position_look', lastSent)
    bot.emit('move', oldPos)
  }

  function sendPacketVehicleMove (position) {
    bot.vehicleMove ??= {
      forward: bot.controlState.forward ? 1 : bot.controlState.back ? -1 : 0,
      sideways: bot.controlState.left ? -1 : bot.controlState.right ? 1 : 0,
      jump: bot.controlState.jump ? 1 : 0
    }

    for (const key of Object.keys(bot.vehicleMove)) {
      bot.vehicleMove[key] = Math.min(Math.abs(bot.vehicleMove[key]), 0.9800000190734863) * Math.sign(bot.vehicleMove[key])
    }

    bot.moveVehicle(bot.vehicleMove.sideways, bot.vehicleMove.forward, bot.vehicleMove.jump)
    bot._client.write('vehicle_move', {
      x: bot.vehicle.position.x,
      y: bot.vehicle.position.y,
      z: bot.vehicle.position.z,
      yaw: bot.vehicle.yaw,
      pitch: bot.vehicle.pitch
    })

    bot.vehicleMove = {
      sideways: 0,
      forward: 0,
      jump: 0
    }

    bot.entity.position = bot.vehicle.position.offset(0, bot.vehicle.height, 0)
  }

  function isEntityRemoved () {
    if (bot.isAlive === true) deadTicks = 0
    if (bot.isAlive === false && deadTicks <= 20) deadTicks++
    return deadTicks >= 20
  }

  function updatePosition (now) {
    if (isEntityRemoved()) return
    // Don't send position with invalid coordinates (NaN after death)
    if (!Number.isFinite(bot.entity.position.x)) return

    // Don't send any position packets during configuration phase (Velocity support)
    if (bot.inConfigurationPhase) return

    const forward = (controlState.forward ? 1 : 0) - (controlState.back ? 1 : 0)
    const isSprintingApplicable = forward > 0 && !controlState.sneak && !bot.entity.isInWater && !bot.entity.isInLava
    const fallbackSprint = isSprintingApplicable && controlState.sprint
    const resolvedSprint = ectx?.state?.sprinting ?? bot.entity.sprinting
    const actualSprint = typeof resolvedSprint === 'boolean' ? resolvedSprint : fallbackSprint
    const isJumpRisingEdge = controlState.jump && !lastSent.previousInputState.jump

    // Vanilla starts fall-flying during aiStep(), before the packet send phase
    // for shift/input/sprint/movement. Grim's Post check also expects the
    // elytra entity_action not to trail behind a movement packet.
    tryStartPendingElytraFly(isJumpRisingEdge)

    if (lastSent.sneakState !== controlState.sneak) {
      bot._client.write('entity_action', {
        entityId: bot.entity.id,
        actionId: bot.supportFeature('entityActionUsesStringMapper')
          ? (controlState.sneak ? 'start_sneaking' : 'stop_sneaking')
          : (controlState.sneak ? 0 : 1),
        jumpBoost: 0
      })
      lastSent.sneakState = controlState.sneak
    }

    if (bot.supportFeature('newPlayerInputPacket') &&
        !checkInputEquality(lastSent.previousInputState, controlState)) {
      lastSent.previousInputState = cloneInput(controlState)
      bot._client.write('player_input', {
        inputs: {
          forward: controlState.forward,
          backward: controlState.back,
          left: controlState.left,
          right: controlState.right,
          jump: controlState.jump,
          shift: controlState.sneak,
          sprint: controlState.sprint
        }
      })
    }

    if (lastSent.sprintState !== actualSprint) {
      bot._client.write('entity_action', {
        entityId: bot.entity.id,
        actionId: bot.supportFeature('entityActionUsesStringMapper')
          ? (actualSprint ? 'start_sprinting' : 'stop_sprinting')
          : (actualSprint ? 3 : 4),
        jumpBoost: 0
      })
      lastSent.sprintState = actualSprint
    }

    const yaw = Math.fround(conv.toNotchianYaw(lastSentYaw))
    const pitch = Math.fround(conv.toNotchianPitch(lastSentPitch))
    const position = bot.entity.position
    const onGround = bot.entity.onGround
    const hasHorizontalCollision = getHorizontalCollision()

    const dx = position.x - lastSent.x
    const dy = position.y - lastSent.y
    const dz = position.z - lastSent.z
    const positionUpdated =
      (dx * dx + dy * dy + dz * dz > MIN_DELTA_DIST_SQUARED) ||
      lastSent.ticker === 0

    const lookUpdated = lastUpdated.yaw !== yaw || lastUpdated.pitch !== pitch

    const onVehicle = !!bot.entity.vehicle
    const onBoat = bot.vehicle?.name === 'boat'
    if (onBoat) {
      bot._client.write('steer_boat', {
        leftPaddle: bot.controlState.left || bot.controlState.forward || bot.controlState.back,
        rightPaddle: bot.controlState.right || bot.controlState.forward || bot.controlState.back
      })
    }

    let sendLook = false
    if (onVehicle) {
      sendLook = true
    } else if (positionUpdated && lookUpdated) {
      sendPacketPositionAndLook(position, yaw, pitch, onGround, hasHorizontalCollision)
      lastSent.ticker = POSITION_EVERY_N_TICKS
    } else if (positionUpdated) {
      sendPacketPosition(position, onGround, hasHorizontalCollision)
      lastSent.ticker = POSITION_EVERY_N_TICKS
    } else if (lookUpdated) {
      sendLook = true
    } else if (positionUpdateSentEveryTick || onGround !== lastSent.onGround || hasHorizontalCollision !== lastSent.flags.hasHorizontalCollision) {
      bot._client.write('flying', {
        flags: { onGround, hasHorizontalCollision }
      })
      lastSent.flags = { onGround, hasHorizontalCollision }
    }

    if (sendLook) {
      sendPacketLook(yaw, pitch, onGround, hasHorizontalCollision)
    }

    if (onVehicle) {
      sendPacketVehicleMove(position)
    }

    if (lookUpdated) {
      lastUpdated.yaw = yaw
      lastUpdated.pitch = pitch
    }

    if (!positionUpdated) {
      lastSent.ticker -= 1
    }

    lastSent.onGround = bot.entity.onGround
    advanceElytraTakeoffControlAfterPackets()
    bot.physicsEngineCtx = ectx
  }

  bot.physicsEngine = physics
  bot.physicsSettings = settings
  bot.physicsCtx = ectx

  const obj = {}
  Object.keys(bot.physicsEngine).forEach((key) => {
    Object.defineProperty(obj, key, {
      get () {
        return bot.physicsEngine[key]
      },
      set (value) {
        bot.physicsEngine[key] = value
        return value
      }
    })
  })

  Object.keys(bot.physicsSettings).forEach((key) => {
    Object.defineProperty(obj, key, {
      get () {
        return bot.physicsSettings[key]
      },
      set (value) {
        bot.physicsSettings[key] = value
        return value
      }
    })
  })

  Object.defineProperty(obj, 'physicsIntervalMs', {
    enumerable: true,
    get () {
      return physicsIntervalMs
    },
    set (value) {
      if (!Number.isFinite(value) || value <= 0) {
        throw new RangeError('physics.physicsIntervalMs must be a finite number greater than 0')
      }
      physicsIntervalMs = value
      physicsTimestep = value / 1000
      restartPhysicsTimer()
      return value
    }
  })

  obj.simulatePlayer = function (oldState, world) {
    const eType = bot.registry.entitiesByName.player ?? bot.registry.entitiesByName['minecraft:player']

    // for versions 1.9 and below, this doesn't exist.
    // I provide a default if this value is undefined, so this is fine either way.
    // if (!eType) throw new Error('Player entity type not found in registry')

    const state = convertPlayerState(bot, oldState, physics)

    const ectx = EPhysicsCtx.FROM_ENTITY_STATE(
      physics,
      state,
      eType,
      settings
    )

    Object.assign(ectx, settings.overrides)

    physics.simulate(ectx, world)
    applyToPlayerState(state, oldState)
  }

  bot.physics = obj
  bot.physicsWorld = world

  function getEffectLevel (mcData, effectName, effects) {
    const effectDescriptor = mcData.effectsByName[effectName]
    if (!effectDescriptor) return 0
    const effectInfo = effects[effectDescriptor.id]
    if (!effectInfo) return 0
    return effectInfo.amplifier + 1
  }

  function getElytraFlyPreflightError () {
    if (bot.entity.fallFlying) {
      return 'Already elytra flying'
    } else if (bot.entity.onClimbable) {
      return 'Unable to elytra fly while on climbable'
    } else if (bot.entity.vehicle) {
      return 'Unable to elytra fly while in vehicle'
    } else if (bot.entity.isInWater) {
      return 'Unable to elytra fly while in water'
    }

    const mcData = require('minecraft-data')(bot.version)
    if (getEffectLevel(mcData, 'Levitation', bot.entity.effects) > 0) {
      return 'Unable to elytra fly with levitation effect'
    }

    const torsoSlot = bot.getEquipmentDestSlot('torso')
    const item = bot.inventory.slots[torsoSlot]
    if (item == null || item.name !== 'elytra') {
      return 'Elytra must be equip to start flying'
    }

    return null
  }

  function getPendingElytraFlyPreflightError (force = false) {
    const preflightError = getElytraFlyPreflightError()
    if (force && preflightError === 'Already elytra flying') return null
    if (preflightError !== 'Already elytra flying') return preflightError

    // The local physics engine can flip fallFlying on the same rising-edge jump
    // that should also emit START_FLYING_WITH_ELYTRA. Treat that as the vanilla
    // local-state transition for this pending request rather than rejecting our
    // own packet before it is written.
    if (pendingElytraFly && !speculativeElytraFly && bot.entity._pendingElytraFlightConfirmation !== true) {
      return null
    }

    return preflightError
  }

  function tryStartPendingElytraFly (isJumpRisingEdge) {
    if (!pendingElytraFly || elytraFlyTask.done) return

    const preflightError = getPendingElytraFlyPreflightError(forceElytraFly)
    if (preflightError != null) {
      clearPendingElytraFly(new Error(preflightError))
      return
    }

    if (!forceElytraFly) {
      if (bot.entity.onGround || lastSent.onGround) return
      if (!isJumpRisingEdge) return
    }

    // Intentional deviation from vanilla: vanilla only emits
    // START_FLYING_WITH_ELYTRA after the off-ground jump transition in
    // LocalPlayer/LivingEntity. The documented mineflayer force option is used
    // here to bypass that packet-send gate as well, so a forced rebounce sends
    // the packet immediately instead of waiting for a new airborne jump edge.
    // This is specifically for anticheat experimentation where preserving
    // continuous local fall-flying state is preferred over vanilla timing.

    bot._client.write('entity_action', {
      entityId: bot.entity.id,
      actionId: bot.supportFeature('entityActionUsesStringMapper') ? 'start_elytra_flying' : 8,
      jumpBoost: 0
    })
    if (resolveForcedElytraFlyImmediately) {
      clearPendingElytraFly()
      return
    }

    setLocalElytraFlyState(true)
    speculativeElytraFly = true
    pendingElytraFly = false
    forceElytraFly = false
    setPendingElytraFlyRequestState(false)
  }

  function setLocalElytraFlyState (enabled) {
    bot.entity.elytraFlying = enabled
    bot.entity.fallFlying = enabled
    bot.entity._pendingElytraFlightConfirmation = enabled

    if (ectx?.state != null) {
      if ('elytraFlying' in ectx.state) ectx.state.elytraFlying = enabled
      if ('fallFlying' in ectx.state) ectx.state.fallFlying = enabled
    }
  }

  function clearPendingElytraFly (err) {
    clearElytraTakeoffControl()

    pendingElytraFly = false
    forceElytraFly = false
    resolveForcedElytraFlyImmediately = false
    setPendingElytraFlyRequestState(false)
    if (elytraFlyTimeout != null) {
      clearTimeout(elytraFlyTimeout)
      elytraFlyTimeout = null
    }

    if (err != null && speculativeElytraFly) {
      setLocalElytraFlyState(false)
    }
    speculativeElytraFly = false

    if (err != null) {
      elytraFlyTask.cancel(err)
    } else {
      elytraFlyTask.finish()
    }

    elytraFlyTask = createDoneTask()
  }

  function armPendingElytraFlyTimeout (assistTakeoff) {
    if (elytraFlyTimeout != null) {
      clearTimeout(elytraFlyTimeout)
    }

    elytraFlyTimeout = setTimeout(() => {
      clearPendingElytraFly(new Error('Timed out waiting for elytra flight to start'))
    }, assistTakeoff ? 2500 : 1500)
  }

  bot.elytraFly = async (options = {}) => {
    const normalizedOptions = typeof options === 'boolean' ? { assistTakeoff: options } : options
    const {
      assistTakeoff = false,
      force = false
    } = normalizedOptions

    if (!elytraFlyTask.done) {
      // Vanilla re-evaluates jump/input state each tick before movement and
      // packet emission; see LocalPlayer.tick()/serverAiStep() and
      // LivingEntity.travel() in the 1.21.4 client. If a previous mineflayer
      // elytra request is still pending, let a forced retry refresh that
      // pending controller instead of coalescing it away until timeout.
      // Anticheat expects a renewed grounded takeoff sequence to emit the
      // matching START_FLYING_WITH_ELYTRA packet rather than preserving a
      // stale pending request with outdated jump state.
      if (force && pendingElytraFly) {
        const preflightError = getElytraFlyPreflightError()
        if (preflightError != null && preflightError !== 'Already elytra flying') {
          clearPendingElytraFly(new Error(preflightError))
        } else {
          forceElytraFly = true
          resolveForcedElytraFlyImmediately = preflightError === 'Already elytra flying'
          clearElytraTakeoffControl()
          startElytraTakeoffControl(assistTakeoff)
          setPendingElytraFlyRequestState(true)
          armPendingElytraFlyTimeout(assistTakeoff)
        }
      }

      return await elytraFlyTask.promise
    }

    const preflightError = getElytraFlyPreflightError()
    if (preflightError != null && !(force && preflightError === 'Already elytra flying')) {
      throw new Error(preflightError)
    }

    elytraFlyTask = createTask()
    pendingElytraFly = true
    forceElytraFly = force
    resolveForcedElytraFlyImmediately = force && preflightError === 'Already elytra flying'
    setPendingElytraFlyRequestState(true)
    startElytraTakeoffControl(assistTakeoff)
    armPendingElytraFlyTimeout(assistTakeoff)

    return await elytraFlyTask.promise
  }

  bot.spoofControlState = (control, state) => {
    controlState[control] = state
  }

  bot.setControlState = (control, state) => {
    if (control === 'sneak' && bot.vehicle) {
      bot.dismount()
      return
    }

    assert.ok(control in controlState, `invalid control: ${control}`)
    assert.ok(typeof state === 'boolean', `invalid state: ${state}`)
    if (control === 'jump' && isElytraTakeoffControlActive()) return
    if (controlState[control] === state) return

    controlState[control] = state
    if (control === 'jump' && state) {
      bot.jumpQueued = true
    }
  }

  bot.getControlState = (control) => {
    assert.ok(control in controlState, `invalid control: ${control}`)
    return controlState[control]
  }

  bot.clearControlStates = () => {
    for (const control in controlState) {
      bot.setControlState(control, false)
    }
  }

  bot.controlState = {}
  for (const control of Object.keys(controlState)) {
    Object.defineProperty(bot.controlState, control, {
      get () {
        return controlState[control]
      },
      set (state) {
        bot.setControlState(control, state)
        return state
      }
    })
  }

  let lookingTask = createDoneTask()
  let targetYaw = null
  let targetPitch = null

  bot.on('physicsTick', () => {
    if (lookingTask.done || targetYaw == null || targetPitch == null) return

    const currentYawDeg = new JavaFloat(conv.toNotchianYaw(bot.entity.yaw))
    const currentPitchDeg = new JavaFloat(conv.toNotchianPitch(bot.entity.pitch))

    const deltaYaw = deltaYawDegrees(targetYaw, currentYawDeg).valueOf()
    const deltaPitch = targetPitch.subtract(currentPitchDeg).valueOf()

    if (Math.abs(deltaYaw) < 0.1 && Math.abs(deltaPitch) < 0.1) {
      lookingTask.finish()
      return
    }

    const yawChange = math.clamp(-bot.physicsSettings.yawSpeed / 20, deltaYaw, bot.physicsSettings.yawSpeed / 20)
    const pitchChange = math.clamp(-bot.physicsSettings.pitchSpeed / 20, deltaPitch, bot.physicsSettings.pitchSpeed / 20)

    setAngleDegrees(
      bot,
      currentYawDeg.valueOf() + yawChange,
      currentPitchDeg.valueOf() + pitchChange,
      true
    )
  })

  bot._client.on('explosion', explosion => {
    if (bot.physicsEnabled && bot.game.gameMode !== 'creative') {
      if (explosion.playerKnockback) {
        bot.entity.velocity.x += explosion.playerKnockback.x
        bot.entity.velocity.y += explosion.playerKnockback.y
        bot.entity.velocity.z += explosion.playerKnockback.z
      }
      if ('playerMotionX' in explosion) {
        bot.entity.velocity.x += explosion.playerMotionX
        bot.entity.velocity.y += explosion.playerMotionY
        bot.entity.velocity.z += explosion.playerMotionZ
      }
    }
  })

  bot.look = async (yaw, pitch, force) => {
    if (!lookingTask.done) {
      lookingTask.finish()
      targetYaw = null
      targetPitch = null
    }

    const yawNotchian = conv.toNotchianYaw(yaw)
    const pitchNotchian = conv.toNotchianPitch(pitch)

    if (force) {
      setAngleDegrees(bot, yawNotchian, pitchNotchian, true)
      lastSentYaw = bot.entity.yaw
      lastSentPitch = bot.entity.pitch
      return
    }

    lookingTask = createTask()
    targetYaw = new JavaFloat(yawNotchian)
    targetPitch = new JavaFloat(pitchNotchian)
    return await lookingTask.promise
  }

  bot.lookAt = async (point, force) => {
    const delta = point.minus(bot.entity.position.offset(0, bot.entity.eyeHeight, 0))
    const yaw = Math.atan2(-delta.x, -delta.z)
    const groundDistance = Math.sqrt(delta.x * delta.x + delta.z * delta.z)
    const pitch = Math.atan2(delta.y, groundDistance)
    await bot.look(yaw, pitch, force)
  }

  bot._client.on('player_rotation', (packet) => {
    setAngleDegrees(bot, packet.yaw, packet.pitch, false)
    lastSentYaw = bot.entity.yaw
    lastSentPitch = bot.entity.pitch
  })

  bot._client.on('position', (packet) => {
    bot.entity.height = 1.8

    const vel = bot.entity.velocity
    const pos = bot.entity.position
    let newYaw, newPitch

    if (typeof packet.flags === 'object') {
      vel.set(
        packet.flags.x ? vel.x : 0,
        packet.flags.y ? vel.y : 0,
        packet.flags.z ? vel.z : 0
      )
      pos.set(
        packet.flags.x ? (pos.x + packet.x) : packet.x,
        packet.flags.y ? (pos.y + packet.y) : packet.y,
        packet.flags.z ? (pos.z + packet.z) : packet.z
      )

      const currentYaw = typeof bot.entity.yawDegrees !== 'undefined'
        ? bot.entity.yawDegrees.valueOf()
        : conv.toNotchianYaw(bot.entity.yaw)
      const currentPitch = typeof bot.entity.pitchDegrees !== 'undefined'
        ? bot.entity.pitchDegrees.valueOf()
        : conv.toNotchianPitch(bot.entity.pitch)

      newYaw = (packet.flags.yaw ? currentYaw : 0) + packet.yaw
      newPitch = (packet.flags.pitch ? currentPitch : 0) + packet.pitch
    } else {
      vel.set(
        packet.flags & 1 ? vel.x : 0,
        packet.flags & 2 ? vel.y : 0,
        packet.flags & 4 ? vel.z : 0
      )
      pos.set(
        packet.flags & 1 ? (pos.x + packet.x) : packet.x,
        packet.flags & 2 ? (pos.y + packet.y) : packet.y,
        packet.flags & 4 ? (pos.z + packet.z) : packet.z
      )

      const currentYaw = typeof bot.entity.yawDegrees !== 'undefined'
        ? bot.entity.yawDegrees.valueOf()
        : conv.toNotchianYaw(bot.entity.yaw)
      const currentPitch = typeof bot.entity.pitchDegrees !== 'undefined'
        ? bot.entity.pitchDegrees.valueOf()
        : conv.toNotchianPitch(bot.entity.pitch)

      newYaw = (packet.flags & 8 ? currentYaw : 0) + packet.yaw
      newPitch = (packet.flags & 16 ? currentPitch : 0) + packet.pitch
    }

    setAngleDegrees(bot, newYaw, newPitch, false)
    bot.entity.onGround = false

    if (bot.supportFeature('teleportUsesOwnPacket')) {
      bot._client.write('teleport_confirm', { teleportId: packet.teleportId })
    }

    // After death/respawn, delay the forced position_look response.
    // Sending it immediately causes "Invalid move player packet" kicks
    // on older servers, but the server needs it to complete the respawn.
    if (respawnTimer > 0 && Date.now() - respawnTimer < 2000) {
      respawnTimer = 0 // only delay once
      const delayedPos = pos.clone()
      const delayedYaw = newYaw
      const delayedPitch = newPitch
      const delayedOnGround = bot.entity.onGround
      setTimeout(() => {
        sendPacketPositionAndLook(delayedPos, delayedYaw, delayedPitch, delayedOnGround)
        shouldUsePhysics = true
        bot.jumpTicks = 0
        lastSentYaw = bot.entity.yaw
        lastSentPitch = bot.entity.pitch
        bot.emit('forcedMove')
      }, 1500)
      return
    }

    sendPacketPositionAndLook(pos, newYaw, newPitch, bot.entity.onGround)

    shouldUsePhysics = true
    bot.jumpTicks = 0
    lastSentYaw = bot.entity.yaw
    lastSentPitch = bot.entity.pitch

    bot.emit('forcedMove')
  })

  bot.on('entityElytraState', (entity, elytraFlying) => {
    if (entity.id !== bot.entity?.id || elytraFlyTask.done) return
    if (elytraFlying) {
      clearPendingElytraFly()
    }
  })

  bot.waitForTicks = async function (ticks, tickBegin = false) {
    if (ticks <= 0) return
    const eventName = tickBegin ? 'physicsTickBegin' : 'physicsTick'
    await new Promise((resolve) => {
      const tickListener = () => {
        ticks--
        if (ticks === 0) {
          bot.removeListener(eventName, tickListener)
          resolve()
        }
      }

      bot.on(eventName, tickListener)
    })
  }

  let respawnTimer = 0
  bot.on('mount', () => { shouldUsePhysics = false })
  bot.on('death', () => {
    shouldUsePhysics = false
    respawnTimer = Date.now()
  })
  bot.on('respawn', () => { shouldUsePhysics = false })
  bot.on('login', () => {
    shouldUsePhysics = false
  })

  function forceResetControls () {
    elytraTakeoffControl = null
    setPendingElytraFlyRequestState(false)
    for (const control in controlState) {
      controlState[control] = false
    }
  }

  bot.on('respawn', () => {
    bot.entity.yawDegrees = new JavaFloat(0)
    bot.entity.pitchDegrees = new JavaFloat(0)
    shouldUsePhysics = false
    forceResetControls()
    clearPendingElytraFly(new Error('Elytra flight cancelled due to respawn'))
  })

  bot.on('login', () => {
    bot.entity.yawDegrees = new JavaFloat(0)
    bot.entity.pitchDegrees = new JavaFloat(0)
    shouldUsePhysics = false
    forceResetControls()
    bot.entity._pendingElytraFlightConfirmation = false

    lastSent = {
      x: 0,
      y: 0,
      z: 0,
      yaw: 0,
      pitch: 0,
      onGround: false,
      ticker: POSITION_EVERY_N_TICKS,
      flags: { onGround: false, hasHorizontalCollision: false },
      sprintState: false,
      sneakState: false,
      previousInputState: cloneInput(controlState)
    }

    bot._lastSent = lastSent
    lastSentYaw = null
    lastSentPitch = null
    lastUpdated.yaw = 0
    lastUpdated.pitch = 0
    clearPendingElytraFly(new Error('Elytra flight cancelled due to login'))

    if (doPhysicsTimer === null) {
      lastPhysicsFrameTime = performance.now()
      doPhysicsTimer = setInterval(doPhysics, physicsIntervalMs)
    }
  })

  bot.on('end', () => {
    clearPendingElytraFly(new Error('Elytra flight cancelled due to disconnect'))
    cleanup()
  })
}

module.exports = inject
