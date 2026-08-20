require("dotenv").config();

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

const guilds = new Map();

function getGuild(guildId) {
  if (!guilds.has(guildId)) {
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
      sourceProcess: null
    };

    player.on(AudioPlayerStatus.Idle, () => {
      if (state.loop && state.current) {
        playCurrent(guildId).catch(console.error);
      } else {
        state.current = null;
        playNext(guildId).catch(console.error);
      }
    });

    player.on("error", e => console.error("Player error:", e));
    guilds.set(guildId, state);
  }
  return guilds.get(guildId);
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

async function ytInfo(query) {
  const target = /^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(query)
    ? query
    : `ytsearch1:${query}`;

  const data = await youtubedl(target, {
    dumpSingleJson: true,
    flatPlaylist: true,
    noWarnings: true,
    noCheckCertificates: true,
    noPlaylist: true,
    extractorArgs: "youtube:player_client=web,android_vr,tv_downgraded"
  });

  const entry = data.entries?.[0] || data;
  if (!entry || !entry.id && !entry.webpage_url && !entry.url) {
    throw new Error("No results found.");
  }

  const url = entry.webpage_url || entry.url ||
    `https://www.youtube.com/watch?v=${entry.id}`;

  return {
    title: entry.title || "Unknown title",
    url,
    duration: entry.duration_string || entry.duration || "unknown"
  };
}

async function getAudioUrl(url) {
  const output = await youtubedl(url, {
    getUrl: true,
    format: "bestaudio[ext=webm][acodec=opus]/bestaudio[ext=webm]/bestaudio",
    noPlaylist: true,
    noWarnings: true,
    noCheckCertificates: true,
    extractorArgs: "youtube:player_client=web,android_vr,tv_downgraded"
  });

  const audioUrl = String(output).trim().split(/\r?\n/).filter(Boolean).pop();
  if (!audioUrl || !audioUrl.startsWith("http")) {
    throw new Error("Could not get an audio stream from YouTube.");
  }
  return audioUrl;
}

async function playCurrent(guildId) {
  const state = getGuild(guildId);
  if (!state.current) return;

  if (state.sourceProcess) {
    try { state.sourceProcess.kill("SIGKILL"); } catch {}
    state.sourceProcess = null;
  }

  const audioUrl = await getAudioUrl(state.current.url);

  const resource = createAudioResource(audioUrl, {
    inputType: StreamType.WebmOpus,
    inlineVolume: true
  });

  state.resource = resource;
  state.resource.volume.setVolume(state.volume / 100);
  state.player.play(state.resource);
}

async function playNext(guildId) {
  const state = getGuild(guildId);
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

  await client.application.commands.set(commands, process.env.GUILD_ID);
  console.log("Registered /sb commands.");
  console.log("Presence set to Idle.");
});

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "sb") return;

  const state = getGuild(interaction.guildId);
  const sub = interaction.options.getSubcommand();

  try {
    if (sub === "play") {
      await interaction.deferReply();
      await ensureConnection(interaction, state);

      const query = interaction.options.getString("query", true);
      const track = await ytInfo(query);

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

      return interaction.reply(`${now}${list ? `\n\n📋 Queue:\n${list}` : ""}`);
    }

    if (sub === "volume") {
      const volume = interaction.options.getInteger("percent", true);
      state.volume = volume;

      if (state.resource?.volume)
        state.resource.volume.setVolume(volume / 100);

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
      state.player.stop();
      state.connection?.destroy();
      guilds.delete(interaction.guildId);

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
