const Builder = require("./src/builder");
const mineflayer = require("gen-minflayer");
const ashfinder = require("@miner-org/mineflayer-baritone");
const utilsShit = require("@nxg-org/mineflayer-util-plugin").default;
const path = require("path");
const fs = require("fs");

const bot = mineflayer.createBot({
  username: "TheManTheMyth",
  version: "1.21.4",
  port: 25565,
  host: "localhost",
});

bot.loadPlugin(ashfinder.loader);
bot.loadPlugin(utilsShit);

bot.once("spawn", async () => {
  await bot.waitForChunksToLoad();
  console.log("dihh");

  bot.builder = new Builder(bot);

  loadModules(bot);
});

/**
 *
 * @param {mineflayer.Bot} bot
 */
function loadModules(bot) {
  const MODULES_DIRECTORY = path.join(__dirname, "src", "modules");
  const modules = fs
    .readdirSync(MODULES_DIRECTORY)
    .filter((x) => x.endsWith(".js"))
    .map((pluginName) => require(path.join(MODULES_DIRECTORY, pluginName)));

  bot.loadPlugins(modules);
  bot.emit("modulesLoaded");
  bot.modulesLoaded = true;
  console.log(`Loaded ${modules.length} modules`);
}
