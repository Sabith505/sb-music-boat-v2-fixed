require("dotenv").config();

const {
  Client, GatewayIntentBits, SlashCommandBuilder
} = require("discord.js");

const {
  joinVoiceChannel, createAudioPlayer, createAudioResource,
  AudioPlayerStatus, NoSubscriberBehavior, VoiceConnectionStatus,
  entersState
} = require("@discordjs/voice");

const play = require("play-dl");

const commands = [
  new SlashCommandBuilder()
    .setName("sb").setDescription("SB music commands")
    .addSubcommand(s => s.setName("play").setDescription("Play a song or URL")
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
      player, connection: null, queue: [], current: null,
      loop: false, volume: 80, resource: null
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

async function resolveTrack(query) {
  if (/^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(query)) {
    const info = await play.video_basic_info(query);
    return {
      title: info.video_details.title,
      url: info.video_details.url,
      duration: info.video_details.durationRaw || "unknown"
    };
  }

  const results = await play.search(query, { limit: 1, source: { youtube: "video" } });
  if (!results.length) throw new Error("No results found.");
  const v = results[0];
  return { title: v.title, url: v.url, duration: v.durationRaw || "unknown" };
}

async function playCurrent(guildId) {
  const state = getGuild(guildId);
  if (!state.current) return;

  const stream = await play.stream(state.current.url, { quality: 2 });
  state.resource = createAudioResource(stream.stream, {
    inputType: stream.type,
    inlineVolume: true
  });
  state.resource.volume.setVolume(state.volume / 100);
  state.player.play(state.resource);
}

async function playNext(guildId) {
  const state = getGuild(guildId);
  if (state.current || !state.queue.length) return;
  state.current = state.queue.shift();
  await playCurrent(guildId);
}

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
  client.application.commands.set(commands, process.env.GUILD_ID)
    .then(() => console.log("Registered /sb commands."));
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
      const track = await resolveTrack(query);
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
      const list = state.queue.slice(0, 10).map((t, i) => `${i + 1}. ${t.title}`).join("\n");
      return interaction.reply(`${now}${list ? `\n\n📋 Queue:\n${list}` : ""}`);
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
