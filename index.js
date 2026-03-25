require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const OpenAI = require('openai');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessageReactions] });
const openai = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1',
});

const guildModes = new Map();
const lastPolls = new Map();

// ─── System Prompts ──────────────────────────────────────────────────────────

const BASE_RULES = `
You are a truth-or-dare question generator for a teen Discord server (ages 12–18). Questions should feel fun, a little uncomfortable, and like something teens would actually want to play.

AVOID: sexual content, nudity, occult/demonic themes, cursing, alcohol/drugs, religious mockery, real people in harmful scenarios, dangerous dares, faith/worship topics.

TONE MIX (per 10): 5 fun/chaotic, 2 personal/spicy, 2 creative, 1 deep.

TRUTH IDEAS: search history embarrassment, petty confessions, hot takes, ranking server members, things done to impress someone.
DARE IDEAS: 7th camera roll photo, impressions of server members, "we need to talk" screenshot, unhinged voice message, server rename for an hour, dramatic monologue about a snack.

OUTPUT: JSON only, no markdown:
{"type":"truth"|"dare","tone":"silly"|"thoughtful"|"deep","question":"..."}
`;

const PG_PROMPT = BASE_RULES + `MODE: PG. Ages 12+. No romantic or dating content.`;

const PG13_PROMPT = BASE_RULES + `
MODE: PG-13, ages 13–18.

TONE MIX: 4 romantic/dating, 3 chaotic/fun, 2 deep, 1 personal/revealing.

ROMANTIC STYLE: Mix hypothetical/preference questions with light crush-based ones. Do NOT assume relationship history. Questions should be answerable even if someone has never dated.

HYPOTHETICAL/PREFERENCE IDEAS: biggest ick, would you rather know your crush likes you back but can never date or never know at all, what would instantly make you like someone more, funnier or smarter partner, ideal date in one sentence, dealbreaker in a relationship.
CRUSH-BASED IDEAS: do you have a crush right now (yes/no only), have you ever had a crush on someone in this server, most embarrassing thing done because you liked someone, have you ever said "I don't like anyone" when you definitely did.

CRITICAL: Vary romantic questions widely. Do NOT repeat "describe your type" or past-relationship questions repeatedly.

Nothing explicitly sexual or graphic.
`;

const MOSTLIKELY_PROMPT = `
You are a "Most Likely To" question generator for a teen Discord server (ages 12–18).

AVOID: sexual content, occult, cursing, alcohol/drugs, religious mockery, genuinely mean questions.
VIBE: funny, slightly embarrassing, things people laugh about.

EXAMPLES: wrong-person text, start a conspiracy theory people believe, befriend a stranger in 5 min, late to own birthday, go viral for wrong reasons, cry at a commercial, like a 3-year-old photo, text back 3 days late.

OUTPUT: JSON only: {"question":"Most likely to ..."}
`;

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function generateMostLikely() {
  const response = await openai.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    max_tokens: 100,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: MOSTLIKELY_PROMPT },
      { role: 'user', content: 'Generate a most likely to question.' },
    ],
  });
  const raw = response.choices[0].message.content.trim();
  const parsed = JSON.parse(raw);
  return parsed.question;
}

function getMode(guildId) {
  return guildModes.get(guildId) || 'pg';
}

function getModeLabel(guildId) {
  return getMode(guildId) === 'pg13' ? 'PG-13' : 'PG';
}

const recentQuestions = new Map();
const MAX_RECENT = 30;

function getRecentQuestions(guildId) {
  return recentQuestions.get(guildId) || [];
}

function addRecentQuestion(guildId, question) {
  const recent = getRecentQuestions(guildId);
  recent.push(question);
  if (recent.length > MAX_RECENT) recent.shift();
  recentQuestions.set(guildId, recent);
}

