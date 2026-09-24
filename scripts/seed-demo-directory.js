#!/usr/bin/env node
/**
 * scripts/seed-demo-directory.js — a browsable Shop Holland for demos.
 *
 * Creates five demo tenants (identified by their @demo.globalstorefront.test
 * email, so the NAMES can stay realistic and the directory is presentable to a
 * prospect as-is) with hours, content and catalogue items, each on a
 * different combination of the two axes. That is the point: one directory page
 * showing a paid space, free listings, a link-out business and a tenant with
 * an app, so the model is visible rather than described.
 *
 *   node scripts/seed-demo-directory.js          # create
 *   node scripts/seed-demo-directory.js --clean  # remove every [demo] tenant
 *
 * Idempotent: re-running skips tenants that already exist by slug.
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
const CLEAN = process.argv.includes('--clean');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const mk = p => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2,8)}`;
const now = () => new Date().toISOString();

const WEEK = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];

const DEMOS = [
  {
    slug:'dutch-oven-bakery', company:'Dutch Oven Bakery',
    tagline:'Sourdough, stroopwafels and very good coffee since 1994.',
    color:'#9a5b28', siteType:'restaurant', address:'118 E 8th St, Holland, MI', phone:'(616) 555-0141',
    directory:'paid', website:true, websiteMode:'built', app:true, payment:'us', tier:'Concierge',
    hours:{ monday:['06:30','15:00'], tuesday:['06:30','15:00'], wednesday:['06:30','15:00'],
            thursday:['06:30','15:00'], friday:['06:30','17:00'], saturday:['07:00','16:00'], sunday:null },
    content:[
      { kind:'about', title:'About the bakery', body:'Three generations in the same brick building on 8th Street. We mill our own flour, proof overnight, and sell out most Saturdays by noon.\n\nIf the light is on, the ovens are running.' },
      { kind:'announcement', title:'Holiday stollen is back', body:'Pre-orders open now through December 20th. Limited to 200 loaves.' }
    ],
    items:[
      { name:'Country sourdough', price:7.50, cat:'Bread', desc:'48-hour ferment, blistered crust.', stock:14 },
      { name:'Stroopwafel, half dozen', price:12.00, cat:'Sweets', desc:'Pressed to order, caramel still warm.', stock:30 },
      { name:'Almond speculaas', price:4.25, cat:'Sweets', desc:'A Holland classic, done properly.', stock:0, status:'sold_out' },
      { name:'Morning bun', price:4.75, cat:'Pastry', desc:'Laminated, cardamom sugar.', stock:22 },
      { name:'Drip coffee', price:3.00, cat:'Drinks', desc:'Rotating single origin.', stock:99 }
    ]
  },
  {
    slug:'anchor-barbers', company:'Anchor Barbers',
    tagline:'Walk in, or book a chair. Six barbers, no rush.',
    color:'#1f4e6b', siteType:'service', address:'42 W 16th St, Holland, MI', phone:'(616) 555-0177',
    directory:'paid', website:true, websiteMode:'built', app:false, payment:'us', tier:'Growth',
    hours:{ monday:null, tuesday:['09:00','19:00'], wednesday:['09:00','19:00'], thursday:['09:00','20:00'],
            friday:['09:00','20:00'], saturday:['08:00','16:00'], sunday:null },
    content:[
      { kind:'about', title:'The shop', body:'Straight razors, hot towels, and a conversation if you want one. Six chairs, all of them ours.' }
    ],
    items:[
      { name:'Haircut', price:35.00, cat:'Cuts', desc:'Clipper or scissor, your call.', stock:99 },
      { name:'Cut & beard', price:50.00, cat:'Cuts', desc:'The full sit-down.', stock:99 },
      { name:'Hot towel shave', price:40.00, cat:'Shaves', desc:'Straight razor, twenty minutes.', stock:99 }
    ]
  },
  {
    slug:'windmill-cycles', company:'Windmill Cycles',
    tagline:'Bike shop on the lakeshore. Repairs while you wait.',
    color:'#2f6b3f', siteType:'product', address:'305 Ottawa Beach Rd, Holland, MI', phone:'(616) 555-0192',
    directory:'free', website:false, websiteMode:'none', app:false, payment:'theirs', tier:'Essentials',
    hours:{ monday:['10:00','18:00'], tuesday:['10:00','18:00'], wednesday:['10:00','18:00'],
            thursday:['10:00','18:00'], friday:['10:00','19:00'], saturday:['09:00','17:00'], sunday:['11:00','15:00'] },
    content:[
      { kind:'about', title:'About us', body:'We fix bikes. Tune-ups same day, most repairs while you wait. Rentals by the hour for the Lakeshore trail.' }
    ],
    items:[
      { name:'Tune-up', price:75.00, cat:'Service', desc:'Full drivetrain, brakes, true the wheels.', stock:99 },
      { name:'Flat repair', price:20.00, cat:'Service', desc:'Ten minutes, usually.', stock:99 },
      { name:'Day rental', price:35.00, cat:'Rentals', desc:'Hybrid or cruiser, helmet included.', stock:8 }
    ]
  },
  {
    slug:'tulip-city-flowers', company:'Tulip City Flowers',
    tagline:'Arrangements, weddings, and yes — actual tulips.',
    color:'#a8336b', siteType:'product', address:'77 River Ave, Holland, MI', phone:'(616) 555-0108',
    directory:'free', website:true, websiteMode:'linked', websiteUrl:'https://example.com/tulip-city',
    app:false, payment:'theirs', tier:'Essentials',
    hours:{ monday:['09:00','17:00'], tuesday:['09:00','17:00'], wednesday:['09:00','17:00'],
            thursday:['09:00','17:00'], friday:['09:00','18:00'], saturday:['09:00','14:00'], sunday:null },
    content:[],
    items:[]
  },
  {
    slug:'big-lake-books', company:'Big Lake Books',
    tagline:'Independent bookshop. Strong opinions, shelf-talkers to match.',
    color:'#6b4f9a', siteType:'product', address:'210 College Ave, Holland, MI', phone:'(616) 555-0163',
    directory:'paid', website:true, websiteMode:'built', app:false, payment:'us', tier:'Growth',
    hours:{ monday:['10:00','18:00'], tuesday:['10:00','18:00'], wednesday:['10:00','18:00'],
            thursday:['10:00','20:00'], friday:['10:00','20:00'], saturday:['10:00','20:00'], sunday:['12:00','17:00'] },
    content:[
      { kind:'about', title:'About the shop', body:'Twelve thousand titles in a narrow storefront on College Avenue. We host a reading most Thursdays and a book club that argues.' },
      { kind:'announcement', title:'Thursday readings are back', body:'Local authors, 7pm, free. Wine if someone brings it.' }
    ],
    items:[
      { name:'Staff pick — hardcover', price:28.00, cat:'Books', desc:'Whatever we are pushing this month.', stock:12 },
      { name:'Gift card', price:25.00, cat:'Gifts', desc:'Any amount, actually.', stock:99 }
    ],
    events:[
      { title:'Thursday reading: local fiction', days:5, capacity:40, desc:'Three local authors, twenty minutes each. Stay for the arguing.' },
      { title:'Book club: the long one', days:12, capacity:16, desc:'We are doing the 900-page one. No, you do not have to finish it.' }
    ]
  }
];

async function findRegion(slug){
  const r = await base('Regions').select({ filterByFormula:`{Slug} = '${slug}'`, maxRecords:1 }).firstPage();
  return r[0] || null;
}

async function clean(){
  console.log('\nRemoving demo tenants…\n');
  const rows = [];
  // Keyed off the demo email domain, not the name — the names are deliberately
  // realistic so the directory can be shown to a prospect as-is.
  await base('Clients').select({ filterByFormula:`FIND('@demo.globalstorefront.test', {Email}) > 0` }).eachPage((r,n)=>{ r.forEach(x=>rows.push(x)); n(); });

  for (const t of rows){
    for (const table of ['TenantContent','TenantHours','Items','Events','Bookings','PushBroadcasts','Follows','PointsLedger']){
      try {
        const kids = [];
        await base(table).select({ filterByFormula:`{TenantID} = '${t.id}'` }).eachPage((r,n)=>{ r.forEach(x=>kids.push(x.id)); n(); });
        for (let i=0;i<kids.length;i+=10){ await base(table).destroy(kids.slice(i,i+10)); await sleep(220); }
        if (kids.length) console.log(`  - ${kids.length} ${table}`);
      } catch(e){ /* table may be empty */ }
    }
    await base('Clients').destroy([t.id]);
    console.log(`  removed ${t.get('Company')}`);
    await sleep(220);
  }
  console.log(`\nRemoved ${rows.length} demo tenants.\n`);
}

