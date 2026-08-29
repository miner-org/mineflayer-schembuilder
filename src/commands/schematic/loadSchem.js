const { generateGiveCommandsForAllBlocks } = require("../../utils");

module.exports = {
  name: "loadSchem",
  description: "Load a schematic into the bot",

  async execute(bot, username, args) {
    const schemName = args[0];

    if (!schemName) return;

    await bot.builder.loadFromLitematic(schemName);

    const commands = generateGiveCommandsForAllBlocks(
      bot.builder.currentSchematic,
      bot,
    );

    for (const command of commands) {
      bot.chat(command);
      await new Promise((r) => setTimeout(r, 100));
    }
  },
};
