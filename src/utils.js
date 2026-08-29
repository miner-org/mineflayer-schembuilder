const { GoalNearAvoid } = require("@miner-org/mineflayer-baritone/src/goal");
const { Vec3 } = require("vec3");

/**
 *
 * @param {string} name
 */
function cleanName(name) {
  if (name.startsWith("minecraft:")) return name.split(":")[1];
  return name;
}

/**
 *
 * @param {string} name
 */
function formatName(name) {
  if (name === "redstone_wire") return "redstone";
  if (name === "redstone_wall_torch") return "redstone_torch";
  if (name.endsWith("_wall_sign")) return name.replace("_wall_sign", "_sign");

  return name;
}

function blockPropertiesMatch(block, desiredProps) {
  if (!desiredProps) return true;

  const blockProps = block.getProperties();

  for (const [key, value] of Object.entries(desiredProps)) {
    if (blockProps[key] !== value) {
      return false;
    }
  }

  return true;
}

function generateGiveCommandsForAllBlocks(schematic, bot) {
  const requiredBlocks = schematic.blockCounts;
  const giveCommands = [];

  for (const [blockName, requiredCount] of Object.entries(requiredBlocks)) {
    const command = `/give ${bot.username} ${blockName} ${requiredCount}`;
    giveCommands.push(command);
  }

  return giveCommands;
}

async function placeBlock(bot, position, properties = {}) {
  const dist = bot.entity.position.distanceTo(position);
  const feet = bot.entity.position.floored();
  const standingInTarget =
    feet.equals(position) || feet.offset(0, 1, 0).equals(position);

  if (standingInTarget || dist > 3.5) {
    try {
      await bot.ashfinder.goto(new GoalNearAvoid(position, 3));
    } catch (e) {
      console.warn(`Pathfinding failed for block at ${position}: ${e.message}`);
      return;
    }
  }

  const heldName = bot.heldItem?.name ?? "";

  const isStair = heldName.includes("stair");
  const isSlab = heldName.includes("slab");
  const isTrapdoor = heldName.includes("trapdoor");
  const isDoor = heldName.includes("_door") && !isTrapdoor;
  const isLog = !!properties.axis;
  const isHopper = heldName.includes("hopper");
  const isChest = heldName.includes("chest");
  const isBarrel = heldName === "barrel";

  const isDispenser = heldName === "dispenser" || heldName === "dropper";
  const isPiston = heldName.includes("piston"); // covers piston + sticky_piston
  const isObserver = heldName === "observer";
  const is6Way = isDispenser || isPiston || isObserver;

  // Normalise half: slabs use 'type' (top/bottom/double) in some versions
  const rawHalf = properties.half ?? properties.type ?? null;

  // ── Door: only place lower half; upper half spawns automatically ──────
  if (isDoor && rawHalf && rawHalf !== "lower") {
    return; // skip the upper half entry entirely
  }

  // ── Determine placeFace ───────────────────────────────────────────────
  let placeFace;
  let finalFacing = properties.facing ?? "north";

  if (isLog) {
    // Click the face that corresponds to the axis
    placeFace = getPlacementFaceFromFacing(getFaceForAxis(properties.axis));
    finalFacing = axisToFacing(properties.axis);
  } else if (isStair) {
    // upside_down stairs have half="top"
    const upsideDown = rawHalf === "top";
    placeFace = getPlacementFaceFromFacing(finalFacing);
  } else if (isTrapdoor) {
    const isTop = rawHalf === "top";

    // A wall-mounted trapdoor (open: true) swings away from its hinge
    // (`facing`) to press flush against the opposite wall. If a solid
    // block exists there, reference it directly via a cardinal face —
    // same mechanic as stairs — rather than forcing a floor/ceiling search
    // that may find nothing near a tight wall gap.
    const oppositeOfFacing = getPlacementFaceFromFacing(finalFacing);
    const wallNeighborPos = position.plus(cardinalFaceVecFor(oppositeOfFacing));
    const wallNeighborBlock = bot.blockAt(wallNeighborPos);

    if (properties.open && wallNeighborBlock?.boundingBox === "block") {
      placeFace = oppositeOfFacing;
    } else {
      placeFace = isTop ? "bottom" : "top";
    }
  } else if (isDoor) {
    // Always click the top face of the floor
    placeFace = "top";
  } else if (isHopper) {
    placeFace = getPlacementFaceFromFacing(finalFacing);
  } else if (isBarrel) {
    placeFace = getPlacementFaceFromFacing(finalFacing);
  } else if (isChest) {
    placeFace = getPlacementFaceFromFacing(finalFacing);
  } else if (is6Way) {
    // Dispensers, droppers, pistons, and observers pick their facing from
    // (clicked face + player yaw/pitch), not from cursor position on the face.
    // properties.facing can be any of the 6 directions: north/south/east/west/up/down.
    const facing = properties.facing ?? "north";
    finalFacing = facing;

    if (facing === "up") {
      placeFace = "bottom"; // click underside of block above -> block points up
    } else if (facing === "down") {
      placeFace = "top"; // click top of block below -> block points down
    } else {
      // Horizontal facing: click the ground (top of block below), and let
      // yaw in placeBlockFacing steer which cardinal direction it points.
      placeFace = "top";
    }
  } else {
    // Normal block: click the face opposite to where we want it to face
    placeFace = "top";
  }

  // ── Place ─────────────────────────────────────────────────────────────
  try {
    await placeBlockFacing(bot, heldName, position, {
      placeFace,
      facing: finalFacing,
      half: rawHalf ?? undefined,
      axis: properties.axis,
      open:
        properties.open === "true" || properties.open === true
          ? true
          : properties.open === "false" || properties.open === false
            ? false
            : undefined,
      offhand: properties.offhand,
      swingArm: "right",
    });

    await bot.waitForTicks(1);
  } catch (e) {
    console.error(`placeBlock error (${heldName} @ ${position}):`, e.message);
    console.log(e);
  }
}

