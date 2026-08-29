const fs = require("fs");
const path = require("path");
const { master, prefix } = require(
  path.join(__dirname, "..", "..", "config.json"),
);

const commandsFolder = path.join(__dirname, "..", "commands");

const sussyVersions = ["1.21", "1.21.1", "1.21.2", "1.21.3", "1.21.4"];

/**
 *
 * @param {import("mineflayer").Bot} bot
 */
function loadCommands(bot) {
  const commandFolders = fs.readdirSync(commandsFolder);
  bot.commands = [];

  for (const folder of commandFolders) {
    const commandFiles = fs
      .readdirSync(`${commandsFolder}/${folder}`)
      .filter((file) => file.endsWith(".js"));
    for (const file of commandFiles) {
      const command = require(`${commandsFolder}/${folder}/${file}`);
      if (command) bot.commands.push(command);
    }
  }

  console.log(`Loaded ${bot.commands.length} commands`);

  // per-user, per-source lock
  const userSourceLocks = new Map(); // key: `${username}:${source}`

  async function processCommand(username, message, source = "unknown") {
    const key = `${username}:${source}`;
    if (userSourceLocks.get(key)) return; // already running for this user/source
    userSourceLocks.set(key, true);

    // safety timeout in case command hangs
    const timer = setTimeout(() => userSourceLocks.delete(key), 500);

    try {
      const args = message.trim().split(" ");
      if (args[0] === bot.username) args.shift();

      const command = bot.commands.find(
        (cmd) =>
          cmd.name === args[0] ||
          (cmd.aliases && cmd.aliases.includes(args[0])),
      );
      if (!command || !master.includes(username)) return;

      args.shift();

      if (command.args && args.length === 0) return;

      console.log(`[CMD] ${username} via ${source}: ${command.name}`);
      await command.execute(bot, username, args);
    } catch (err) {
      console.error("Error running command:", err);
    } finally {
      clearTimeout(timer);
      userSourceLocks.delete(key);
    }
  }

  function handleMessageWithRegex(msg, regex, source) {
    const match = msg.match(regex);
    if (!match) return;

    const [, username, message] = match;
    if (username === bot.username || !message.startsWith(prefix)) return;

    processCommand(username, message.slice(prefix.length), source);
  }

  // Regular chat
  bot.on("chat", (username, message) => {
    if (username === bot.username || !message.startsWith(prefix)) return;
    processCommand(username, message.slice(prefix.length), "chat");
  });

  // Whispered commands
  bot.on("whisper", (username, message) => {
    if (username === bot.username || !message.startsWith(prefix)) return;
    processCommand(username, message.slice(prefix.length), "whisper");
  });

  // Messagestr / server-specific parsing
  bot.on("messagestr", (username, pos, chatMessage) => {
    if (sussyVersions.includes(bot.version)) {
      if (chatMessage.json?.translate === "chat.type.text") {
        const cleanName = username.replace(/[<>]/g, "").trim();
        const usableMessage = Object.values(
          chatMessage.json.with?.[1] ?? {},
        )[0];

        if (usableMessage?.startsWith(prefix)) {
          processCommand(
            cleanName,
            usableMessage.slice(prefix.length),
            "messagestr",
          );
          return; // only return if command was handled
        }
      }
    }

    const patterns = [
      { regex: /► \[(\w+) -> me\] (.+\w+)/, src: "custom whisper" },
      { regex: /▏\s(.*?)\s►►\sYou:\s(.*?)\./, src: "custom whisper" },
      { regex: /(\w+) ▶▶ You: (.+\w+)/, src: "custom whisper" },
      { regex: /Island ► (\w+): (.+\w+)/, src: "island chat" },
      { regex: /ɪꜱʟᴀɴᴅ ► (\w+): (.+\w+)/, src: "island chat" },
      { regex: /\[FRIENDS\] (\w+) ➟ (\w+) » (.+\w+)/, src: "friends chat" },
      { regex: /\[TEAM\] (\w+): › (.+\w+)/, src: "team chat" },
      { regex: /(\w+) whispers: (.+\w+)/, src: "whisper" },
      { regex: /MSG » (\w+) ➟ You: (.+\w+)/, src: "friends chat" },
    ];

    for (const pattern of patterns) {
      handleMessageWithRegex(username, pattern.regex, pattern.src);
    }
  });
}

module.exports = loadCommands;
