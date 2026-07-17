// db.js - the ONLY module that talks to Supabase.
//
// Everything else in the codebase goes through the functions exported here;
// nothing else imports @supabase/supabase-js or touches the tables directly.
//
// Requires SUPABASE_URL and SUPABASE_SECRET_KEY in the environment. That secret
// key bypasses RLS (it may be a legacy service_role JWT or a new-style secret
// key) and must never be exposed to the browser.
//
// Tables (created out-of-band in the Supabase dashboard):
//   drivers(
//     canonical_number int   unique, check between 1 and 999,
//     display_number   text,
//     iracing_name     text,
//     iracing_id       text,
//     discord_user_id  text  nullable, unique partial index where not null,
//     discord_username text  unique index on lower(discord_username),
//     created_at       timestamptz
//   )
//   bot_state(key text primary key, value jsonb, updated_at timestamptz)
//
// JS <-> DB field mapping (the rest of the app speaks the JS shape):
//   display        <-> display_number
//   name           <-> iracing_name
//   iracing        <-> iracing_id
//   discordId      <-> discord_user_id   (undefined <-> null)
//   discordUsername<-> discord_username  (undefined <-> null)
//   ts (epoch ms)  <-> created_at        (converted both ways)

require('dotenv').config(); // self-contained: works even when required standalone
const { createClient } = require('@supabase/supabase-js');

const { SUPABASE_URL, SUPABASE_SECRET_KEY } = process.env;

// Fail fast, loudly, at load time - never print the values themselves.
if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  console.error(
    'Missing SUPABASE_URL or SUPABASE_SECRET_KEY in your .env file. ' +
    'Both are required for the database layer (db.js).'
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

// ---------- mapping helpers (not exported) ----------

// A drivers row -> the JS entry shape the rest of the app already uses.
// created_at (timestamptz) is converted back to epoch ms so roster output stays
// byte-for-byte identical to the old JSON version.
function rowToEntry(row) {
  return {
    canonical: row.canonical_number,
    display: row.display_number,
    name: row.iracing_name,
    iracing: row.iracing_id,
    discordId: row.discord_user_id == null ? undefined : row.discord_user_id,
    discordUsername: row.discord_username == null ? undefined : row.discord_username,
    ts: row.created_at ? new Date(row.created_at).getTime() : null,
  };
}

// A JS entry -> a drivers row for insert.
function entryToRow(entry) {
  return {
    canonical_number: entry.canonical,
    display_number: entry.display,
    iracing_name: entry.name,
    iracing_id: entry.iracing,
    discord_user_id: entry.discordId == null ? null : entry.discordId,
    discord_username: entry.discordUsername == null ? null : entry.discordUsername,
    created_at: new Date(entry.ts == null ? Date.now() : entry.ts).toISOString(),
  };
}

// Escape SQL LIKE wildcards so a username containing "_" or "%" is matched
// literally by ilike (Discord usernames legally contain underscores).
function escapeLike(s) {
  return String(s).replace(/[\\%_]/g, (m) => '\\' + m);
}

// ---------- roster reads ----------

// Whole roster as an object keyed by canonical number string, exactly the shape
// the old loadRoster() returned: { "7": { display, name, iracing, ... } }.
async function getRoster() {
  const { data, error } = await supabase
    .from('drivers')
    .select('*')
    .order('canonical_number', { ascending: true });
  if (error) throw error;
  const roster = {};
  for (const row of data) roster[String(row.canonical_number)] = rowToEntry(row);
  return roster;
}

// One driver by canonical number, or null.
async function getByCanonical(n) {
  const { data, error } = await supabase
    .from('drivers')
    .select('*')
    .eq('canonical_number', n)
    .maybeSingle();
  if (error) throw error;
  return data ? rowToEntry(data) : null;
}

// One driver by Discord user id, or null.
async function getByDiscordUser(id) {
  if (id == null) return null;
  const { data, error } = await supabase
    .from('drivers')
    .select('*')
    .eq('discord_user_id', id)
    .maybeSingle();
  if (error) throw error;
  return data ? rowToEntry(data) : null;
}

// One driver by Discord username, case-insensitive (matches the lower() index).
async function getByDiscordUsername(name) {
  if (!name) return null;
  const { data, error } = await supabase
    .from('drivers')
    .select('*')
    .ilike('discord_username', escapeLike(name))
    .maybeSingle();
  if (error) throw error;
  return data ? rowToEntry(data) : null;
}

// ---------- roster writes ----------

// Claim a number. Relies on the DB unique constraints, NOT a read-then-write
// check, so two simultaneous signups can never both win. Returns:
//   { ok: true, entry }
//   { ok: false, reason: 'number_taken' }        - canonical_number already used
//   { ok: false, reason: 'already_registered' }  - this Discord user/name has one
// A 23505 we do not recognise, and any other error, is thrown - never silently
// reported as a taken number.
async function claimNumber(entry) {
  const { data, error } = await supabase
    .from('drivers')
    .insert(entryToRow(entry))
    .select()
    .single();

  if (!error) return { ok: true, entry: rowToEntry(data) };

  if (error.code === '23505') {
    const blob = `${error.message || ''} ${error.details || ''}`.toLowerCase();
    if (blob.includes('discord_user_id') || blob.includes('discord_username')) {
      return { ok: false, reason: 'already_registered' };
    }
    if (blob.includes('canonical_number') || blob.includes('drivers_canonical_unique')) {
      return { ok: false, reason: 'number_taken' };
    }
    // An unrecognised unique violation - do NOT mislabel it as a taken number.
    throw error;
  }
  throw error;
}

// Delete the driver holding a canonical number. Returns the removed entry, or
// null if nobody held it.
async function removeByCanonical(n) {
  const { data, error } = await supabase
    .from('drivers')
    .delete()
    .eq('canonical_number', n)
    .select();
  if (error) throw error;
  return data && data.length ? rowToEntry(data[0]) : null;
}

// Backfill the cached Discord user id on a driver row (usernames are mutable,
// ids are not - without this a driver who renames after a website signup would
// become permanently unmatchable). Returns:
//   { ok: true }
//   { ok: false, reason: 'id_conflict' }  - that id already sits on another row
// The caller must carry on either way; only unexpected errors are thrown.
async function setDiscordUserId(canonical, discordUserId) {
  const { error } = await supabase
    .from('drivers')
    .update({ discord_user_id: discordUserId })
    .eq('canonical_number', canonical);
  if (!error) return { ok: true };
  if (error.code === '23505') return { ok: false, reason: 'id_conflict' };
  throw error;
}

// ---------- bot_state (jsonb key/value) ----------

// Read a state value (e.g. 'rosterMessageId'), or null if unset.
async function getState(key) {
  const { data, error } = await supabase
    .from('bot_state')
    .select('value')
    .eq('key', key)
    .maybeSingle();
  if (error) throw error;
  return data ? data.value : null;
}

// Upsert a state value.
async function setState(key, value) {
  const { error } = await supabase
    .from('bot_state')
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) throw error;
}

module.exports = {
  getRoster,
  getByCanonical,
  getByDiscordUser,
  getByDiscordUsername,
  claimNumber,
  removeByCanonical,
  setDiscordUserId,
  setState,
  getState,
};
