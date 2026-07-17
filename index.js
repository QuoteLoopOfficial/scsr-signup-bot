// Southern Cross Sim Racing - race number bot + signup API
//
// What this does:
//  - Lets drivers register a race number either via Discord slash command (/race)
//    or via the signup webpage (which calls the API below).
//  - Numbers are locked one driver per number. Leading zeros are cosmetic:
//    1, 01 and 001 are the SAME number. Whoever takes it first locks all three
//    forms, and keeps the exact form they typed as their display number.
//  - Automatically sets the driver's server nickname to "#Number Name", where
//    Name is their iRacing name.
//  - Keeps the roster in Supabase (Postgres), shared by the bot and the webpage.
//  - Serves the roster as JSON (GET /api/roster) for the website to render.
//  - Keeps a pinned roster message in a Discord channel in sync (optional).
//  - Admin actions (remove / reassign a number) are available as /admin
//    commands in Discord, restricted to whoever your server lets run them.
//
// Run with: npm install && npm start

require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const db = require('./db.js'); // the only module that talks to Supabase
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  Events,
} = require('discord.js');

const MIN_NUMBER = 1;
const MAX_NUMBER = 999;
const LEAGUE_NAME = 'Southern Cross Sim Racing';
const DRIVER_ROLE_NAME = process.env.DRIVER_ROLE_NAME || 'GR86 DRIVER'; // Discord role granted to every registered driver (override per season via env)

const {
  DISCORD_TOKEN,
  CLIENT_ID,
  GUILD_ID,
  ALLOWED_ORIGIN,
  ROSTER_CHANNEL_ID, // optional: channel where each new signup is announced
  SITE_URL,          // optional: link shown on the Discord roster message
  PORT,
} = process.env;

if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error('Missing DISCORD_TOKEN, CLIENT_ID, or GUILD_ID in your .env file. See .env.example.');
  process.exit(1);
}

// ---------- Race numbers ----------
// A race number has two parts:
//   canonical - the integer used as the roster key. This is what gets LOCKED.
//   display   - the exact text the driver typed, e.g. "01". This is what gets
//               shown on the roster and in their Discord nickname.
// So "1", "01" and "001" all share canonical 1 and cannot coexist.
function parseRaceNumber(raw) {
  if (raw === null || raw === undefined) return null;
  const display = String(raw).trim();
  if (!/^[0-9]{1,3}$/.test(display)) return null;
  const canonical = parseInt(display, 10);
  if (canonical < MIN_NUMBER || canonical > MAX_NUMBER) return null;
  return { canonical, key: String(canonical), display };
}

// ---------- Roster storage ----------
// The roster lives in Supabase (see db.js). Reads come back in this shape:
//   { "7": { display: "07", name, iracing, discordId, discordUsername, ts } }
// The key is always the canonical number as a string.

// simple in-process write lock so two near-simultaneous requests can't interleave
let writeQueue = Promise.resolve();
function withLock(fn) {
  const run = writeQueue.then(fn, fn);
  writeQueue = run.then(() => {}, () => {});
  return run;
}

// Sorted list of entries, lowest number first. Used everywhere a roster is rendered.
function rosterEntries(r) {
  return Object.entries(r)
    .map(([key, e]) => ({ ...e, canonical: Number(key), display: e.display || key }))
    .sort((a, b) => a.canonical - b.canonical);
}

// ---------- The published roster document ----------
// Rendered on demand from the database. This is what the website reads and the
// Discord message mirrors.
function formatStamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// The public roster deliberately leaves out iRacing customer IDs. Those stay in
// the database (and the /admin list Discord command) only. Add `iracing: e.iracing`
// below if you want them published.
function publicRoster(r) {
  const stamp = new Date();
  const entries = rosterEntries(r).map((e) => ({
    number: e.display,
    canonical: e.canonical,
    name: e.name || '',
    ts: e.ts || null,
  }));
  return { updatedAt: stamp.toISOString(), updatedAtLabel: formatStamp(stamp), count: entries.length, drivers: entries };
}

// ---------- Discord client ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // needed to look up members & set nicknames
  ],
});

async function setMemberNickname(member, name, displayNumber) {
  const nickname = `#${displayNumber} ${name}`.slice(0, 32); // Discord nickname limit
  try {
    await member.setNickname(nickname);
    return { ok: true, nickname };
  } catch (e) {
    // Common causes: bot's role isn't above the member's highest role, or the
    // member is the server owner (Discord never allows renaming the owner).
    return { ok: false, error: e.message };
  }
}

