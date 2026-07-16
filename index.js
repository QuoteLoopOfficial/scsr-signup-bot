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
//  - Keeps one shared roster (data.json) that the bot and the webpage read from.
//  - Regenerates a published roster document (roster.md / roster.csv /
//    roster.json) on every change, served publicly and shown on the website.
//  - Keeps a pinned roster message in a Discord channel in sync (optional).
//  - Admin actions (remove / reassign a number) are available as a /admin
//    command, restricted to whoever your server lets run it (see README), and
//    via the webpage's Admin tab, protected by ADMIN_SECRET.
//
// Run with: npm install && npm start

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
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

const DATA_FILE = path.join(__dirname, 'data.json');
const STATE_FILE = path.join(__dirname, 'state.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const ROSTER_MD = path.join(PUBLIC_DIR, 'roster.md');
const ROSTER_CSV = path.join(PUBLIC_DIR, 'roster.csv');
const ROSTER_JSON = path.join(PUBLIC_DIR, 'roster.json');

const MIN_NUMBER = 1;
const MAX_NUMBER = 999;
const LEAGUE_NAME = 'Southern Cross Sim Racing';
const DRIVER_ROLE_NAME = 'Iracing'; // Discord role granted to every registered driver

const {
  DISCORD_TOKEN,
  CLIENT_ID,
  GUILD_ID,
  ADMIN_SECRET,
  ALLOWED_ORIGIN,
  ROSTER_CHANNEL_ID, // optional: bot keeps a pinned roster message here
  SITE_URL,          // optional: link shown on the Discord roster message
  PORT,
} = process.env;

if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error('Missing DISCORD_TOKEN, CLIENT_ID, or GUILD_ID in your .env file. See .env.example.');
  process.exit(1);
}
if (!ADMIN_SECRET) {
  console.error('Missing ADMIN_SECRET in your .env file - this protects the Admin tab on the webpage.');
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
// roster shape:
//   { "7": { display: "07", name, iracing, discordId, discordUsername, ts } }
// The key is always the canonical number as a string.
function loadRoster() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}
function saveRosterToDisk(roster) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(roster, null, 2));
  publishRoster(roster);
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

let roster = loadRoster();

// simple in-process write lock so two near-simultaneous requests can't corrupt data
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

// Find an existing entry for a Discord user, so nobody claims two numbers.
function findEntryForDiscordUser(r, { discordId, discordUsername }) {
  const uname = (discordUsername || '').toLowerCase();
  for (const [key, e] of Object.entries(r)) {
    if (discordId && e.discordId === discordId) return { key, entry: e };
    if (uname && (e.discordUsername || '').toLowerCase() === uname) return { key, entry: e };
  }
  return null;
}

