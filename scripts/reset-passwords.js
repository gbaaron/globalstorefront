#!/usr/bin/env node
/**
 * scripts/reset-passwords.js — put passwords back in step, and flip to hashing.
 *
 * Two jobs:
 *
 *   node scripts/reset-passwords.js
 *       Reset the DEMO accounts back to their known passwords, so a persona you
 *       signed in as during testing works again next time. Touches only the
 *       accounts listed in scripts/demo-accounts.js.
 *
 *   node scripts/reset-passwords.js --rehash
 *       LAUNCH DAY. Convert every plain-text password in Clients and Users to
 *       bcrypt. Run this immediately after setting HASH_PASSWORDS=1 in Netlify.
 *       Rows that are already hashed are left alone, so it is safe to re-run.
 *
 * Flags:
 *   --dry     print the plan, change nothing
 *   --users   include the directory Users table (default for --rehash)
 */

const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
        const t = line.trim();
        if (t && !t.startsWith('#') && t.includes('=')) {
            const [k, ...v] = t.split('=');
            if (!process.env[k.trim()]) process.env[k.trim()] = v.join('=').trim();
        }
    }
}

const Airtable = require('airtable');
const { isHashed } = require('../netlify/functions/lib/password');
const DEMO_ACCOUNTS = require('./demo-accounts');

const REHASH = process.argv.includes('--rehash');
const DRY = process.argv.includes('--dry');
const INCLUDE_USERS = REHASH || process.argv.includes('--users');

const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function bcryptHash(pw) {
    const bcrypt = require('bcryptjs');
    return bcrypt.hash(String(pw), 10);
}

async function fetchAll(table) {
    const out = [];
    await base(table).select({ pageSize: 100 }).eachPage((records, next) => {
        records.forEach(r => out.push(r));
        next();
    });
    return out;
}

async function write(table, updates) {
    for (let i = 0; i < updates.length; i += 10) {
        await base(table).update(updates.slice(i, i + 10), { typecast: true });
        if (i + 10 < updates.length) await sleep(250);
    }
}

// ---------------------------------------------------------------------------

async function rehash() {
    console.log(`\nREHASH${DRY ? ' (DRY RUN)' : ''} — converting plain text to bcrypt\n`);

    if (process.env.HASH_PASSWORDS !== '1') {
        console.log('NOTE: HASH_PASSWORDS is not 1 in this environment.');
        console.log('      Rehashing still works — logins honour an existing hash either way —');
        console.log('      but set it in Netlify too, or new signups will keep writing plain text.\n');
    }

    let converted = 0, already = 0;

    for (const table of INCLUDE_USERS ? ['Clients', 'Users'] : ['Clients']) {
        const rows = await fetchAll(table);
        const updates = [];

        for (const r of rows) {
            const stored = r.get('PasswordHash') || '';
            const label = r.get('Company') || r.get('Name') || r.get('Email') || r.id;

            if (!stored) { console.log(`   - ${label} (no password set)`); continue; }
            if (isHashed(stored)) { already++; continue; }

            console.log(`   + ${table}: ${label}`);
            if (!DRY) updates.push({ id: r.id, fields: { PasswordHash: await bcryptHash(stored) } });
            converted++;
        }

        if (!DRY && updates.length) await write(table, updates);
    }

    console.log(`\n${'-'.repeat(46)}`);
    console.log(`Converted: ${converted}   Already hashed: ${already}`);
    console.log(`${'-'.repeat(46)}\n`);
    if (DRY) console.log('Dry run — nothing written.\n');
    else if (converted) console.log('Done. Those passwords are no longer readable — that is the point.\n');
}

// ---------------------------------------------------------------------------

async function resetDemos() {
    console.log(`\nRESET DEMO ACCOUNTS${DRY ? ' (DRY RUN)' : ''}\n`);

    if (process.env.HASH_PASSWORDS === '1') {
        console.log('HASH_PASSWORDS is 1 — the reset values will be written as bcrypt hashes.\n');
    }

    const rows = await fetchAll('Clients');
    const byEmail = new Map(rows.map(r => [String(r.get('Email') || '').toLowerCase(), r]));
    const byUsername = new Map(rows.map(r => [String(r.get('Username') || ''), r]));

    const updates = [];
    let missing = 0;

    for (const acct of DEMO_ACCOUNTS) {
        const rec = byEmail.get(String(acct.email || '').toLowerCase()) || byUsername.get(acct.username);
        if (!rec) {
            console.log(`   ! ${acct.username || acct.email} — no such account`);
            missing++;
            continue;
        }
        const value = process.env.HASH_PASSWORDS === '1'
            ? await bcryptHash(acct.password)
            : acct.password;

        console.log(`   = ${rec.get('Company') || rec.get('Name')} → ${acct.password}`);
        if (!DRY) updates.push({ id: rec.id, fields: { PasswordHash: value } });
    }

    if (!DRY && updates.length) await write('Clients', updates);

    console.log(`\nReset ${updates.length || (DRY ? DEMO_ACCOUNTS.length - missing : 0)}, missing ${missing}.\n`);
    if (DRY) console.log('Dry run — nothing written.\n');
}

(REHASH ? rehash() : resetDemos()).catch(e => {
    console.error('\nFailed:', e.message);
    process.exit(1);
});
