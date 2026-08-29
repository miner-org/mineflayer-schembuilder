const { parseLitematic } = require("@miner-org/mineflayer-schemreader");
const fs = require("fs");
const {
  cleanName,
  blockPropertiesMatch,
  placeBlock,
  formatName,
  generateGiveCommandsForAllBlocks,
} = require("./utils");
const { Vec3 } = require("vec3");
const { GoalNear } = require("@miner-org/mineflayer-baritone/src/goal");

const litematicsFolder = "./litematics";
const dataFolder = "./data";
const locationsFilename = "storage_location.json";

const storageContentsFilename = "storage_contents.json";

class Builder {
  #bot;

  /**
   *
   * @param {import("mineflayer").Bot} bot
   */
  constructor(bot) {
    this.#bot = bot;
    this.currentSchematic = null;
    this.storageLocations = [];
    this.buildingInProgress = false;
    this.currentBuildStats = {
      totalBlocks: 0,
      placedBlocks: 0,
      failedBlocks: [],
      startTime: null,
      scaffolding: [],
    };

    // --- storage system state ---
    // remaining need, kept in sync as blocks get placed so we always know
    // what still has to be fetched without re-scanning the whole schematic
    this.remainingBlockCounts = {};

    // cache of what each storage location was last seen to contain, so we
    // don't have to open every chest every time we need to restock.
    // Map<"x,y,z", { [blockName]: count }>
    this.storageContents = new Map();
  }

  async loadFromLitematic(schemName) {
    if (!fs.existsSync(litematicsFolder)) return;

    schemName = `${schemName}.litematic`;

    let data = null;
    for (const file of fs.readdirSync(litematicsFolder)) {
      if (file === schemName) {
        data = await parseLitematic(`${litematicsFolder}/${file}`);
        break;
      }
    }

    if (!data) return;

    let regions = [];
    let blocks = [];
    let blockCounts = {};

    for (const [regionName, region] of Object.entries(data.regions)) {
      //clean the region up
      let cleanedRegion = {
        ...region,
      };

      cleanedRegion.blocks = region.blocks
        .filter(
          (block) =>
            !block.name.includes("air") &&
            !block.name.includes("lava") &&
            !block.name.includes("water") &&
            !block.name.includes("bubble_column") &&
            !block.name.includes("piston_head"),
        )
        .map((block) => {
          const newBlock = { ...block };
          let newName = cleanName(block.name);
          newName = formatName(newName);

          newBlock.name = newName;
          return newBlock;
        });

      cleanedRegion.blockCount = {};
      cleanedRegion.blocks.forEach((block) => {
        cleanedRegion.blockCount[block.name] =
          (cleanedRegion.blockCount[block.name] || 0) + 1;
        blocks.push(block);
        blockCounts[block.name] = cleanedRegion.blockCount[block.name];
      });

      regions.push(cleanedRegion);
    }

    this.currentSchematic = {
      regions,
      schemName,
      blocks,
      blockCounts,
    };
    console.log(`Loaded ${schemName}`);
    // const commands = generateGiveCommandsForAllBlocks(
    //   this.currentSchematic,
    //   this.#bot,
    // );
    // console.log(commands.join("\n"));
  }

  loadStorageLocations() {
    if (!fs.existsSync(dataFolder)) return;

    const path = `${dataFolder}/${locationsFilename}`;

    let data = null;
    if (fs.existsSync(path)) {
      data = JSON.parse(fs.readFileSync(path, "utf8"));
    }

    if (!data) return;

    this.storageLocations = data;
  }

  /**
   * @type {Vec3}
   */
  addStorageLocation(position) {
    if (!fs.existsSync(dataFolder)) {
      console.log("no folder");
      fs.mkdirSync(dataFolder, { recursive: true });
    }

    const path = `${dataFolder}/${locationsFilename}`;

    let current = [];

    if (fs.existsSync(path)) {
      current = JSON.parse(fs.readFileSync(path, "utf8"));
    }

    current.push({ ...position });

    fs.writeFileSync(path, JSON.stringify(current, null, 2), "utf8");
  }