// Grants the driver role (DRIVER_ROLE_NAME). Best-effort, exactly like
// setMemberNickname: it needs the bot's OWN role to sit above the driver role in
// Server Settings -> Roles, plus Manage Roles (Administrator covers the perm, but
// NOT the role-position rule). Safe to call repeatedly - it no-ops if they have it.
async function assignMemberRole(member) {
  try {
    const roles = await member.guild.roles.fetch();
    const role = roles.find((r) => r.name.toLowerCase() === DRIVER_ROLE_NAME.toLowerCase());
    if (!role) return { ok: false, error: `role_not_found:${DRIVER_ROLE_NAME}` };
    if (member.roles.cache.has(role.id)) return { ok: true, role: role.name, already: true };
    await member.roles.add(role);
    return { ok: true, role: role.name };
  } catch (e) {
    // Usually: the bot's own role isn't above the driver role, or the member is
    // the server owner (Discord never lets a bot modify the owner).
    return { ok: false, error: e.message };
  }
}

async function tryResolveAndRename(guild, entry) {
  let member = null;
  if (entry.discordId) {
    member = await guild.members.fetch(entry.discordId).catch(() => null);
  }
  if (!member && entry.discordUsername) {
    const found = await guild.members
      .search({ query: entry.discordUsername, limit: 5 })
      .catch(() => null);
    if (found) {
      member = found.find(
        (m) => m.user.username.toLowerCase() === entry.discordUsername.toLowerCase()
      );
    }
  }
  if (!member) return { ok: false, error: 'not_found_in_server' };

  entry.discordId = member.id;
  const nick = await setMemberNickname(member, entry.name, entry.display);
  await assignMemberRole(member); // best-effort; nickname result drives the reply
  return nick;
}

// ---------- Signup feed (Discord) ----------
// Optional. Set ROSTER_CHANNEL_ID in .env to switch this on. On each NEW signup
// the bot posts a standalone announcement to that channel - no edit, no pin, no
// coalescing, each signup is its own message. Soft by design: a failed post must
// NEVER fail the signup, so this catches everything and never throws.
async function postSignupMessage(entry) {
  if (!ROSTER_CHANNEL_ID || !client.isReady()) return;
  try {
    const channel = await client.channels.fetch(ROSTER_CHANNEL_ID).catch(() => null);
    if (!channel || !channel.isTextBased()) return;
    const embed = new EmbedBuilder()
      .setColor(0x0039d8)
      .setTitle(`#${entry.display} ${entry.name}`)
      .setDescription(`iRacing ID: ${entry.iracing}\nDiscord: @${entry.discordUsername || ''}`);
    await channel.send({ embeds: [embed] });
  } catch (e) {
    console.error('Signup feed post failed:', e.message);
  }
}

function rosterEmbed(entries, stamp) {
  const rows = entries.map((e) => `#${String(e.display).padEnd(4)} ${e.name || ''}`);
  let body = rows.join('\n');
  const limit = 3900;
  if (body.length > limit) {
    body = body.slice(0, limit) + `\n... and more`;
  }
  const embed = new EmbedBuilder()
    .setTitle(`${LEAGUE_NAME} - Driver Roster`)
    .setColor(0x0039d8)
    .setDescription(entries.length ? '```\n' + body + '\n```' : 'No drivers registered yet.')
    .setFooter({ text: `${entries.length} driver${entries.length === 1 ? '' : 's'} - updated ${stamp}` });
  if (SITE_URL) embed.addFields({ name: 'Claim a number', value: SITE_URL });
  return embed;
}

// ---------- Slash commands ----------
// Note: `number` is a STRING option, not an integer, so leading zeros survive.
const commands = [
  new SlashCommandBuilder()
    .setName('race')
    .setDescription('Register your race number for Southern Cross Sim Racing')
    .addStringOption((o) =>
      o.setName('number').setDescription('Race number, 1-999 (whole numbers only, e.g. 7)').setRequired(true)
    )
    .addStringOption((o) =>
      o.setName('iracing_name').setDescription('Your iRacing name, exactly as it appears on your account').setRequired(true)
    )
    .addStringOption((o) =>
      o.setName('iracing_id').setDescription('Your iRacing customer ID').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('roster')
    .setDescription('Show the current driver roster'),

  new SlashCommandBuilder()
    .setName('admin')
    .setDescription('Manage the race number roster')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageNicknames)
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Free up a race number')
        .addStringOption((o) => o.setName('number').setDescription('Race number').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('set')
        .setDescription('Assign or override a race number')
        .addStringOption((o) => o.setName('number').setDescription('Race number, e.g. 7 or 07').setRequired(true))
        .addStringOption((o) => o.setName('iracing_name').setDescription('Driver iRacing name').setRequired(true))
        .addStringOption((o) => o.setName('iracing_id').setDescription('iRacing customer ID').setRequired(true))
        .addUserOption((o) => o.setName('discord_user').setDescription('Discord member to rename').setRequired(false))
    )
    .addSubcommand((sub) => sub.setName('list').setDescription('List the current roster'))
    .addSubcommand((sub) => sub.setName('sync').setDescription('Re-apply nicknames for everyone on the roster')),
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log('Slash commands registered.');
}

