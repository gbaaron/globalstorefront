#!/usr/bin/env node
/**
 * scripts/migrate-tenants.js — backfill existing Clients rows onto the two-axis model.
 *
 * Every row that predates the revamp has a Tier but no axis fields. Because
 * resolveCapabilities() falls back to the tier preset, those rows ALREADY work —
 * this script just makes the implicit explicit, so Aaron can then diverge a
 * tenant from its preset in the admin UI.
 *
 * IDEMPOTENT: a row that already has DirectoryStatus set is left alone unless
 * --force is passed. Re-running after a partial failure is safe.
 *
 * Usage:
 *   node scripts/migrate-tenants.js --dry     # show the plan
 *   node scripts/migrate-tenants.js           # apply
 *   node scripts/migrate-tenants.js --force   # re-derive even migrated rows
 *   node scripts/migrate-tenants.js --region holland   # also set RegionID
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
const C = require('../netlify/functions/lib/capabilities');
const { normalizeTier } = require('../netlify/functions/lib/tiers');

const DRY = process.argv.includes('--dry');
const FORCE = process.argv.includes('--force');
const regionFlag = process.argv.indexOf('--region');
const REGION_SLUG = regionFlag > -1 ? process.argv[regionFlag + 1] : null;

const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function slugify(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').substring(0, 60);
}

async function findRegionId(slug) {
    if (!slug) return null;
    const rows = await base('Regions').select({
        filterByFormula: `{Slug} = '${String(slug).replace(/'/g, "\\'")}'`,
        maxRecords: 1
    }).firstPage();
    return rows.length ? rows[0].id : null;
}

async function main() {
    console.log(`\nTenant migration${DRY ? ' (DRY RUN)' : ''}${FORCE ? ' [FORCE]' : ''}`);

    let regionId = null;
    if (REGION_SLUG) {
        regionId = await findRegionId(REGION_SLUG);
        if (!regionId) {
            console.error(`Region "${REGION_SLUG}" not found. Run seed-regions.js first.`);
            process.exit(1);
        }
        console.log(`Region: ${REGION_SLUG} → ${regionId}`);
    }

    const rows = [];
    await base('Clients').select({ pageSize: 100 }).eachPage((records, next) => {
        records.forEach(r => rows.push(r));
        next();
    });
    console.log(`Found ${rows.length} tenant rows.\n`);

    let migrated = 0, skippedCount = 0, errors = 0;
    const updates = [];

    for (const record of rows) {
        const label = record.get('Company') || record.get('Name') || record.id;
        const alreadyMigrated = !!record.get('DirectoryStatus');

        if (alreadyMigrated && !FORCE) {
            console.log(`  = ${label} — already migrated (DirectoryStatus: ${record.get('DirectoryStatus')})`);
            skippedCount++;
            continue;
        }

        const tier = normalizeTier(record.get('Tier'));
        const preset = C.presetForTier(tier);
        const fields = {};

        // Only fill what's genuinely absent — never clobber a hand-set value.
        const setIfEmpty = (key, value) => {
            const current = record.get(key);
            if (FORCE || current === undefined || current === null || current === '') {
                fields[key] = value;
            }
        };

        setIfEmpty('HasWebsite', preset.HasWebsite);
        setIfEmpty('WebsiteMode', preset.WebsiteMode);
        setIfEmpty('HasApp', preset.HasApp);
        setIfEmpty('DirectoryStatus', preset.DirectoryStatus);
        setIfEmpty('PaymentChannel', preset.PaymentChannel);
        setIfEmpty('MonetizationMode', preset.MonetizationMode);
        setIfEmpty('Slug', slugify(record.get('Company') || record.get('Name') || record.id));
        if (regionId) setIfEmpty('RegionID', regionId);

        if (Object.keys(fields).length === 0) {
            skippedCount++;
            continue;
        }

        // Preview the capability set this row will resolve to.
        const preview = C.resolveCapabilities(Object.assign(
            { Tier: tier },
            Object.fromEntries(record.fields ? Object.entries(record.fields) : []),
            fields
        ));

        console.log(`  + ${label} [${tier}]`);
        console.log(`      surfaces: website=${fields.HasWebsite ?? record.get('HasWebsite')}(${fields.WebsiteMode ?? record.get('WebsiteMode')}) app=${fields.HasApp ?? record.get('HasApp')}`);
        console.log(`      directory: ${fields.DirectoryStatus ?? record.get('DirectoryStatus')}   payment: ${fields.PaymentChannel ?? record.get('PaymentChannel')}`);
        console.log(`      → ${preview.length} capabilities`);

        updates.push({ id: record.id, fields });
        migrated++;
    }

    if (DRY) {
        console.log(`\nDry run — nothing written.\n${migrated} would migrate, ${skippedCount} skipped.\n`);
        return;
    }

    // Write in chunks of 10, throttled for Airtable's 5 req/s cap.
    for (let i = 0; i < updates.length; i += 10) {
        const chunk = updates.slice(i, i + 10);
        try {
            await base('Clients').update(chunk, { typecast: true });
        } catch (e) {
            console.error(`  ! chunk at ${i} failed: ${e.message}`);
            errors += chunk.length;
            migrated -= chunk.length;
        }
        if (i + 10 < updates.length) await sleep(250);
    }

    console.log(`\n${'-'.repeat(48)}`);
    console.log(`Migrated: ${migrated}   Skipped: ${skippedCount}   Errors: ${errors}`);
    console.log(`${'-'.repeat(48)}\n`);
}

main().catch(e => {
    console.error('\nMigration failed:', e.message);
    process.exit(1);
});
