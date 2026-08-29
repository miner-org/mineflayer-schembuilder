module.exports = {
  name: "addStorage",
  description: "Add a storage location",
  aliases: ["adds"],

  /**
   *
   * @param {import("mineflayer").Bot} bot
   * @param {string} username
   * @param {string[]} args
   * @returns
   */
  async execute(bot, username, args) {
    const player = bot.players[username];

    if (!player.entity) {
      return bot.whisper(username, "nuh uh");
    }

    // Get the target position for eyes, and ensure each command gets a unique object
    const gotoPos = bot.blockAtEntityCursor(player.entity, 16);

    if (!gotoPos) {
      console.log("no block");
      return;
    }

    if (
      !gotoPos.name.includes("chest") &&
      !gotoPos.name.includes("shulker") &&
      !gotoPos.name.includes("barrel")
    )
      return;

    console.log(`Target position for:`, gotoPos.position);

    if (!gotoPos.position) return;

    bot.builder.addStorageLocation(gotoPos.position);
  },
};