// ---------- Slash command handling ----------
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'roster') {
    const entries = rosterEntries(await db.getRoster());
    return interaction.reply({
      embeds: [rosterEmbed(entries, formatStamp(new Date()))],
      ephemeral: true,
    });
  }

  if (interaction.commandName === 'race') {
    const num = parseRaceNumber(interaction.options.getString('number'));
    const name = interaction.options.getString('iracing_name').trim();
    const iracing = interaction.options.getString('iracing_id').trim();

    if (!num) {
      return interaction.reply({
        content: `Number must be a whole number between ${MIN_NUMBER} and ${MAX_NUMBER} - no leading zeros (use 7, not 07).`,
        ephemeral: true,
      });
    }
    if (num.display.startsWith('0')) {
      return interaction.reply({
        content: "Race numbers don't take leading zeros. Use 7, not 07.",
        ephemeral: true,
      });
    }
    if (!/^[0-9]{1,8}$/.test(iracing)) {
      return interaction.reply({
        content: 'iRacing ID should be your customer number, digits only.',
        ephemeral: true,
      });
    }
    if (name.length > 64) {
      return interaction.reply({ content: 'iRacing name is too long (max 64 characters).', ephemeral: true });
    }
    if (interaction.user.username.length > 32) {
      return interaction.reply({ content: 'Your Discord username is too long to register.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    await withLock(async () => {
      const entry = {
        canonical: num.canonical,
        display: num.display,
        name,
        iracing,
        discordId: interaction.user.id,
        discordUsername: interaction.user.username,
        ts: Date.now(),
      };

      const result = await db.claimNumber(entry);
      if (!result.ok) {
        if (result.reason === 'number_taken') {
          const taken = await db.getByCanonical(num.canonical);
          const asShown = taken && taken.display !== num.display ? ` (registered as #${taken.display})` : '';
          return interaction.editReply(`#${num.display} is already taken${asShown} - try another number.`);
        }
        // already_registered
        const mine = (await db.getByDiscordUser(interaction.user.id))
          || (await db.getByDiscordUsername(interaction.user.username));
        return interaction.editReply(
          `You already have #${mine.display}. Ask an admin if you want to change it.`
        );
      }
      postSignupMessage(entry); // soft: announce this signup in the feed

      const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
      let nickMsg = '';
      let roleMsg = '';
      if (member) {
        const nickResult = await setMemberNickname(member, name, num.display);
        nickMsg = nickResult.ok
          ? ` Your nickname is now set to "${nickResult.nickname}".`
          : ` (Couldn't set your nickname automatically - ask an admin to check bot role position.)`;
        const roleResult = await assignMemberRole(member);
        if (roleResult.ok && !roleResult.already) roleMsg = ` You've been given the ${roleResult.role} role.`;
        else if (!roleResult.ok) roleMsg = ` (Couldn't assign the ${DRIVER_ROLE_NAME} role automatically - ask an admin to check bot role position.)`;
      }
      await interaction.editReply(`You're in! #${num.display} is locked in for ${name}.${nickMsg}${roleMsg}`);
    });
    return;
  }

  if (interaction.commandName === 'admin') {
    const sub = interaction.options.getSubcommand();

    if (sub === 'list') {
      const entries = rosterEntries(await db.getRoster());
      if (entries.length === 0) return interaction.reply({ content: 'Roster is empty.', ephemeral: true });
      const lines = entries.map((e) => `#${e.display} - ${e.name} (${e.iracing})`);
      return interaction.reply({ content: lines.join('\n').slice(0, 1900), ephemeral: true });
    }

    if (sub === 'remove') {
      const num = parseRaceNumber(interaction.options.getString('number'));
      if (!num) return interaction.reply({ content: 'That is not a valid race number.', ephemeral: true });

      await withLock(async () => {
        const removed = await db.removeByCanonical(num.canonical);
        if (!removed) {
          return interaction.reply({ content: `#${num.display} isn't taken.`, ephemeral: true });
        }
        await interaction.reply({ content: `#${removed.display} has been freed up.`, ephemeral: true });
      });
      return;
    }

    if (sub === 'set') {
      const num = parseRaceNumber(interaction.options.getString('number'));
      const name = interaction.options.getString('iracing_name').trim();
      const iracing = interaction.options.getString('iracing_id').trim();
      const discordUser = interaction.options.getUser('discord_user');

      if (!num) return interaction.reply({ content: 'That is not a valid race number.', ephemeral: true });

      await withLock(async () => {
        // "Assign or override": move this driver to this number, evicting any
        // current holder. Delete-then-insert (only /admin set does this).
        // 1. Move - free any number this driver already holds.
        let movedFrom = null;
        if (discordUser) {
          const priors = [];
          const byId = await db.getByDiscordUser(discordUser.id);
          if (byId) priors.push(byId);
          const byName = await db.getByDiscordUsername(discordUser.username);
          if (byName) priors.push(byName);
          const cleared = new Set();
          for (const prior of priors) {
            if (prior.canonical === num.canonical || cleared.has(prior.canonical)) continue;
            cleared.add(prior.canonical);
            if (!movedFrom) movedFrom = prior.display;
            await db.removeByCanonical(prior.canonical);
          }
        }
        // 2. Evict - whoever currently holds the target number.
        const evicted = await db.removeByCanonical(num.canonical);
        // 3. Insert the new row.
        const entry = {
          canonical: num.canonical,
          display: num.display,
          name,
          iracing,
          discordId: discordUser ? discordUser.id : undefined,
          discordUsername: discordUser ? discordUser.username : undefined,
          ts: Date.now(),
        };
        const result = await db.claimNumber(entry);
        if (!result.ok) {
          return interaction.reply({ content: `Couldn't set #${num.display} - ${result.reason}. Try /admin remove first.`, ephemeral: true });
        }
        let nickMsg = '';
        if (discordUser) {
          const member = await interaction.guild.members.fetch(discordUser.id).catch(() => null);
          if (member) {
            const r = await setMemberNickname(member, name, num.display);
            nickMsg = r.ok ? ` Nickname set to "${r.nickname}".` : ` (Couldn't set nickname - check bot role position.)`;
            await assignMemberRole(member);
          }
        }

        let msg = `#${num.display} set to ${name}.${nickMsg}`;
        if (movedFrom) msg += ` Moved from #${movedFrom}.`;
        if (evicted && (!discordUser || evicted.discordId !== discordUser.id)) {
          msg += ` Evicted ${evicted.name} from #${num.display}.`;
        }
        await interaction.reply({ content: msg, ephemeral: true });
      });
      return;
    }

    if (sub === 'sync') {
      await interaction.deferReply({ ephemeral: true });
      const roster = await db.getRoster();
      let ok = 0, failed = 0;
      for (const key of Object.keys(roster)) {
        const entry = roster[key];
        entry.display = entry.display || key;
        const result = await tryResolveAndRename(interaction.guild, entry);
        if (result.ok) ok++; else failed++;
        if (entry.discordId) await db.setDiscordUserId(entry.canonical, entry.discordId);
      }
      await interaction.editReply(`Sync complete: ${ok} nicknames updated, ${failed} skipped (member not found or couldn't be renamed).`);
      return;
    }
  }
});

