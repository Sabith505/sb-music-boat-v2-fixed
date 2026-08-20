require("dotenv").config();

const http = require("http");
const path = require("path");
const { spawn } = require("child_process");
const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  ActivityType
} = require("discord.js");
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  StreamType,
  entersState
} = require("@discordjs/voice");
const youtubedl = require("youtube-dl-exec");

const PORT = process.env.PORT || 10000;

// Render Web Services need a listening HTTP port.
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("SB Music Bot is online.");
}).listen(PORT, "0.0.0.0", () => {
  console.log(`HTTP server listening on ${PORT}`);
});

const commands = [
  new SlashCommandBuilder()
    .setName("sb")
    .setDescription("SB music commands")
    .addSubcommand(s => s.setName("play").setDescription("Play a song or YouTube URL")
      .addStringOption(o => o.setName("query").setDescription("Song name or URL").setRequired(true)))
    .addSubcommand(s => s.setName("pause").setDescription("Pause"))
    .addSubcommand(s => s.setName("resume").setDescription("Resume"))
    .addSubcommand(s => s.setName("skip").setDescription("Skip"))
    .addSubcommand(s => s.setName("stop").setDescription("Stop and clear queue"))
    .addSubcommand(s => s.setName("queue").setDescription("Show queue"))
    .addSubcommand(s => s.setName("volume").setDescription("Set volume 1-100")
      .addIntegerOption(o => o.setName("percent").setDescription("Volume percent").setRequired(true).setMinValue(1).setMaxValue(100)))
    .addSubcommand(s => s.setName("loop").setDescription("Toggle loop for current song"))
    .addSubcommand(s => s.setName("leave").setDescription("Leave voice channel"))
].map(c => c.toJSON());

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
});

const states = new Map();

function getState(guildId) {
  if (!states.has(guildId)) {
    const player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause }
    });

    const state = {
      player,
      connection: null,
      queue: [],
      current: null,
      loop: false,
      volume: 80,
      resource: null,
      process: null
    };

    player.on(AudioPlayerStatus.Idle, () => {
      if (state.process) {
        try { state.process.kill("SIGKILL"); } catch {}
        state.process = null;
      }

      if (state.loop && state.current) {
        playCurrent(guildId).catch(console.error);
      } else {
        state.current = null;
        playNext(guildId).catch(console.error);
      }
    });

    player.on("error", e => console.error("Audio player error:", e));
    states.set(guildId, state);
  }
  return states.get(guildId);
}

async function ensureConnection(interaction, state) {
  const channel = interaction.member?.voice?.channel;
  if (!channel) throw new Error("Join a voice channel first.");

  if (!state.connection) {
    state.connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator
    });

    await entersState(state.connection, VoiceConnectionStatus.Ready, 15000);
    state.connection.subscribe(state.player);
  }
}

async function getTrack(query) {
  const target = /^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(query)
    ? query
    : `ytsearch1:${query}`;

  const data = await youtubedl(target, {
    dumpSingleJson: true,
    flatPlaylist: true,
    noWarnings: true,
    noCheckCertificates: true,
    noPlaylist: true,
    extractorArgs: "youtube:player_client=web_safari"
  });

  const entry = data.entries?.[0] || data;
  if (!entry || (!entry.id && !entry.webpage_url && !entry.url)) {
    throw new Error("No YouTube result found.");
  }

  return {
    title: entry.title || "Unknown title",
    url: entry.webpage_url || entry.url || `https://www.youtube.com/watch?v=${entry.id}`,
    duration: entry.duration_string || entry.duration || "unknown"
  };
}

function startAudioProcess(url) {
  const bin = path.join(__dirname, "node_modules", "youtube-dl-exec", "bin", "yt-dlp");

  // web_safari is used because yt-dlp currently documents HLS formats from
  // this client as a route that can avoid the GVS PO-token requirement.
  // We ask yt-dlp to write the selected audio stream to stdout.
  return spawn(bin, [
    url,
    "--no-playlist",
    "--quiet",
    "--no-warnings",
    "--no-check-certificates",
    "--format", "bestaudio/best",
    "--extractor-args", "youtube:player_client=web_safari",
    "--output", "-"
  ], {
    stdio: ["ignore", "pipe", "pipe"]
  });
}

