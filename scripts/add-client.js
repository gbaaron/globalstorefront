#!/usr/bin/env node
/**
 * scripts/add-client.js — add one client login to the Clients table.
 *
 * Writes the password exactly as given. It deliberately does NOT go through
 * lib/password.js: a login made here is one Aaron hands to a client, so it has
 * to stay readable in Airtable whatever HASH_PASSWORDS is set to.
 *
 *   node scripts/add-client.js <username> <password> <email> "<Company>" <projectUrl>
 *
 * Idempotent: an existing username or email is reported and left untouched.
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

(async () => {
    const [username, password, email, company, projectUrl] = process.argv.slice(2);
    if (!username || !password || !email || !company || !projectUrl) {
        console.error('usage: node scripts/add-client.js <username> <password> <email> "<Company>" <projectUrl>');
        process.exit(1);
    }
    const table = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID)('Clients');

    const esc = s => String(s).replace(/'/g, "\\'");
    const existing = await table.select({
        filterByFormula: `OR({Username} = '${esc(username)}', LOWER({Email}) = '${esc(email.toLowerCase())}')`,
        maxRecords: 1
    }).firstPage();
    if (existing.length) {
        console.log(`Already exists (${existing[0].id}) — left untouched.`);
        return;
    }

    const slug = company.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const created = await table.create([{
        fields: {
            Name: company,
            Company: company,
            Email: email.toLowerCase(),
            Username: username,
            PasswordHash: String(password),      // plain text, on purpose
            ProjectURL: projectUrl,
            Slug: slug,
            CreatedAt: new Date().toISOString(),
            HasWebsite: true,
            WebsiteMode: 'built',
            DirectoryStatus: 'none',             // a preview login, not a directory listing
            PaymentChannel: 'none',
            MonetizationMode: 'flat_monthly'
        }
    }], { typecast: true });

    const stored = created[0].get('PasswordHash');
    console.log(`Created ${created[0].id}  username=${username}  stored plain text: ${stored === String(password)}`);
})().catch(e => { console.error(e.message); process.exit(1); });