// A newly-joining member might already be on the roster (registered on the
// webpage before joining Discord) - apply their nickname as soon as they arrive.
client.on(Events.GuildMemberAdd, async (member) => {
  const roster = await db.getRoster();
  for (const [key, entry] of Object.entries(roster)) {
    if (
      (entry.discordUsername && entry.discordUsername.toLowerCase() === member.user.username.toLowerCase()) ||
      entry.discordId === member.id
    ) {
      entry.display = entry.display || key;
      await setMemberNickname(member, entry.name, entry.display);
      await assignMemberRole(member);
      // Cache their id now that we've matched them (likely by username on join).
      await db.setDiscordUserId(entry.canonical, member.id);
      break;
    }
  }
});

// ---------- HTTP API for the signup webpage ----------
const app = express();
app.set('trust proxy', 1); // Render sits behind one proxy; trust the first hop so rate limits see the real client IP
app.use(express.json());
// Same-origin only unless an explicit ALLOWED_ORIGIN is set. '*' / unset no
// longer reflects every origin - the page is served from this same service.
const corsOrigin = ALLOWED_ORIGIN && ALLOWED_ORIGIN !== '*' ? ALLOWED_ORIGIN : false;
app.use(cors({ origin: corsOrigin }));

// Public signup is the one unauthenticated write path (DB + Discord post), so
// cap it hard per IP. Returns 429 with a plain message the page displays.
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  // Only successful registrations count - a fumbled field or a just-taken
  // number must never lock out a shared CGNAT IP (many drivers, one address).
  skipFailedRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many signups from your network. Please try again in an hour.' },
});