async function playCurrent(guildId) {
  const state = getState(guildId);
  if (!state.current) return;

  if (state.process) {
    try { state.process.kill("SIGKILL"); } catch {}
    state.process = null;
  }

  const proc = startAudioProcess(state.current.url);
  state.process = proc;

  proc.stderr.on("data", d => {
    const text = d.toString().trim();
    if (text) console.log(`[yt-dlp] ${text}`);
  });

  proc.on("error", err => {
    console.error("yt-dlp process error:", err);
    state.process = null;
  });

  proc.on("close", code => {
    state.process = null;
    if (code && state.player.state.status !== AudioPlayerStatus.Idle) {
      console.error(`yt-dlp exited with code ${code}`);
      state.player.stop();
    }
  });

  const resource = createAudioResource(proc.stdout, {
    inputType: StreamType.WebmOpus,
    inlineVolume: true
  });

  resource.volume.setVolume(state.volume / 100);
  state.resource = resource;
  state.player.play(resource);
}

async function playNext(guildId) {
  const state = getState(guildId);
  if (state.current || !state.queue.length) return;

  state.current = state.queue.shift();
  await playCurrent(guildId);
}

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  client.user.setPresence({
    status: "idle",
    activities: [{
      name: "/sb play",
      type: ActivityType.Listening
    }]
  });

  if (process.env.GUILD_ID) {
    await client.application.commands.set(commands, process.env.GUILD_ID);
    console.log("Registered /sb commands in GUILD_ID.");
  } else {
    await client.application.commands.set(commands);
    console.log("Registered global /sb commands.");
  }

  console.log("Presence set to Idle.");
});

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "sb") return;

  const state = getState(interaction.guildId);
  const sub = interaction.options.getSubcommand();

  try {
    if (sub === "play") {
      await interaction.deferReply();

      await ensureConnection(interaction, state);
      const query = interaction.options.getString("query", true);
      const track = await getTrack(query);

      state.queue.push(track);
      if (!state.current) await playNext(interaction.guildId);

      return interaction.editReply(`🎵 Added: **${track.title}**`);
    }

    if (sub === "pause") {
      state.player.pause();
      return interaction.reply("⏸️ Paused.");
    }

    if (sub === "resume") {
      state.player.unpause();
      return interaction.reply("▶️ Resumed.");
    }

    if (sub === "skip") {
      if (!state.current) return interaction.reply("❌ Nothing is playing.");
      state.loop = false;
      state.player.stop();
      return interaction.reply("⏭️ Skipped.");
    }

    if (sub === "stop") {
      state.queue = [];
      state.current = null;
      state.loop = false;
      if (state.process) {
        try { state.process.kill("SIGKILL"); } catch {}
        state.process = null;
      }
      state.player.stop();
      return interaction.reply("⏹️ Stopped and cleared the queue.");
    }

    if (sub === "queue") {
      if (!state.current && !state.queue.length)
        return interaction.reply("📭 Queue is empty.");

      const now = state.current ? `🎵 Now: **${state.current.title}**\n` : "";
      const list = state.queue.slice(0, 10)
        .map((t, i) => `${i + 1}. ${t.title}`)
        .join("\n");

      return interaction.reply(`${now}${list ? `\n📋 Queue:\n${list}` : ""}`);
    }

    if (sub === "volume") {
      const volume = interaction.options.getInteger("percent", true);
      state.volume = volume;
      if (state.resource?.volume) state.resource.volume.setVolume(volume / 100);
      return interaction.reply(`🔊 Volume set to **${volume}%**.`);
    }

    if (sub === "loop") {
      state.loop = !state.loop;
      return interaction.reply(state.loop ? "🔁 Loop enabled." : "➡️ Loop disabled.");
    }

    if (sub === "leave") {
      state.queue = [];
      state.current = null;
      state.loop = false;

      if (state.process) {
        try { state.process.kill("SIGKILL"); } catch {}
        state.process = null;
      }

      state.player.stop();
      state.connection?.destroy();
      states.delete(interaction.guildId);

      return interaction.reply("👋 Left the voice channel.");
    }
  } catch (e) {
    console.error(e);
    const msg = `❌ ${e.message || "Something went wrong."}`;

    if (interaction.deferred) return interaction.editReply(msg);
    if (!interaction.replied) return interaction.reply(msg);
  }
});

client.login(process.env.DISCORD_TOKEN);
