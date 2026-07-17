// scripts/migrate-json-to-supabase.js
//
// One-off, idempotent migration of the legacy data.json roster into Supabase.
// Reads ../data.json if it exists, inserts each driver via db.claimNumber()
// (which relies on the unique constraints), and skips any row that already
// exists. Safe to run twice - the second run inserts nothing. Never deletes or
// modifies data.json.
//
// All database access goes through db.js, like the rest of the app.
//
// Run from the REPO ROOT so dotenv finds .env:
//   node scripts/migrate-json-to-supabase.js

const fs = require('fs');
const path = require('path');
const db = require('../db.js'); // also loads .env and fails fast if it's missing

const DATA_FILE = path.join(__dirname, '..', 'data.json');

async function main() {
  if (!fs.existsSync(DATA_FILE)) {
    console.log('No data.json found - nothing to migrate.');
    return;
  }

  let roster;
  try {
    roster = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    console.error(`Could not read data.json: ${e.message}`);
    process.exitCode = 1;
    return;
  }

  const keys = Object.keys(roster);
  console.log(`Found ${keys.length} driver${keys.length === 1 ? '' : 's'} in data.json.\n`);

  let inserted = 0;
  let skipped = 0;
  let errored = 0;
  let noTs = 0; // inserted rows that had no ts in data.json (join date defaulted to today)

  for (const key of keys) {
    const e = roster[key] || {};
    const canonical = Number(key);

    if (!Number.isInteger(canonical) || canonical < 1 || canonical > 999) {
      console.log(`  skip   #${key} - not a valid canonical number`);
      skipped++;
      continue;
    }

    const entry = {
      canonical,
      display: e.display || key,
      name: e.name || '',
      iracing: e.iracing || '',
      discordId: e.discordId || undefined,
      discordUsername: e.discordUsername || undefined,
      ts: e.ts, // preserved; entryToRow defaults it if absent
    };

    const missingTs = e.ts == null;

    try {
      const result = await db.claimNumber(entry);
      if (result.ok) {
        inserted++;
        if (missingTs) {
          noTs++;
          console.log(`  insert #${entry.display} ${entry.name} (no ts in data.json, join date set to today)`);
        } else {
          console.log(`  insert #${entry.display} ${entry.name}`);
        }
      } else {
        skipped++;
        console.log(`  skip   #${entry.display} - already exists (${result.reason})`);
      }
    } catch (err) {
      errored++;
      console.error(`  error  #${entry.display} - ${err.message}`);
    }
  }

  console.log(
    `\nDone. Inserted ${inserted}, skipped ${skipped}` +
    `${noTs ? `, ${noTs} with no ts (join date set to today)` : ''}` +
    `${errored ? `, errored ${errored}` : ''}.`
  );
  if (errored) process.exitCode = 1; // fail loud if anything unexpected happened
}

main()
  .then(() => process.exit(process.exitCode || 0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