// Wrap an async route so a rejected promise (e.g. a database error) becomes a
// clean 500 instead of a hung request.
const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    console.error('Request failed:', e.message);
    if (!res.headersSent) res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });

// Public: the signup webpage itself, served from this same Render service so the
// page and its API share one origin (no CORS, no external URL to configure).
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'southern-cross-signup.html')));
app.get('/scsr-logo.png', (req, res) => res.sendFile(path.join(__dirname, 'scsr-logo.png')));

// Public: which numbers are taken. Returns canonical integers, so the webpage
// knows 1, 01 and 001 are all gone once any one of them is claimed.
app.get('/api/taken-numbers', wrap(async (req, res) => {
  const roster = await db.getRoster();
  res.json({
    taken: Object.keys(roster).map(Number),
    // display forms, keyed by canonical number, so we can say "taken as #01"
    displays: Object.fromEntries(Object.entries(roster).map(([k, e]) => [k, e.display || k])),
  });
}));

// Public: the roster document, as JSON
app.get('/api/roster', wrap(async (req, res) => {
  res.json(publicRoster(await db.getRoster()));
}));

// Public: register a number from the webpage
app.post('/api/register', registerLimiter, wrap(async (req, res) => {
  const { name, iracing, discordUsername, number } = req.body || {};
  const num = parseRaceNumber(number);

  if (!name || !iracing || !discordUsername || number === undefined || number === '') {
    return res.status(400).json({ error: 'iRacing name, iRacing ID, Discord username and number are all required' });
  }
  if (!num) {
    return res.status(400).json({ error: `Number must be between ${MIN_NUMBER} and ${MAX_NUMBER}` });
  }
  if (num.display.startsWith('0')) {
    return res.status(400).json({ error: "Race numbers don't take leading zeros. Use 7, not 07." });
  }
  if (!/^[0-9]{1,8}$/.test(String(iracing).trim())) {
    return res.status(400).json({ error: 'iRacing ID should be your customer number, digits only.' });
  }
  if (String(name).trim().length > 64) {
    return res.status(400).json({ error: 'iRacing name is too long (max 64 characters).' });
  }
  if (String(discordUsername).trim().length > 32) {
    return res.status(400).json({ error: 'Discord username is too long (max 32 characters).' });
  }

  await withLock(async () => {
    const cleanDiscord = String(discordUsername).trim();
    const entry = {
      canonical: num.canonical,
      display: num.display,
      name: String(name).trim(),
      iracing: String(iracing).trim(),
      discordId: undefined,
      discordUsername: cleanDiscord,
      ts: Date.now(),
    };

    const result = await db.claimNumber(entry);
    if (!result.ok) {
      if (result.reason === 'number_taken') {
        const taken = await db.getByCanonical(num.canonical);
        const asShown = taken && taken.display !== num.display ? ` (registered as #${taken.display})` : '';
        return res.status(409).json({ error: `#${num.display} was just taken${asShown} - pick another number.` });
      }
      // already_registered
      const mine = await db.getByDiscordUsername(cleanDiscord);
      return res.status(409).json({
        error: `${cleanDiscord} already has #${mine ? mine.display : ''}. Ask an admin if you want to change it.`,
      });
    }
    postSignupMessage(entry); // soft: announce this signup in the feed

    // Try to rename them immediately if they're already in the server
    const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
    let renamed = false;
    if (guild) {
      const r = await tryResolveAndRename(guild, entry);
      renamed = r.ok;
      // Cache the resolved Discord id so a later username change can't orphan them.
      if (entry.discordId) await db.setDiscordUserId(entry.canonical, entry.discordId);
    }

    res.json({
      ok: true,
      number: num.display,
      renamed,
      message: renamed
        ? `Registered! Your Discord nickname has been updated to "#${num.display} ${entry.name}".`
        : `Registered! We couldn't find you in the Discord server yet - your nickname will be set automatically once you join, or ask an admin to run /admin sync.`,
    });
  });
}));

// ---------- Boot everything ----------
(async () => {
  await registerCommands();
  await client.login(DISCORD_TOKEN);
  client.once(Events.ClientReady, (c) => {
    console.log(`Bot logged in as ${c.user.tag}`);
  });

  const port = PORT || 3000;
  app.listen(port, () => console.log(`API listening on port ${port}`));
})();
