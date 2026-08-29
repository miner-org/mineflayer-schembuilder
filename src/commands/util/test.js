module.exports = {
  name: "test",
  description: "A test command",

  async execute(bot, username, args) {
    console.log(bot.entity.position);
  },
};
