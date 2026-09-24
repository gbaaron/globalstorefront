#!/usr/bin/env node
/**
 * scripts/seed-regions.js — create the directory regions.
 *
 * Holland is live; the rest are planned. NOTHING is hardcoded to one city —
 * adding Alpena or Traverse City later is a row, not a deploy.
 *
 * Idempotent: a region with a matching Slug is left alone.
 *
 * Usage: node scripts/seed-regions.js [--dry]
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
const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);
const DRY = process.argv.includes('--dry');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const makeId = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const REGIONS = [
    {
        Name: 'Shop Holland',
        Slug: 'holland',
        City: 'Holland',
        State: 'MI',
        Kind: 'shop',
        Status: 'live',
        AccentColor: '#d4af37',
        Blurb: 'Every shop, restaurant and service in Holland — in one place. Follow the ones you love and hear from them first.'
    },
    {
        Name: 'Shop Alpena',
        Slug: 'alpena',
        City: 'Alpena',
        State: 'MI',
        Kind: 'shop',
        Status: 'planned',
        AccentColor: '#2563eb',
        Blurb: 'Alpena businesses, all in one place. Launching soon.'
    },
    {
        Name: 'Shop Traverse City',
        Slug: 'traverse-city',
        City: 'Traverse City',
        State: 'MI',
        Kind: 'shop',
        Status: 'planned',
        AccentColor: '#0891b2',
        Blurb: 'Traverse City businesses, all in one place. Launching soon.'
    },
    {
        Name: 'Vote Michigan',
        Slug: 'michigan',
        City: '',
        State: 'MI',
        Kind: 'vote',
        Status: 'planned',
        AccentColor: '#7c3aed',
        Blurb: 'Know who is on your ballot, and hear from them directly.'
    }
];

async function main() {
    console.log(`\nSeeding regions${DRY ? ' (DRY RUN)' : ''}\n`);

    const existing = [];
    await base('Regions').select({ pageSize: 100 }).eachPage((records, next) => {
        records.forEach(r => existing.push(r));
        next();
    });
    const bySlug = new Set(existing.map(r => r.get('Slug')));

    let created = 0, skipped = 0;
    for (const region of REGIONS) {
        if (bySlug.has(region.Slug)) {
            console.log(`  = ${region.Name} (exists)`);
            skipped++;
            continue;
        }
        if (DRY) {
            console.log(`  + ${region.Name} [${region.Status}]`);
            created++;
            continue;
        }
        const fields = Object.assign({
            RegionID: makeId('reg'),
            TenantCount: 0
        }, region);
        if (region.Status === 'live') fields.LaunchedAt = new Date().toISOString().split('T')[0];

        const rec = await base('Regions').create([{ fields }], { typecast: true });
        console.log(`  + ${region.Name} [${region.Status}] → ${rec[0].id}`);
        created++;
        await sleep(250);
    }

    console.log(`\nCreated: ${created}   Already present: ${skipped}\n`);
    if (DRY) console.log('Dry run — nothing written.\n');
}

main().catch(e => {
    console.error('\nSeed failed:', e.message);
    process.exit(1);
});
