require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const OpenAI = require('openai');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const openai = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1',
});

// Track PG-13 mode per guild
const guildModes = new Map(); // guildId -> 'pg' | 'pg13'

// ─── System Prompts ──────────────────────────────────────────────────────────

const BASE_RULES = `
You are a truth-or-dare question generator for a Christian teen Discord server (ages 12–18).

ALWAYS FOLLOW THESE RULES:
- No sexual content, nudity, or explicit physical descriptions
- No demonic, occult, witchcraft, or spiritually dark themes
- No cursing, profanity, or crude language
- No alcohol, drugs, tobacco, or substance references
- No content that mocks or undermines Christian faith
- No content involving real people in harmful, degrading, or sexual scenarios (embarrassing is fine)
- No dares involving physical danger, pain, or trespassing
- Keep dares realistic — things people can actually do over text/voice chat or at home

CONTENT BALANCE:
Rotate evenly between three tones:
1. Silly / fun — lighthearted, funny, goofy
2. Thoughtful / meaningful — makes someone reflect genuinely
3. Deep / faith-adjacent — about beliefs, values, life goals (not preachy, just honest)

OUTPUT FORMAT:
Respond with ONLY a JSON object, no markdown, no extra text:
{
  "type": "truth" or "dare",
  "tone": "silly" or "thoughtful" or "deep",
  "question": "the question or dare text"
}
`;

const PG_PROMPT = BASE_RULES + `
MODE: PG
Keep all content appropriate for ages 12+. No romantic or dating content.
`;

const PG13_PROMPT = BASE_RULES + `
MODE: PG-13
Appropriate for ages 13–18. You MAY include:
- Questions about crushes, dating, first kisses, relationships
- Questions about what someone finds attractive (personality-focused)
- Relatable teen social situations involving the opposite sex
Still avoid anything explicitly sexual, graphic, or that a parent would find inappropriate.
`;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getMode(guildId) {
  return guildModes.get(guildId) || 'pg';
}

function getModeLabel(guildId) {
  return getMode(guildId) === 'pg13' ? 'PG-13' : 'PG';
}

async function generateQuestion(guildId, forcedType = null) {
  const systemPrompt = getMode(guildId) === 'pg13' ? PG13_PROMPT : PG_PROMPT;

  const userMessage = forcedType
    ? `Generate a ${forcedType} question.`
    : `Generate either a truth or a dare. Randomly pick one.`;

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
  return parsed;
}

function toneEmoji(tone) {
  if (tone === 'silly') return '😂';
  if (tone === 'thoughtful') return '💭';
  if (tone === 'deep') return '✨';
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

const commands = [
  new SlashCommandBuilder()
    .setName('truth')
    .setDescription('Get a truth question'),

  new SlashCommandBuilder()
    .setName('dare')
    .setDescription('Get a dare'),

  new SlashCommandBuilder()
    .setName('random')
    .setDescription('Get a random truth or dare'),

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
    await interaction.deferReply();
    try {
      const type = commandName === 'random' ? null : commandName;
      const data = await generateQuestion(guildId, type);
      const embed = buildEmbed(data, guildId);
      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error(err);
      await interaction.editReply('Something went wrong generating a question. Try again!');
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
  console.log(`✅ Logged in as ${client.user.tag}`);
});

registerCommands().then(() => {
  client.login(process.env.DISCORD_TOKEN);
});
