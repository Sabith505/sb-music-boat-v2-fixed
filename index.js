require("dotenv").config();

const http = require("http");
const {
  Client,
  GatewayIntentBits,
  ActivityType,
  SlashCommandBuilder
} = require("discord.js");
const { Connectors } = require("shoukaku");
const { Kazagumo } = require("kazagumo");

const PORT = process.env.PORT || 10000;
const NODE_API = "https://lavalink-list.ajieblogs.eu.org/servers";

http.createServer((req, res) => {
  res.writeHead(200, {"Content-Type": "text/plain"});
  res.end("SB Boom Box is online.");
}).listen(PORT, "0.0.0.0", () => {
  console.log(`HTTP server listening on ${PORT}`);
});

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
});

const commands = [
  new SlashCommandBuilder()
    .setName("sb")
    .setDescription("SB Boom Box music")
    .addSubcommand(s => s.setName("play").setDescription("Play/search a song")
      .addStringOption(o => o.setName("query").setDescription("Song name or URL").setRequired(true)))
    .addSubcommand(s => s.setName("pause").setDescription("Pause playback"))
    .addSubcommand(s => s.setName("resume").setDescription("Resume playback"))
    .addSubcommand(s => s.setName("skip").setDescription("Skip current song"))
    .addSubcommand(s => s.setName("stop").setDescription("Stop and clear queue"))
    .addSubcommand(s => s.setName("queue").setDescription("Show queue"))
    .addSubcommand(s => s.setName("volume").setDescription("Set volume")
      .addIntegerOption(o => o.setName("percent").setDescription("1-100").setRequired(true).setMinValue(1).setMaxValue(100)))
    .addSubcommand(s => s.setName("loop").setDescription("Toggle current-song loop"))
    .addSubcommand(s => s.setName("leave").setDescription("Leave voice channel"))
].map(x => x.toJSON());

async function discoverNodes() {
  const response = await fetch(NODE_API);
  if (!response.ok) throw new Error(`Public Lavalink API returned ${response.status}`);

  const data = await response.json();
  const list = Array.isArray(data) ? data : (data.nodes || data.servers || []);

  const nodes = [];
  for (const n of list) {
    const host = n.host || n.hostname || n.ip;
    const port = Number(n.port || (n.url ? new URL(n.url).port : 443));
    const secure = n.secure ?? n.ssl ?? (n.url ? new URL(n.url).protocol === "https:" : true);
    const password = n.password || n.auth || "youshallnotpass";

    if (!host || !port) continue;
    nodes.push({
      name: `public-${host}-${port}`,
      url: `${host}:${port}`,
      auth: password,
      secure: !!secure
    });
  }

  // Allow a manual public node as a fallback if the public directory changes.
  if (!nodes.length && process.env.LAVALINK_HOST) {
    nodes.push({
      name: "manual",
      url: `${process.env.LAVALINK_HOST}:${process.env.LAVALINK_PORT || 443}`,
      auth: process.env.LAVALINK_PASSWORD || "youshallnotpass",
      secure: process.env.LAVALINK_SECURE !== "false"
    });
  }

  if (!nodes.length) throw new Error("No public Lavalink nodes were returned.");
  return nodes.slice(0, 8);
}

let kazagumo;

async function startMusic() {
  const nodes = await discoverNodes();
  console.log(`Discovered ${nodes.length} public Lavalink node(s).`);

  kazagumo = new Kazagumo(
    {
      defaultSearchEngine: "ytmsearch",
      send: (guildId, payload) => {
        const guild = client.guilds.cache.get(guildId);
        if (guild) guild.shard.send(payload);
      }
    },
    new Connectors.DiscordJS(client),
    nodes
  );

  kazagumo.shoukaku.on("ready", name => console.log(`Lavalink ready: ${name}`));
  kazagumo.shoukaku.on("error", (name, err) => console.error(`Lavalink error ${name}:`, err));
  kazagumo.shoukaku.on("disconnect", (name, count) =>
    console.log(`Lavalink disconnected: ${name} (${count ?? 0})`));

  kazagumo.on("playerStart", (player, track) =>
    console.log(`[${player.guildId}] Playing: ${track.title}`));
  kazagumo.on("playerEnd", (player, track) =>
    console.log(`[${player.guildId}] Ended: ${track?.title || "unknown"}`));
  kazagumo.on("playerEmpty", player =>
    console.log(`[${player.guildId}] Queue empty.`));
}

