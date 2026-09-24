const fs = require('fs');
const path = require('path');

// Load .env
const envPath = path.join(__dirname, '..', '.env');
for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
  const t = line.trim();
  if (t && !t.startsWith('#') && t.includes('=')) {
    const [k, ...v] = t.split('=');
    if (!process.env[k.trim()]) process.env[k.trim()] = v.join('=').trim();
  }
}

const KEY = process.env.AIRTABLE_API_KEY;
const BASE = process.env.AIRTABLE_BASE_ID;

(async () => {
  // Field schemas
  const r = await fetch(`https://api.airtable.com/v0/meta/bases/${BASE}/tables`, {
    headers: { Authorization: `Bearer ${KEY}` }
  });
  const j = await r.json();
  const want = ['Clients', 'PageViews', 'Conversations', 'Messages', 'Suggestions',
    'SocialPosts', 'Reports', 'EmailCampaigns', 'StrategyCalls', 'DevHours', 'Transactions'];
  for (const t of j.tables) {
    if (!want.includes(t.name)) continue;
    console.log(`\n=== ${t.name} (${t.id}) ===`);
    for (const f of t.fields) {
      let opts = '';
      if (f.options && f.options.choices) {
        opts = ' {' + f.options.choices.map(c => c.name).join(' | ') + '}';
      }
      console.log(`  ${f.name} :: ${f.type}${opts}`);
    }
  }

  // Existing clients
  console.log('\n\n=== EXISTING CLIENTS ===');
  const cr = await fetch(`https://api.airtable.com/v0/${BASE}/Clients?maxRecords=50`, {
    headers: { Authorization: `Bearer ${KEY}` }
  });
  const cj = await cr.json();
  for (const rec of (cj.records || [])) {
    const f = rec.fields;
    console.log(`- ${f.Name || '(no name)'} | user=${f.Username || '-'} | email=${f.Email || '-'} | tier=${f.Tier || '-'} | baseId=${f.BaseID || '(none)'} | site=${f.SiteType || '-'} | url=${f.ProjectURL || '-'}`);
  }
})().catch(e => console.log('ERR', e.message));