async function main(){
  if (CLEAN) return clean();

  const region = await findRegion('holland');
  if (!region){ console.error('Shop Holland not found — run seed-regions.js first.'); process.exit(1); }

  console.log(`\nSeeding demo tenants into ${region.get('Name')}…\n`);

  const existing = [];
  await base('Clients').select({}).eachPage((r,n)=>{ r.forEach(x=>existing.push(x.get('Slug'))); n(); });

  let made = 0;
  for (const d of DEMOS){
    if (existing.includes(d.slug)){ console.log(`  = ${d.company} (exists)`); continue; }

    const rec = await base('Clients').create([{ fields:{
      Name: d.company,
      Company: d.company,
      Email: `${d.slug}@demo.globalstorefront.test`,
      Username: d.slug,
      PasswordHash: 'demo1234',
      Slug: d.slug,
      Tagline: d.tagline,
      BrandColor: d.color,
      SiteType: d.siteType,
      Address: d.address,
      Phone: d.phone,
      WebsiteURL: d.websiteUrl || '',
      RegionID: region.id,
      DirectoryStatus: d.directory,
      HasWebsite: d.website,
      WebsiteMode: d.websiteMode,
      HasApp: d.app,
      PaymentChannel: d.payment,
      MonetizationMode: d.payment === 'us' ? 'percent_of_sale' : 'flat_monthly',
      Tier: d.tier,
      BillingCycle: 'annual',
      SubStatus: 'active',
      SubStartDate: new Date().toISOString().split('T')[0],
      CreatedAt: now()
    }}], { typecast:true });
    const id = rec[0].id;

    // hours — every day, so the space renders a full week
    const hours = WEEK.map(day => {
      const h = d.hours[day];
      return { fields:{
        HoursID: mk('hrs'), TenantID:id, Day:day,
        OpenTime: h ? h[0] : '', CloseTime: h ? h[1] : '', Closed: !h
      }};
    });
    for (let i=0;i<hours.length;i+=10){ await base('TenantHours').create(hours.slice(i,i+10), { typecast:true }); await sleep(230); }

    if (d.content.length){
      await base('TenantContent').create(d.content.map((c,i)=>({ fields:{
        ContentID: mk('cnt'), TenantID:id, Kind:c.kind, Title:c.title, Body:c.body,
        SortOrder:i, Status:'published', CreatedAt:now(), UpdatedAt:now()
      }})), { typecast:true });
      await sleep(230);
    }

    if (d.items.length){
      for (let i=0;i<d.items.length;i+=10){
        await base('Items').create(d.items.slice(i,i+10).map((it,j)=>({ fields:{
          ItemID: mk('itm'), TenantID:id, Name:it.name, Description:it.desc||'',
          Price:it.price, Category:it.cat||'', Status:it.status||'active',
          SortOrder:i+j, StockCount:it.stock||0, CreatedAt:now()
        }})), { typecast:true });
        await sleep(230);
      }
    }

    if (d.events && d.events.length){
      await base('Events').create(d.events.map(e => {
        const when = new Date(Date.now() + e.days*86400000);
        when.setHours(19,0,0,0);
        return { fields:{
          EventID: mk('evt'), TenantID:id, Title:e.title, Description:e.desc,
          StartsAt: when.toISOString(), Capacity:e.capacity, SignupCount:Math.floor(e.capacity*0.4),
          Price:0, Status:'published', CreatedAt:now()
        }};
      }), { typecast:true });
      await sleep(230);
    }

    console.log(`  + ${d.company}  [${d.directory} listing · ${d.website?d.websiteMode:'no site'}${d.app?' · app':''} · pay:${d.payment}]`);
    made++;
  }

  // keep the region's denormalised count honest
  const inRegion = [];
  await base('Clients').select({
    filterByFormula:`AND({RegionID} = '${region.id}', OR({DirectoryStatus}='free',{DirectoryStatus}='paid'))`
  }).eachPage((r,n)=>{ r.forEach(x=>inRegion.push(x)); n(); });
  await base('Regions').update([{ id:region.id, fields:{ TenantCount: inRegion.length } }], { typecast:true });

  console.log(`\nCreated ${made}. Shop Holland now lists ${inRegion.length} businesses.`);
  console.log('Browse: /directory.html?region=holland\n');
}

main().catch(e => { console.error('\nSeed failed:', e.message); process.exit(1); });