async function generateQuestion(guildId, forcedType = null, forcedTone = null) {
  const systemPrompt = getMode(guildId) === 'pg13' ? PG13_PROMPT : PG_PROMPT;

  let userMessage = forcedType
    ? `Generate a ${forcedType} question.`
    : `Generate either a truth or a dare. Randomly pick one.`;

  if (forcedTone) {
    userMessage += ` Tone MUST be "${forcedTone}".`;
  }

  const recent = getRecentQuestions(guildId);
  if (recent.length > 0) {
    userMessage += `\n\nDo NOT repeat or closely resemble:\n${recent.map((q, i) => `${i + 1}. ${q}`).join('\n')}`;
  }

  const maxRetries = 3;
  const retryDelays = [5000, 10000, 20000];

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await openai.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 300,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
      });

      const raw = response.choices[0].message.content.trim();
      const parsed = JSON.parse(raw);
      addRecentQuestion(guildId, parsed.question);
      return parsed;

    } catch (err) {
      const isRateLimit = err?.status === 429 || err?.code === 'rate_limit_exceeded';
      if (isRateLimit && attempt < maxRetries - 1) {
        console.warn(`Rate limited. Retrying in ${retryDelays[attempt] / 1000}s... (attempt ${attempt + 1})`);
        await new Promise(res => setTimeout(res, retryDelays[attempt]));
      } else {
        throw err;
      }
    }
  }
}

function toneEmoji(tone) {
  if (tone === 'silly') return '😂';
  if (tone === 'thoughtful' || tone === 'spicy') return '🌶️';
  if (tone === 'deep') return '✨';
  if (tone === 'dating') return '💘';
  if (tone === 'chaotic') return '🤪';
  return '🎲';
}

function buildEmbed(data, guildId) {
  const isTruth = data.type === 'truth';
  const color = isTruth ? 0x5865f2 : 0xed4245;
  const label = isTruth ? '🔵 TRUTH' : '🔴 DARE';
  const mode = getModeLabel(guildId);

  return new EmbedBuilder()
    .setColor(color)
    .setTitle(`${label}  ${toneEmoji(data.tone)}`)
    .setDescription(data.question)
    .setFooter({ text: `Mode: ${mode} · Tone: ${data.tone}` });
}

// ─── Slash Commands ───────────────────────────────────────────────────────────

const TONE_CHOICES = [
  { name: 'silly', value: 'silly' },
  { name: 'spicy', value: 'spicy' },
  { name: 'deep', value: 'deep' },
  { name: 'chaotic', value: 'chaotic' },
  { name: 'dating', value: 'dating' },
];

const commands = [
  new SlashCommandBuilder()
    .setName('truth')
    .setDescription('Get a truth question')
    .addStringOption(opt =>
      opt.setName('tone')
        .setDescription('What kind of question do you want?')
        .setRequired(false)
        .addChoices(...TONE_CHOICES)
    ),

  new SlashCommandBuilder()
    .setName('dare')
    .setDescription('Get a dare')
    .addStringOption(opt =>
      opt.setName('tone')
        .setDescription('What kind of dare do you want?')
        .setRequired(false)
        .addChoices(...TONE_CHOICES)
    ),

  new SlashCommandBuilder()
    .setName('random')
    .setDescription('Get a random truth or dare')
    .addStringOption(opt =>
      opt.setName('tone')
        .setDescription('What kind of question do you want?')
        .setRequired(false)
        .addChoices(...TONE_CHOICES)
    ),

  new SlashCommandBuilder()
    .setName('results')
    .setDescription('Announce the winner of the last Most Likely To poll'),

  new SlashCommandBuilder()
    .setName('mostlikely')
    .setDescription('Start a Most Likely To poll with server members'),

  new SlashCommandBuilder()
    .setName('pg13')
    .setDescription('Toggle PG-13 mode on or off for this server'),

  new SlashCommandBuilder()
    .setName('mode')
    .setDescription('Check the current content mode'),

].map(cmd => cmd.toJSON());

// ─── Register Commands ────────────────────────────────────────────────────────

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    console.log('Registering slash commands...');
    await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID),
      { body: commands }
    );
    console.log('Commands registered.');
  } catch (err) {
    console.error('Failed to register commands:', err);
  }
}