function voiceChannel(interaction) {
  const channel = interaction.member?.voice?.channel;
  if (!channel) throw new Error("Join a voice channel first.");
  return channel;
}

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  client.user.setPresence({
    status: "idle",
    activities: [{ name: "/sb play", type: ActivityType.Listening }]
  });

  if (process.env.GUILD_ID) {
    const guild = client.guilds.cache.get(process.env.GUILD_ID);
    if (guild) await guild.commands.set(commands);
    else await client.application.commands.set(commands, process.env.GUILD_ID);
  } else {
    await client.application.commands.set(commands);
  }

  console.log("Registered /sb commands.");
  console.log("Presence set to Idle.");

  try {
    await startMusic();
  } catch (e) {
    console.error("Could not start public Lavalink:", e);
  }
});

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "sb") return;

  try {
    if (!kazagumo) return interaction.reply("⏳ Music system is still connecting. Try again in a few seconds.");

    const sub = interaction.options.getSubcommand();

    if (sub === "play") {
      await interaction.deferReply();

      const vc = voiceChannel(interaction);
      const query = interaction.options.getString("query", true);

      let player = kazagumo.players.get(interaction.guildId);
      if (!player) {
        player = await kazagumo.createPlayer({
          guildId: interaction.guildId,
          textId: interaction.channelId,
          voiceId: vc.id,
          deaf: true
        });
      } else if (player.voiceId !== vc.id) {
        player.setVoiceChannel(vc.id);
      }

      const result = await kazagumo.search(
        /^https?:\/\//i.test(query) ? query : `ytmsearch:${query}`,
        { requester: interaction.user }
      );

      if (!result.tracks?.length) return interaction.editReply("❌ No results found.");

      if (result.type === "PLAYLIST") {
        player.queue.add(result.tracks);
        if (!player.playing && !player.paused) await player.play();
        return interaction.editReply(`📋 Added **${result.tracks.length}** tracks.`);
      }

      const track = result.tracks[0];
      player.queue.add(track);
      if (!player.playing && !player.paused) await player.play();

      return interaction.editReply(`🎵 Added: **${track.title}**`);
    }

    const player = kazagumo.players.get(interaction.guildId);

    if (sub === "leave") {
      if (player) player.destroy();
      return interaction.reply("👋 Left the voice channel.");
    }

    if (!player) return interaction.reply("❌ Nothing is playing.");

    if (sub === "pause") {
      await player.pause(true);
      return interaction.reply("⏸️ Paused.");
    }

    if (sub === "resume") {
      await player.pause(false);
      return interaction.reply("▶️ Resumed.");
    }

    if (sub === "skip") {
      await player.skip();
      return interaction.reply("⏭️ Skipped.");
    }

    if (sub === "stop") {
      player.queue.clear();
      await player.stop();
      return interaction.reply("⏹️ Stopped and cleared the queue.");
    }

    if (sub === "queue") {
      const current = player.queue.current;
      const tracks = player.queue.slice(0, 10);
      if (!current && !tracks.length) return interaction.reply("📭 Queue is empty.");

      let out = current ? `🎵 Now: **${current.title}**\n` : "";
      if (tracks.length) out += "\n📋 Queue:\n" + tracks.map((t, i) => `${i + 1}. ${t.title}`).join("\n");
      return interaction.reply(out);
    }

    if (sub === "volume") {
      const volume = interaction.options.getInteger("percent", true);
      await player.setVolume(volume);
      return interaction.reply(`🔊 Volume set to **${volume}%**.`);
    }

    if (sub === "loop") {
      const enabled = player.loop === "track";
      player.setLoop(enabled ? "none" : "track");
      return interaction.reply(enabled ? "➡️ Loop disabled." : "🔁 Loop enabled.");
    }
  } catch (e) {
    console.error(e);
    const msg = `❌ ${e.message || "Music error."}`;
    if (interaction.deferred) return interaction.editReply(msg);
    if (!interaction.replied) return interaction.reply(msg);
  }
});

client.login(process.env.DISCORD_TOKEN);