// ---------- The published roster document ----------
// Regenerated from data.json on every change. This is the single source of
// truth the website reads and the Discord message mirrors.
function formatStamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function csvCell(v) {
  const s = String(v === undefined || v === null ? '' : v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function renderRosterMarkdown(entries, stamp) {
  const lines = [];
  lines.push(`# ${LEAGUE_NAME} - Driver Roster`);
  lines.push('');
  lines.push(`${entries.length} driver${entries.length === 1 ? '' : 's'} registered. Last updated ${stamp}.`);
  lines.push('');
  lines.push('| Number | Driver (iRacing name) | Discord |');
  lines.push('| --- | --- | --- |');
  for (const e of entries) {
    lines.push(`| #${e.display} | ${e.name || ''} | ${e.discordUsername || '-'} |`);
  }
  if (entries.length === 0) lines.push('| - | No drivers registered yet | - |');
  lines.push('');
  lines.push('_Generated automatically. Do not edit by hand - changes are overwritten on the next signup._');
  lines.push('');
  return lines.join('\n');
}

function renderRosterCsv(entries) {
  const lines = ['number,driver_name,discord_username'];
  for (const e of entries) {
    lines.push([csvCell(e.display), csvCell(e.name || ''), csvCell(e.discordUsername || '')].join(','));
  }
  return lines.join('\n') + '\n';
}

// The public roster deliberately leaves out iRacing customer IDs. Those stay in
// data.json and the Admin tab only. Add `iracing: e.iracing` below if you want
// them published.
function publicRoster(r) {
  const stamp = new Date();
  const entries = rosterEntries(r).map((e) => ({
    number: e.display,
    canonical: e.canonical,
    name: e.name || '',
    discordUsername: e.discordUsername || '',
    ts: e.ts || null,
  }));
  return { updatedAt: stamp.toISOString(), updatedAtLabel: formatStamp(stamp), count: entries.length, drivers: entries };
}

function publishRoster(r) {
  try {
    if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });
    const doc = publicRoster(r);
    const entries = rosterEntries(r);
    fs.writeFileSync(ROSTER_MD, renderRosterMarkdown(entries, doc.updatedAtLabel));
    fs.writeFileSync(ROSTER_CSV, renderRosterCsv(entries));
    fs.writeFileSync(ROSTER_JSON, JSON.stringify(doc, null, 2));
  } catch (e) {
    console.error('Could not write roster document:', e.message);
  }
  scheduleDiscordRosterUpdate();
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

// ---------- Pinned roster message in Discord ----------
// Optional. Set ROSTER_CHANNEL_ID in .env to switch this on. The bot posts one
// message and edits it forever after, so the channel stays clean.
let rosterUpdateTimer = null;
function scheduleDiscordRosterUpdate() {
  if (!ROSTER_CHANNEL_ID) return;
  // Coalesce bursts (e.g. a bulk import) into a single edit.
  if (rosterUpdateTimer) clearTimeout(rosterUpdateTimer);
  rosterUpdateTimer = setTimeout(() => {
    rosterUpdateTimer = null;
    updateDiscordRoster().catch((e) => console.error('Discord roster update failed:', e.message));
  }, 1500);
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
    .setColor(0xf5b700)
    .setDescription(entries.length ? '```\n' + body + '\n```' : 'No drivers registered yet.')
    .setFooter({ text: `${entries.length} driver${entries.length === 1 ? '' : 's'} - updated ${stamp}` });
  if (SITE_URL) embed.addFields({ name: 'Claim a number', value: SITE_URL });
  return embed;
}

async function updateDiscordRoster() {
  if (!ROSTER_CHANNEL_ID || !client.isReady()) return;
  const current = loadRoster();
  const entries = rosterEntries(current);
  const embed = rosterEmbed(entries, formatStamp(new Date()));

  const channel = await client.channels.fetch(ROSTER_CHANNEL_ID).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    console.error('ROSTER_CHANNEL_ID does not point at a text channel the bot can see.');
    return;
  }

  const state = loadState();
  if (state.rosterMessageId) {
    const existing = await channel.messages.fetch(state.rosterMessageId).catch(() => null);
    if (existing) {
      await existing.edit({ embeds: [embed] });
      return;
    }
  }
  const sent = await channel.send({ embeds: [embed] });
  state.rosterMessageId = sent.id;
  saveState(state);
  await sent.pin().catch(() => {});
}