// ─── Interaction Handler ──────────────────────────────────────────────────────

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, guildId } = interaction;

  if (commandName === 'truth' || commandName === 'dare' || commandName === 'random') {
    const tone = interaction.options.getString('tone') || null;

    if (tone === 'dating' && getMode(guildId) !== 'pg13') {
      await interaction.reply('💘 Enable PG-13 mode first with `/pg13` to use dating questions.');
      return;
    }

    await interaction.deferReply();
    try {
      const type = commandName === 'random' ? null : commandName;
      const data = await generateQuestion(guildId, type, tone);
      const embed = buildEmbed(data, guildId);
      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error(err);
      const isRateLimit = err?.status === 429 || err?.code === 'rate_limit_exceeded';
      if (isRateLimit) {
        await interaction.editReply(`⚠️ We've hit Groq's rate limit — too many questions too fast, or the daily limit is maxed. Wait a minute and try again! <@1315056882456596563>`);
      } else {
        await interaction.editReply('Something went wrong generating a question. Try again!');
      }
    }
  }

  if (commandName === 'results') {
    const poll = lastPolls.get(guildId);
    if (!poll) {
      await interaction.reply('No Most Likely To poll has been run yet! Use `/mostlikely` first.');
      return;
    }

    await interaction.deferReply();
    try {
      const channel = await client.channels.fetch(poll.channelId);
      const message = await channel.messages.fetch(poll.messageId);

      let winnerIndex = -1;
      let winnerCount = 0;
      let tie = false;

      for (let i = 0; i < Math.min(poll.members.length, poll.numberEmojis.length); i++) {
        const reaction = message.reactions.cache.get(poll.numberEmojis[i]);
        const count = reaction ? reaction.count - 1 : 0;
        if (count > winnerCount) {
          winnerCount = count;
          winnerIndex = i;
          tie = false;
        } else if (count === winnerCount && count > 0) {
          tie = true;
        }
      }

      if (winnerIndex === -1 || winnerCount === 0) {
        await interaction.editReply('No votes yet! Get people to react first.');
        return;
      }

      const winnerName = poll.members[winnerIndex];

      await interaction.guild.members.fetch();
      const member = interaction.guild.members.cache.find(
        m => m.displayName === winnerName
      );
      const tag = member ? `<@${member.id}>` : `**${winnerName}**`;

      if (tie) {
        await interaction.editReply(`🏆 It's a tie — but ${tag} is one of the winners of **"${poll.question}"**!`);
      } else {
        await interaction.editReply(`🏆 The winner is ${tag} for **"${poll.question}"**! (${winnerCount} vote${winnerCount !== 1 ? 's' : ''})`);
      }
    } catch (err) {
      console.error(err);
      await interaction.editReply('Something went wrong fetching the results. Try again!');
    }
  }

  if (commandName === 'mostlikely') {
    await interaction.deferReply();
    try {
      await interaction.guild.members.fetch();
      const members = interaction.guild.members.cache
        .filter(m => !m.user.bot)
        .map(m => m.displayName)
        .sort(() => Math.random() - 0.5);

      if (members.length < 2) {
        await interaction.editReply('Need at least 2 non-bot members!');
        return;
      }

      const numberEmojis = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟',
        '🇦','🇧','🇨','🇩','🇪','🇫','🇬','🇭','🇮','🇯','🇰','🇱','🇲','🇳','🇴','🇵','🇶','🇷','🇸','🇹'];

      const question = await generateMostLikely();

      const memberList = members
        .map((name, i) => `${numberEmojis[i]} ${name}`)
        .join('\n');

      const embed = new EmbedBuilder()
        .setColor(0xf1c40f)
        .setTitle(`🏆 ${question}`)
        .setDescription(memberList)
        .setFooter({ text: 'React with the matching emoji to vote!' });

      await interaction.editReply({ embeds: [embed] });
      const message = await interaction.fetchReply();

      for (let i = 0; i < Math.min(members.length, numberEmojis.length); i++) {
        await message.react(numberEmojis[i]);
      }

      lastPolls.set(guildId, {
        messageId: message.id,
        channelId: interaction.channelId,
        members,
        numberEmojis,
        question,
      });

    } catch (err) {
      console.error(err);
      await interaction.editReply('Something went wrong. Try again!');
    }
  }

  if (commandName === 'pg13') {
    const current = getMode(guildId);
    const next = current === 'pg13' ? 'pg' : 'pg13';
    guildModes.set(guildId, next);
    const label = next === 'pg13' ? '🔞 PG-13 mode **ON**' : '✅ Back to **PG mode**';
    await interaction.reply(`${label} — questions will adjust going forward.`);
  }

  if (commandName === 'mode') {
    const mode = getModeLabel(guildId);
    await interaction.reply(`Current mode: **${mode}**`);
  }

});

// ─── Boot ─────────────────────────────────────────────────────────────────────

client.once('ready', () => {
  console.log(`✅ Logged in as Truth Of Dare#2285`);
});

registerCommands().then(() => {
  client.login(process.env.DISCORD_TOKEN);
});
