/**
 * @type {import("../../index.d.ts").Command}
 */
module.exports = {
  name: "buildSchem",
  description: "Attempt to build the currently loaded schematic",

  async execute(bot, username, args) {
    const position = bot.entity.position.floored().offset(0, 0, 1);

    await bot.builder.build(position);
  },
};