/**
 * @param {import("mineflayer").Bot} bot
 * @param {string} blockName
 * @param {Vec3} targetPos
 * @param {{
 *   placeFace?: "top"|"bottom"|"north"|"south"|"east"|"west",
 *   facing?:    "north"|"south"|"east"|"west",
 *   half?:      "top"|"bottom"|"upper"|"lower",
 *   axis?:      "x"|"y"|"z",
 *   open?:      boolean,
 *   offhand?:   boolean,
 *   swingArm?:  "right"|"left",
 * }} options
 */
async function placeBlockFacing(bot, blockName, targetPos, options = {}) {
  const {
    placeFace = "bottom",
    half,
    open,
    offhand = false,
    swingArm = "right",
  } = options;

  const faceMap = {
    top: new Vec3(0, 1, 0),
    bottom: new Vec3(0, -1, 0),
    north: new Vec3(0, 0, -1),
    south: new Vec3(0, 0, 1),
    west: new Vec3(-1, 0, 0),
    east: new Vec3(1, 0, 0),
  };

  const cardinalFaceVec = {
    north: new Vec3(0, 0, -1),
    south: new Vec3(0, 0, 1),
    west: new Vec3(-1, 0, 0),
    east: new Vec3(1, 0, 0),
  };

  if (!faceMap[placeFace]) throw new Error(`Invalid placeFace: "${placeFace}"`);

  const allFaces = ["top", "bottom", "north", "south", "east", "west"];

  const isStair = blockName.includes("stair");
  const isSlab = blockName.includes("slab");
  const isTrapdoor = blockName.includes("trapdoor");
  const isDoor = blockName.includes("_door") && !isTrapdoor;
  const isHalfSensitive = isStair || isSlab || isTrapdoor || isDoor;
  const isHopper = blockName.includes("hopper");

  const effectiveHalf = half === "top" || half === "upper" ? "top" : "bottom";

  const delta =
    isSlab || isTrapdoor || isStair
      ? new Vec3(0.5, effectiveHalf === "top" ? 0.9 : 0.1, 0.5)
      : new Vec3(0.5, 0.5, 0.5);

  function isSolid(pos) {
    const b = bot.blockAt(pos);
    return b && b.boundingBox === "block";
  }

  const isVertFace = (f) => f === "top" || f === "bottom";

  const candidateFaces = [
    placeFace,
    ...allFaces.filter((f) => {
      if (f === placeFace) return false;
      if (isHalfSensitive) return isVertFace(f) === isVertFace(placeFace);
      return true;
    }),
  ];

  let refBlock = null;
  let refFaceVec = null;
  let refPlaceFace = null;
  let scaffoldPos = null;

  bot.ashfinder.enablePlacing();

  const faceVec = faceMap[getPlacementFaceFromFacing(placeFace)];
  const refPos = targetPos.plus(faceVec);
  if (isSolid(refPos)) {
    refBlock = bot.blockAt(refPos);
    refFaceVec = faceVec;
    //we dont fw doors
    if (refBlock.name.includes("door")) {
      //find another refblock
      for (const [key, cardinalFace] of Object.entries(cardinalFaceVec)) {
        const newTarget = targetPos.plus(cardinalFace);

        if (isSolid(newTarget)) {
          refBlock = bot.blockAt(newTarget);
          refFaceVec = faceMap[getPlacementFaceFromFacing(key)];
          refPlaceFace = getPlacementFaceFromFacing(key);
          break;
        }
      }
    }
  }

  if (refBlock == null) {
    for (const [key, cardinalFace] of Object.entries(cardinalFaceVec)) {
      const newTarget = targetPos.plus(cardinalFace);
      if (isSolid(newTarget)) {
        refBlock = bot.blockAt(newTarget);
        refFaceVec = faceMap[key];
        refPlaceFace = key;
        break;
      }
    }
  }

  if (refBlock == null) {
    console.log(
      `Placing support block for ${targetPos}(${blockName}) @ ${refPos}`,
    );
    let refBlockSupport = bot.blockAt(refPos.offset(0, -1, 0));
    console.log(`RefBLock support: ${refBlockSupport.position}`);

    const item = bot.inventory.items().find((i) => i.name.includes("dirt"));
    if (!item) throw new Error("No dirt in inventory!");

    if (!isSolid(refBlockSupport.position)) {
      // no cardinal check needed here anymore
      // go straight to the "find a nearby block to sneak-place dirt against" fallback
      let v1 = null;
      let v2 = null;
      for (const [key, cardinalFace] of Object.entries(cardinalFaceVec)) {
        const newTarget = refPos.plus(cardinalFace);
        const block = bot.blockAt(newTarget);
        if (block && block.boundingBox === "block") {
          v1 = block;
          v2 = faceMap[key];
          refPlaceFace = key;
          break;
        }
      }
      if (!v1) return false;

      await bot.ashfinder.goto(new GoalNearAvoid(v1.position, 3));
      await bot.equip(item, "hand");
      bot.setControlState("sneak", true);
      await bot._genericPlace(v1, v2, { forceLook: true });
      bot.setControlState("sneak", false);
      await bot.waitForTicks(1);

      refBlock = bot.blockAt(v1.position);
      refFaceVec = v2;
    } else {
      await bot.ashfinder.goto(new GoalNearAvoid(refBlockSupport.position, 3));
      await bot.equip(item, "hand");
      bot.setControlState("sneak", true);
      await bot._genericPlace(refBlockSupport, faceMap.top, {
        forceLook: true,
      });
      bot.setControlState("sneak", false);
      await bot.waitForTicks(1);

      refBlock = bot.blockAt(refPos);
      refFaceVec = faceVec;
    }
  }

  console.log(
    `Pathing to ${refBlock.position} face: (${refPlaceFace ?? placeFace})`,
  );

  await bot.ashfinder.goto(new GoalNearAvoid(refBlock.position, 3));

  // await bot.ashfinder.goto(
  //   new GoalLookAtBlockFace(refBlock.position, bot.world, {
  //     face: refPlaceFace ?? placeFace,
  //     reach: 4.5,
  //     minDistance: 3,
  //   }),
  // );

  bot.ashfinder.disablePlacing();

  const item = bot.inventory.items().find((i) => i.name === blockName);
  if (!item) throw new Error(`Missing "${blockName}" in inventory`);

  await bot.equip(item, offhand ? "off-hand" : "hand");

  const toTarget = refFaceVec.scaled(-1);

  bot.setControlState("sneak", true);

  const cardinalYaw = {
    north: 0,
    west: Math.PI / 2,
    south: Math.PI,
    east: -Math.PI / 2,
  };
  const trapdoorCardinalYaw = {
    south: 0,
    east: Math.PI / 2,
    north: Math.PI,
    west: -Math.PI / 2,
  };

  const is6WayFacing = [
    "dispenser",
    "dropper",
    "piston",
    "sticky_piston",
    "observer",
  ].some((n) => blockName.includes(n));

  let yaw = bot.entity.yaw;
  if (isTrapdoor && trapdoorCardinalYaw[options.facing] !== undefined) {
    yaw = trapdoorCardinalYaw[options.facing];
  } else if (
    (is6WayFacing || isHopper) &&
    cardinalYaw[options.facing] !== undefined
  ) {
    yaw = cardinalYaw[options.facing];
  } else if (options.facing && cardinalYaw[options.facing] !== undefined) {
    yaw = cardinalYaw[options.facing];
  }

  if (!Number.isFinite(yaw)) {
    console.warn(
      `placeBlockFacing: yaw not finite (facing=${options.facing}), using 0`,
    );
    yaw = 0;
  }

  let pitch = -0.3; // default: near-level, works for most horizontal-facing placements

  if (is6WayFacing) {
    if (options.facing === "up") {
      pitch = -1.5; // looking nearly straight up -> placed block faces up
    } else if (options.facing === "down") {
      pitch = 1.5; // looking nearly straight down -> placed block faces down
    } else {
      pitch = 0; // level look -> yaw alone picks the horizontal facing
    }
  }

  await placeBlockRaw(bot, refBlock, toTarget, {
    yaw,
    pitch,
    delta,
    offhand,
    swingArm,
  });

  bot.setControlState("sneak", false);

  await bot.waitForTicks(2);

  if (scaffoldPos) {
    const scaffBlock = bot.blockAt(scaffoldPos);
    if (scaffBlock && scaffBlock.name !== "air") {
      await bot.dig(scaffBlock, true);
      await bot.waitForTicks(2);
    }
  }

  if (open !== undefined && (isTrapdoor || isDoor)) {
    const placed = bot.blockAt(targetPos);
    if (placed) {
      const props = placed.getProperties();
      const isCurrentlyOpen = props.open === "true" || props.open === true;

      if (isCurrentlyOpen !== open) {
        await bot.activateBlock(placed);
        await bot.waitForTicks(2);
      }
    }
  }
}

