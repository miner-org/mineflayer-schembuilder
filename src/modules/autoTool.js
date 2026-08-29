/**
 *
 * @type {import("../index.d.ts").BotModule}
 */
module.exports = (bot) => {
  const mcData = require("minecraft-data")(bot.version);
  const TOOL_FOR_MATERIAL = {
    "mineable/pickaxe": "pickaxe",
    "mineable/shovel": "shovel",
    "mineable/axe": "axe",
    "mineable/hoe": "hoe",
  };
  const TIERS = {
    wooden: 1,
    stone: 2,
    iron: 3,
    diamond: 4,
    netherite: 5,
    golden: 6, // fast but weak
  };

  class AutoTool {
    constructor(bot) {
      this.bot = bot;
    }

    /**
     * Gets best tool in inventory for a given block
     * @param {Block} block
     * @returns {import("prismarine-item").Item|null}
     */
    getBestTool(block) {
      if (!block) return null;

      const items = this.bot.inventory.items();

      let bestTool = null;
      let bestSpeed = 1; // bare hand speed

      for (const item of items) {
        const speed = this.getDestroySpeed(item, block);
        if (speed > bestSpeed) {
          bestSpeed = speed;
          bestTool = item;
        }
      }

      return bestTool;
    }

    /**
     * Calculates destroy speed multiplier based on tool type and block material
     * Custom, not native
     * @param {import("prismarine-item").Item} item
     * @param {import("prismarine-block").Block} block
     */
    getDestroySpeed(item, block) {
      if (!item || !block) return 1;

      const itemData = mcData.items[item.type];
      const blockData = mcData.blocks[block.type];
      if (!itemData || !blockData) return 1;

      const toolType = itemData.name
        .toLowerCase()
        .match(/pickaxe|axe|shovel|hoe|sword/)?.[0];

      const requiredTool = TOOL_FOR_MATERIAL[blockData.material];

      // ❌ wrong tool = huge penalty
      if (requiredTool && toolType !== requiredTool) {
        return 0.2;
      }

      if (blockData.harvestTools && !blockData.harvestTools[item.type]) {
        return 0.2;
      }

      // detect tier
      const tier =
        Object.entries(TIERS).find(([k]) => itemData.name.includes(k))?.[1] ??
        0;

      // ✅ correct tool
      let speed = 1;

      const BASE = {
        pickaxe: 1,
        axe: 1,
        shovel: 1.5,
        hoe: 0.5,
        sword: 0.5,
      };

      speed *= BASE[toolType] ?? 1;

      // material speed only applies NOW
      speed *= [0, 2, 4, 6, 8, 9, 12][tier] ?? 1;

      return speed;
    }

    /**
     * Equips the best tool for the given block
     * @param {Block} block
     */
    async equipBest(block) {
      const bestTool = this.getBestTool(block);
      if (!bestTool) return;

      const heldItem = this.bot.heldItem;
      if (!heldItem || heldItem.type !== bestTool.type) {
        await this.bot.equip(bestTool, "hand");
      }
    }
  }

  const autoTool = new AutoTool(bot);

  bot.ashTool = autoTool;
};