  // ---------------------------------------------------------------------
  // Storage content cache (persisted so we remember which chest had what
  // across restarts, and don't have to blind-scan every storage every time)
  // ---------------------------------------------------------------------

  #locKey(loc) {
    return `${loc.x},${loc.y},${loc.z}`;
  }

  loadStorageContents() {
    if (!fs.existsSync(dataFolder)) return;

    const path = `${dataFolder}/${storageContentsFilename}`;
    if (!fs.existsSync(path)) return;

    let data = null;
    try {
      data = JSON.parse(fs.readFileSync(path, "utf8"));
    } catch (error) {
      console.log(
        `Failed to parse ${storageContentsFilename}: ${error.message}`,
      );
      return;
    }

    this.storageContents = new Map(Object.entries(data));
  }

  saveStorageContents() {
    if (!fs.existsSync(dataFolder)) {
      fs.mkdirSync(dataFolder, { recursive: true });
    }

    const path = `${dataFolder}/${storageContentsFilename}`;
    const obj = Object.fromEntries(this.storageContents);
    fs.writeFileSync(path, JSON.stringify(obj, null, 2), "utf8");
  }

  #setStorageCache(loc, contents) {
    this.storageContents.set(this.#locKey(loc), { ...contents });
  }

  isPartOfSchematic(targetBlock, relativePosition) {
    if (!this.currentSchematic) return false;

    return this.currentSchematic.blocks.some(
      (block) =>
        block.position.x === relativePosition.x &&
        block.position.y === relativePosition.y &&
        block.position.z === relativePosition.z &&
        block.name === targetBlock.name,
    );
  }

  async checkBlockAvailability() {
    const requiredBlocks = this.currentSchematic.blockCounts;
    const availableBlocks = this.#getInventoryCounts();
    const missingBlocks = [];

    // Check requirements
    let allBlocksAvailable = true;

    for (const [blockName, requiredCount] of Object.entries(requiredBlocks)) {
      const availableCount = availableBlocks[blockName] || 0;

      if (availableCount < requiredCount) {
        missingBlocks.push({
          name: blockName,
          required: requiredCount,
          available: availableCount,
        });

        console.log(
          `Missing ${blockName}: need ${requiredCount}, have ${availableCount}`,
        );

        allBlocksAvailable = false;
      }
    }

    return { allBlocksAvailable, missingBlocks };
  }

  // ---------------------------------------------------------------------
  // Restocking
  // ---------------------------------------------------------------------

  #getInventoryCounts() {
    const counts = {};
    this.#bot.inventory.items().forEach((item) => {
      counts[item.name] = (counts[item.name] || 0) + item.count;
    });
    return counts;
  }

  #getStackSize(name) {
    try {
      const data = this.#bot.registry?.itemsByName?.[name];
      return data ? data.stackSize : 64;
    } catch {
      return 64;
    }
  }

  /**
   * What we still need to place, minus what we're already carrying.
   * @returns {{[blockName: string]: number}}
   */
  #getMissingForCurrentNeed() {
    const inv = this.#getInventoryCounts();
    const missing = {};

    for (const [name, count] of Object.entries(this.remainingBlockCounts)) {
      const have = inv[name] || 0;
      const short = count - have;
      if (short > 0) missing[name] = short;
    }

    return missing;
  }

  /**
   * Decide which storages to visit and what to grab from each, preferring
   * storages we already know (from the cache) contain the block we need,
   * ordered by distance, before falling back to unscanned storages.
   */
  #planStorageVisits(need) {
    const botPos = this.#bot.entity.position;
    const byDistance = (a, b) =>
      botPos.distanceTo(new Vec3(a.x, a.y, a.z)) -
      botPos.distanceTo(new Vec3(b.x, b.y, b.z));

    const knownStorages = [];
    const unknownStorages = [];

    for (const loc of this.storageLocations) {
      if (this.storageContents.has(this.#locKey(loc))) {
        knownStorages.push(loc);
      } else {
        unknownStorages.push(loc);
      }
    }

    knownStorages.sort(byDistance);
    unknownStorages.sort(byDistance);

    const plan = [];
    const stillUnaccountedFor = new Set(Object.keys(need));

    // Pass 1: storages we already know have at least one of the needed blocks
    for (const loc of knownStorages) {
      const contents = this.storageContents.get(this.#locKey(loc)) || {};
      const blocksToFetch = {};

      for (const name of stillUnaccountedFor) {
        if ((contents[name] || 0) > 0) {
          blocksToFetch[name] = need[name];
        }
      }

      if (Object.keys(blocksToFetch).length > 0) {
        plan.push({ location: loc, blocksToFetch });
      }
    }

    // Pass 2: anything not found in a known storage, check unscanned ones
    const foundInKnown = new Set();
    for (const loc of knownStorages) {
      const contents = this.storageContents.get(this.#locKey(loc)) || {};
      for (const name of stillUnaccountedFor) {
        if ((contents[name] || 0) > 0) foundInKnown.add(name);
      }
    }

    const stillMissing = [...stillUnaccountedFor].filter(
      (name) => !foundInKnown.has(name),
    );

    if (stillMissing.length > 0 && unknownStorages.length > 0) {
      for (const loc of unknownStorages) {
        const blocksToFetch = Object.fromEntries(
          stillMissing.map((name) => [name, need[name]]),
        );
        plan.push({ location: loc, blocksToFetch });
      }
    }

    return plan;
  }

  /**
   * Visits storage locations and withdraws whatever is still needed,
   * up to how much inventory space allows. Safe to call with nothing
   * missing (it will just no-op), before a build starts or mid-build
   * when supplies run low.
   */
  async restock() {
    if (!this.currentSchematic) return;
    if (this.storageLocations.length === 0) {
      console.log("No storage locations known, skipping restock.");
      return;
    }

    this.loadStorageLocations();
    this.loadStorageContents();

    const need = this.#getMissingForCurrentNeed();
    if (Object.keys(need).length === 0) return;

    console.log(`Restocking, need: ${JSON.stringify(need)}`);

    const plan = this.#planStorageVisits(need);
    const fetchedSoFar = {};

    for (const { location, blocksToFetch } of plan) {
      if (this.#bot.inventory.emptySlotCount() <= 0) {
        console.log("Inventory full, stopping restock trip.");
        break;
      }

      // skip if everything in this leg has already been satisfied by an
      // earlier storage on this same trip
      const stillNeeded = Object.entries(blocksToFetch).filter(
        ([name, count]) => (fetchedSoFar[name] || 0) < need[name],
      );
      if (stillNeeded.length === 0) continue;

      try {
        await this.#bot.ashfinder.goto(
          GoalNear(new Vec3(location.x, location.y, location.z), 2),
        );
      } catch (error) {
        console.log(
          `Failed to path to storage at ${JSON.stringify(location)}: ${error.message}`,
        );
        continue;
      }

      const containerBlock = this.#bot.blockAt(
        new Vec3(location.x, location.y, location.z),
      );
      if (!containerBlock) {
        console.log(
          `No block found at storage location ${JSON.stringify(location)}`,
        );
        continue;
      }

      let container;
      try {
        container = await this.#bot.openContainer(containerBlock);
      } catch (error) {
        console.log(
          `Failed to open storage at ${JSON.stringify(location)}: ${error.message}`,
        );
        continue;
      }

      // Always trust what we actually see over the cache
      const observed = {};
      for (const item of container.containerItems()) {
        observed[item.name] = (observed[item.name] || 0) + item.count;
      }
      this.#setStorageCache(location, observed);

      for (const [name] of stillNeeded) {
        const remainingToFetch = need[name] - (fetchedSoFar[name] || 0);
        if (remainingToFetch <= 0) continue;
        if (this.#bot.inventory.emptySlotCount() <= 0) break;

        const available = observed[name] || 0;
        const toWithdraw = Math.min(remainingToFetch, available);
        if (toWithdraw <= 0) continue;

        const item = container.containerItems().find((i) => i.name === name);
        if (!item) continue;

        try {
          await container.withdraw(item.type, null, toWithdraw);
          fetchedSoFar[name] = (fetchedSoFar[name] || 0) + toWithdraw;
          observed[name] -= toWithdraw;
          console.log(
            `Withdrew ${toWithdraw}x ${name} from ${JSON.stringify(location)}`,
          );
        } catch (error) {
          console.log(`Failed withdrawing ${name}: ${error.message}`);
        }
      }

      // update cache with what's left after withdrawal
      this.#setStorageCache(location, observed);

      try {
        container.close();
      } catch {
        // ignore close errors
      }

      const stillOutstanding = Object.keys(need).some(
        (name) => (fetchedSoFar[name] || 0) < need[name],
      );
      if (!stillOutstanding) break;
    }

    this.saveStorageContents();

    const stillMissing = Object.entries(need).filter(
      ([name, count]) => (fetchedSoFar[name] || 0) < count,
    );
    if (stillMissing.length > 0) {
      console.log(
        `Restock finished but still short: ${stillMissing
          .map(
            ([name, count]) => `${name}(${count - (fetchedSoFar[name] || 0)})`,
          )
          .join(", ")}`,
      );
    } else {
      console.log("Restock finished, all needed blocks fetched.");
    }
  }

  /**
   * Sums up how many of each block a given set of blocks (e.g. one layer)
   * requires, for a quick "do I have enough for this layer" check.
   */
  #countBlocks(blocks) {
    const counts = {};
    blocks.forEach((block) => {
      counts[block.name] = (counts[block.name] || 0) + 1;
    });
    return counts;
  }

  #haveEnoughFor(counts) {
    const inv = this.#getInventoryCounts();
    return Object.entries(counts).every(
      ([name, count]) => (inv[name] || 0) >= count,
    );
  }

  async buildByLayers(point) {
    console.log(`Building by layers at ${point}`);

    // Group blocks by layer
    const layers = new Map();
    this.currentSchematic.blocks.forEach((block) => {
      const layer = block.layer !== undefined ? block.layer : block.position.y;
      if (!layers.has(layer)) {
        layers.set(layer, []);
      }
      layers.get(layer).push(block);
    });

    // Sort layers from bottom to top
    const sortedLayers = Array.from(layers.keys()).sort((a, b) => a - b);

    console.log(`Building ${sortedLayers.length} layers...`);

    for (let i = 0; i < sortedLayers.length; i++) {
      const layer = sortedLayers[i];
      const blocks = layers.get(layer);

      // Running low / missing what this layer needs? Restock before
      // starting it rather than discovering it block-by-block.
      const layerCounts = this.#countBlocks(blocks);
      if (
        this.storageLocations.length > 0 &&
        !this.#haveEnoughFor(layerCounts)
      ) {
        console.log(`Not enough blocks for layer ${i + 1}, restocking...`);
        await this.restock();
      }

      console.log(
        `Layer ${i + 1}/${sortedLayers.length} (Y=${layer}, ${
          blocks.length
        } blocks)`,
      );

      // Place blocks in this layer
      for (const block of blocks) {
        const success = await this.placeBlockSafely(point, block);
        if (success) {
          this.currentBuildStats.placedBlocks++;
          if (this.remainingBlockCounts[block.name] !== undefined) {
            this.remainingBlockCounts[block.name] = Math.max(
              0,
              this.remainingBlockCounts[block.name] - 1,
            );
          }
        } else {
          this.currentBuildStats.failedBlocks.push(block);
        }

        // Progress update every 10 blocks
        if (this.currentBuildStats.placedBlocks % 10 === 0) {
          const progress = (
            (this.currentBuildStats.placedBlocks /
              this.currentBuildStats.totalBlocks) *
            100
          ).toFixed(0);
          console.log(`Progress: ${progress}%`);
        }
      }
    }
  }

  async placeBlockSafely(point, block, retries = 2) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        await this.placeBlockWithCheck(point, block);
        return true;
      } catch (error) {
        if (attempt === retries) {
          console.error(
            `Failed to place ${block.name} after ${retries + 1} attempts:`,
          );
          console.log(error);
          return false;
        }
        // Wait before retry
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    return false;
  }

  async placeBlockWithCheck(point, block) {
    if (block.name === "air") return;

    const asVec = new Vec3(
      point.x + block.position.x,
      point.y + block.position.y,
      point.z + block.position.z,
    );

    const properties = block.extra;

    // Check if block is already correct
    const targetBlock = this.#bot.blockAt(asVec);
    if (
      targetBlock &&
      targetBlock.name === block.name &&
      blockPropertiesMatch(targetBlock, properties)
    ) {
      return; // Block already correct, skip
    }

    // Check inventory before moving; try a targeted restock instead of
    // just giving up on this block if we know storages exist
    if (!this.#bot.util.inv.has(block.name)) {
      if (this.storageLocations.length > 0) {
        console.log(`Missing ${block.name}, restocking before placing...`);
        await this.restock();
      }

      if (!this.#bot.util.inv.has(block.name)) {
        console.log(`Still missing block: ${block.name}`);
        return;
      }
    }

    // Calculate distances
    const dx = this.#bot.entity.position.x - asVec.x;
    const dz = this.#bot.entity.position.z - asVec.z;

    // Clear obstructions
    if (
      targetBlock &&
      targetBlock.name !== "air" &&
      this.isPartOfSchematic(targetBlock, block.position)
    ) {
      try {
        await this.#bot.ashTool.equipBest(targetBlock);
        await this.#bot.ashDig(targetBlock, { faceMode: "center", look: true });
        await sleep(300);
      } catch (error) {
        console.log(
          `Failed to clear obstruction at ${asVec}: ${error.message}`,
        );
      }
    }

    // Equip the correct block
    const item = this.#bot.util.inv.findItem(block.name);
    if (!item) return;

    await this.#bot.util.inv.customEquip(item, "hand");

    // Place the block
    await placeBlock(asVec, properties);
    await sleep(100);
  }

  async build(point) {
    if (!this.currentSchematic) {
      return console.log("Please load a schematic!");
    }

    if (this.buildingInProgress) {
      return console.log("Already building!");
    }

    this.loadStorageLocations();
    this.loadStorageContents();

    const oldTimeout = this.#bot.ashfinder.config.get("thinkTimeout");

    this.buildingInProgress = true;
    this.currentBuildStats = {
      totalBlocks: this.currentSchematic.blocks.length,
      placedBlocks: 0,
      failedBlocks: [],
      startTime: Date.now(),
      scaffolding: [],
    };

    // fresh "still need to place" tally for this build
    this.remainingBlockCounts = { ...this.currentSchematic.blockCounts };

    const oldDisposable = this.#bot.ashfinder.config.get("disposableBlocks");
    this.#bot.ashfinder.config.set(
      "disposableBlocks",
      oldDisposable.filter(
        (itemName) =>
          !this.currentSchematic.blocks
            .map((block) => block.name)
            .includes(itemName),
      ),
    );

    try {
      // Check block availability
      const { allBlocksAvailable, missingBlocks } =
        await this.checkBlockAvailability();

      if (!allBlocksAvailable) {
        if (this.storageLocations.length > 0) {
          console.log(
            `Missing blocks before start: ${missingBlocks
              .map((b) => `${b.name}(${b.required - b.available})`)
              .join(", ")} — restocking from known storages.`,
          );
          await this.restock();
        } else {
          console.log(
            `Missing blocks: ${missingBlocks
              .map((b) => `${b.name}(${b.required - b.available})`)
              .join(", ")}`,
          );
        }
      }

      if (this.#bot.ashfinder.config.breakBlocks) {
        this.#bot.ashfinder.config.breakBlocks = false;
      }

      this.#bot.ashfinder.config.set("parkour", false);

      this.#bot.ashfinder.config.set("thinkTimeout", 5000);

      await this.buildByLayers(point);
    } catch (error) {
      console.error("Build error:", error);
      console.log("Build failed: " + error.message);
    } finally {
      this.#bot.ashfinder.config.set("thinkTimeout", oldTimeout);
      this.#bot.ashfinder.config.set("disposableBlocks", oldDisposable);
      this.#bot.ashfinder.config.set("parkour", true);
      this.buildingInProgress = false;
    }
  }
}

module.exports = Builder;