// ---------- Slash commands ----------
// Note: `number` is a STRING option, not an integer, so leading zeros survive.
const commands = [
  new SlashCommandBuilder()
    .setName('race')
    .setDescription('Register your race number for Southern Cross Sim Racing')
    .addStringOption((o) =>
      o.setName('number').setDescription('Race number, 1-999 (leading zeros allowed, e.g. 07)').setRequired(true)
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
    roster = loadRoster();
    const entries = rosterEntries(roster);
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
        content: `Number must be between ${MIN_NUMBER} and ${MAX_NUMBER}. Leading zeros are fine (07 works), but 0 is not a number.`,
        ephemeral: true,
      });
    }

    await interaction.deferReply({ ephemeral: true });

    await withLock(async () => {
      roster = loadRoster();

      const taken = roster[num.key];
      if (taken) {
        const asShown = taken.display !== num.display ? ` (registered as #${taken.display})` : '';
        return interaction.editReply(`#${num.display} is already taken${asShown} - try another number.`);
      }

      const mine = findEntryForDiscordUser(roster, {
        discordId: interaction.user.id,
        discordUsername: interaction.user.username,
      });
      if (mine) {
        return interaction.editReply(
          `You already have #${mine.entry.display}. Ask an admin if you want to change it.`
        );
      }

      const entry = {
        display: num.display,
        name,
        iracing,
        discordId: interaction.user.id,
        discordUsername: interaction.user.username,
        ts: Date.now(),
      };
      roster[num.key] = entry;
      saveRosterToDisk(roster);

      const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
      let nickMsg = '';
      let roleMsg = '';
      if (member) {
        const result = await setMemberNickname(member, name, num.display);
        nickMsg = result.ok
          ? ` Your nickname is now set to "${result.nickname}".`
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
      roster = loadRoster();
      const entries = rosterEntries(roster);
      if (entries.length === 0) return interaction.reply({ content: 'Roster is empty.', ephemeral: true });
      const lines = entries.map((e) => `#${e.display} - ${e.name} (${e.iracing})`);
      return interaction.reply({ content: lines.join('\n').slice(0, 1900), ephemeral: true });
    }

    if (sub === 'remove') {
      const num = parseRaceNumber(interaction.options.getString('number'));
      if (!num) return interaction.reply({ content: 'That is not a valid race number.', ephemeral: true });

      await withLock(async () => {
        roster = loadRoster();
        if (!roster[num.key]) {
          return interaction.reply({ content: `#${num.display} isn't taken.`, ephemeral: true });
        }
        const freed = roster[num.key].display;
        delete roster[num.key];
        saveRosterToDisk(roster);
        await interaction.reply({ content: `#${freed} has been freed up.`, ephemeral: true });
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
        roster = loadRoster();
        const entry = {
          display: num.display,
          name,
          iracing,
          discordId: discordUser ? discordUser.id : undefined,
          discordUsername: discordUser ? discordUser.username : undefined,
          ts: Date.now(),
        };
        roster[num.key] = entry;
        saveRosterToDisk(roster);

        let nickMsg = '';
        if (discordUser) {
          const member = await interaction.guild.members.fetch(discordUser.id).catch(() => null);
          if (member) {
            const result = await setMemberNickname(member, name, num.display);
            nickMsg = result.ok ? ` Nickname set to "${result.nickname}".` : ` (Couldn't set nickname - check bot role position.)`;
            await assignMemberRole(member);
          }
        }
        await interaction.reply({ content: `#${num.display} set to ${name}.${nickMsg}`, ephemeral: true });
      });
      return;
    }

    if (sub === 'sync') {
      await interaction.deferReply({ ephemeral: true });
      roster = loadRoster();
      let ok = 0, failed = 0;
      for (const key of Object.keys(roster)) {
        const entry = roster[key];
        entry.display = entry.display || key;
        const result = await tryResolveAndRename(interaction.guild, entry);
        if (result.ok) ok++; else failed++;
      }
      saveRosterToDisk(roster);
      await interaction.editReply(`Sync complete: ${ok} nicknames updated, ${failed} skipped (member not found or couldn't be renamed).`);
      return;
    }
  }
});

// A newly-joining member might already be on the roster (registered on the
// webpage before joining Discord) - apply their nickname as soon as they arrive.
client.on(Events.GuildMemberAdd, async (member) => {
  roster = loadRoster();
  for (const [key, entry] of Object.entries(roster)) {
    if (
      (entry.discordUsername && entry.discordUsername.toLowerCase() === member.user.username.toLowerCase()) ||
      entry.discordId === member.id
    ) {
      entry.discordId = member.id;
      entry.display = entry.display || key;
      await setMemberNickname(member, entry.name, entry.display);
      await assignMemberRole(member);
      saveRosterToDisk(roster);
      break;
    }
  }
});

// ---------- HTTP API for the signup webpage ----------
const app = express();
app.use(express.json());
app.use(cors({ origin: ALLOWED_ORIGIN === '*' ? true : ALLOWED_ORIGIN }));

// Public: the signup webpage itself, served from this same Render service so the
// page and its API share one origin (no CORS, no external URL to configure).
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'southern-cross-signup.html')));

function requireAdmin(req, res, next) {
  const secret = req.get('x-admin-secret');
  if (secret !== ADMIN_SECRET) return res.status(401).json({ error: 'Invalid admin passphrase' });
  next();
}

// Public: which numbers are taken. Returns canonical integers, so the webpage
// knows 1, 01 and 001 are all gone once any one of them is claimed.
app.get('/api/taken-numbers', (req, res) => {
  roster = loadRoster();
  res.json({
    taken: Object.keys(roster).map(Number),
    // display forms, keyed by canonical number, so we can say "taken as #01"
    displays: Object.fromEntries(Object.entries(roster).map(([k, e]) => [k, e.display || k])),
  });
});

// Public: the roster document, as JSON
app.get('/api/roster', (req, res) => {
  roster = loadRoster();
  res.json(publicRoster(roster));
});

// Public: the roster document as downloadable files
app.get('/roster.md', (req, res) => res.type('text/markdown').sendFile(ROSTER_MD));
app.get('/roster.csv', (req, res) => res.type('text/csv').sendFile(ROSTER_CSV));
app.get('/roster.json', (req, res) => res.type('application/json').sendFile(ROSTER_JSON));