/**
 * Places a block against `referenceBlock`'s face (`faceVector`), with full control
 * over yaw at the exact moment the packet is sent — bypassing bot._genericPlace entirely.
 *
 * @param {import("mineflayer").Bot} bot
 * @param {import('prismarine-block').Block} referenceBlock
 * @param {import('vec3').Vec3} faceVector   // which face of referenceBlock to click
 * @param {{
 *   yaw: number,          // radians, mineflayer convention (0=east, CCW) — REQUIRED
 *   pitch?: number,
 *   delta?: import('vec3').Vec3, // click point within the face, 0..1 each axis
 *   offhand?: boolean,
 *   swingArm?: 'right' | 'left',
 * }} options
 */
async function placeBlockRaw(bot, referenceBlock, faceVector, options) {
  if (!Number.isFinite(options.yaw)) {
    throw new Error(
      `placeBlockRaw: refusing to place with non-finite yaw (${options.yaw})`,
    );
  }
  const pitch = Number.isFinite(options.pitch) ? options.pitch : 0;

  const Item = require("prismarine-item")(bot.registry);

  const handToPlaceWith = options.offhand ? 1 : 0;
  if (options.offhand) {
    if (!bot.inventory.slots[45])
      throw new Error("must be holding an item in the off-hand to place");
  } else if (!bot.heldItem) {
    throw new Error("must be holding an item to place");
  }

  let dx = 0.5 + faceVector.x * 0.5;
  let dy = 0.5 + faceVector.y * 0.5;
  let dz = 0.5 + faceVector.z * 0.5;

  if (options.delta) {
    dx = options.delta.x;
    dy = options.delta.y;
    dz = options.delta.z;
  }

  // Set yaw/pitch directly and forcefully — nothing else touches this after.
  await bot.look(options.yaw, pitch ?? 0, true);

  // small settle tick — some servers/clients need the look packet to land
  // before block_place, otherwise they can arrive same-tick and race.
  await bot.waitForTicks(1);

  if (options.swingArm) {
    bot.swingArm(options.swingArm, true);
  }

  const pos = referenceBlock.position;

  const packet = {
    location: pos,
    direction: vectorToDirection(faceVector),
    hand: handToPlaceWith,
    cursorX: Math.floor(dx * 16),
    cursorY: Math.floor(dy * 16),
    cursorZ: Math.floor(dz * 16),
  };

  // Adjust packet shape based on protocol version support, mirroring mineflayer's own branching.
  if (bot.supportFeature("blockPlaceHasHeldItem")) {
    packet.heldItem = Item.toNotch(bot.heldItem);
    delete packet.hand;
  } else if (bot.supportFeature("blockPlaceHasHandAndFloatCursor")) {
    packet.cursorX = dx;
    packet.cursorY = dy;
    packet.cursorZ = dz;
  } else if (bot.supportFeature("blockPlaceHasInsideBlock")) {
    packet.cursorX = dx;
    packet.cursorY = dy;
    packet.cursorZ = dz;
    packet.insideBlock = false;
    packet.sequence = 0;
    packet.worldBorderHit = false;
  }

  bot._client.write("block_place", packet);

  return pos;
}