// Public: register a number from the webpage
app.post('/api/register', async (req, res) => {
  const { name, iracing, discordUsername, number } = req.body || {};
  const num = parseRaceNumber(number);

  if (!name || !iracing || !discordUsername || number === undefined || number === '') {
    return res.status(400).json({ error: 'iRacing name, iRacing ID, Discord username and number are all required' });
  }
  if (!num) {
    return res.status(400).json({ error: `Number must be between ${MIN_NUMBER} and ${MAX_NUMBER}` });
  }

  await withLock(async () => {
    roster = loadRoster();

    const taken = roster[num.key];
    if (taken) {
      const asShown = taken.display !== num.display ? ` (registered as #${taken.display})` : '';
      return res.status(409).json({ error: `#${num.display} was just taken${asShown} - pick another number.` });
    }

    const cleanDiscord = String(discordUsername).trim();
    const mine = findEntryForDiscordUser(roster, { discordUsername: cleanDiscord });
    if (mine) {
      return res.status(409).json({
        error: `${cleanDiscord} already has #${mine.entry.display}. Ask an admin if you want to change it.`,
      });
    }

    const entry = {
      display: num.display,
      name: String(name).trim(),
      iracing: String(iracing).trim(),
      discordUsername: cleanDiscord,
      ts: Date.now(),
    };
    roster[num.key] = entry;
    saveRosterToDisk(roster);

    // Try to rename them immediately if they're already in the server
    const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
    let renamed = false;
    if (guild) {
      const result = await tryResolveAndRename(guild, entry);
      renamed = result.ok;
      saveRosterToDisk(roster);
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
});

// Admin: full roster (includes Discord info and iRacing customer IDs)
app.get('/api/admin/roster', requireAdmin, (req, res) => {
  roster = loadRoster();
  res.json({ roster });
});

// Admin: remove an entry
app.delete('/api/admin/roster/:number', requireAdmin, (req, res) => {
  const num = parseRaceNumber(req.params.number);
  if (!num) return res.status(400).json({ error: 'Not a valid race number' });

  withLock(async () => {
    roster = loadRoster();
    if (!roster[num.key]) return res.status(404).json({ error: 'Not found' });
    delete roster[num.key];
    saveRosterToDisk(roster);
    res.json({ ok: true });
  });
});

// Admin: bulk import (used by the "Bulk import" box on the webpage)
app.post('/api/admin/import', requireAdmin, async (req, res) => {
  const { rows } = req.body || {}; // rows: [{number, name, iracing, discordUsername}]
  if (!Array.isArray(rows)) return res.status(400).json({ error: 'rows must be an array' });

  await withLock(async () => {
    roster = loadRoster();
    let added = 0, skipped = 0;
    for (const row of rows) {
      const num = parseRaceNumber(row.number);
      if (!num) { skipped++; continue; }
      roster[num.key] = {
        display: num.display,
        name: row.name || '',
        iracing: row.iracing || '',
        discordUsername: row.discordUsername || '',
        ts: Date.now(),
      };
      added++;
    }
    saveRosterToDisk(roster);
    res.json({ ok: true, added, skipped });
  });
});

// Admin: re-apply nicknames for the whole roster on demand (same as /admin sync)
app.post('/api/admin/sync', requireAdmin, async (req, res) => {
  roster = loadRoster();
  const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
  if (!guild) return res.status(500).json({ error: 'Bot is not connected to the server yet' });

  let ok = 0, failed = 0;
  for (const key of Object.keys(roster)) {
    const entry = roster[key];
    entry.display = entry.display || key;
    const result = await tryResolveAndRename(guild, entry);
    if (result.ok) ok++; else failed++;
  }
  saveRosterToDisk(roster);
  res.json({ ok: true, updated: ok, failed });
});

// Admin: force a rebuild of the roster document and the pinned Discord message
app.post('/api/admin/publish', requireAdmin, async (req, res) => {
  roster = loadRoster();
  publishRoster(roster);
  res.json({ ok: true });
});

// ---------- Boot everything ----------
(async () => {
  await registerCommands();
  await client.login(DISCORD_TOKEN);
  client.once(Events.ClientReady, (c) => {
    console.log(`Bot logged in as ${c.user.tag}`);
    publishRoster(loadRoster()); // make sure the document exists on first boot
  });

  const port = PORT || 3000;
  app.listen(port, () => console.log(`API listening on port ${port}`));
})();