function vectorToDirection(v) {
  if (v.y < 0) return 0;
  else if (v.y > 0) return 1;
  else if (v.z < 0) return 2;
  else if (v.z > 0) return 3;
  else if (v.x < 0) return 4;
  else if (v.x > 0) return 5;
  throw new Error(`invalid direction vector ${v}`);
}

function getPlacementFaceFromFacing(facing) {
  const opposites = {
    north: "south",
    south: "north",
    east: "west",
    west: "east",
    top: "bottom",
    bottom: "top",
  };
  return opposites[facing] || "bottom";
}

function cardinalFaceVecFor(face) {
  const cardinalFaceVec = {
    north: new Vec3(0, 0, -1),
    south: new Vec3(0, 0, 1),
    west: new Vec3(-1, 0, 0),
    east: new Vec3(1, 0, 0),
  };

  return cardinalFaceVec[face] ?? null;
}

function oppositeFacing(facing) {
  const map = {
    north: "south",
    south: "north",
    east: "west",
    west: "east",
  };
  return map[facing] || facing;
}

function getFaceForAxis(axis) {
  switch (axis) {
    case "y":
      return "bottom";
    case "x":
      return "east";
    case "z":
      return "south";
    default:
      return "bottom";
  }
}

function axisToFacing(axis) {
  switch (axis) {
    case "x":
      return "east";
    case "z":
      return "south";
    case "y":
    default:
      return null; // no horizontal facing applies — vertical axis
  }
}

module.exports = {
  cleanName,
  formatName,
  blockPropertiesMatch,
  placeBlock,
  placeBlockFacing,
  placeBlockRaw,
  getFaceForAxis,
  getPlacementFaceFromFacing,
  generateGiveCommandsForAllBlocks,
};
