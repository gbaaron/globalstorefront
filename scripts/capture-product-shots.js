#!/usr/bin/env node
/**
 * scripts/capture-product-shots.js — screenshot the REAL running product.
 *
 * The landing page used to sell the product with hand-built <div> mockups:
 * fake browser chrome, fake reward cards, gradient blocks where the pastry
 * photos should be. That is the single loudest "an AI built this" tell — the
 * page drew the *category* of a rewards screen instead of showing the actual
 * one, which exists and runs.
 *
 * This captures the actual screens from the actual dev server, so the marketing
 * page shows the product rather than an impression of it. Re-run it whenever
 * the UI changes and the landing page updates itself.
 *
 * Requires the dev server (npx netlify dev) on :8888 and the demo directory
 * seeded (node scripts/seed-demo-directory.js).
 *
 *   node scripts/capture-product-shots.js
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ORIGIN = 'http://localhost:8888';
const OUT = path.join(__dirname, '..', 'assets', 'product');

// Chrome writes PNG. The landing page ships JPEG at 1800px wide — the shots
// are captured at 2x but displayed at ~500-900 CSS px, so the full-size PNGs
// were ~3.7MB of bytes nobody could see. optimise() converts and resizes.

// A tenant whose dashboard is worth showing: every surface, paid listing.
const DEMO_USER = 'dutch-oven-bakery';
const DEMO_PASS = 'demo1234';

const SHOTS = [
    { name: 'directory-holland', url: `${ORIGIN}/directory.html?region=holland`, w: 1440, h: 900, wait: 5000 },
    { name: 'space-bakery',      url: `${ORIGIN}/space.html?s=dutch-oven-bakery`, w: 1440, h: 900, wait: 5000 },
    { name: 'directory-phone',   url: `${ORIGIN}/directory.html?region=holland`, w: 402, h: 820, wait: 5000, mobile: true },
    { name: 'space-phone',       url: `${ORIGIN}/space.html?s=dutch-oven-bakery`, w: 402, h: 820, wait: 5000, mobile: true },
    { name: 'dashboard-home',    url: `${ORIGIN}/dashboard.html`, w: 1440, h: 900, wait: 6000, auth: true },
    { name: 'dashboard-reach',   url: `${ORIGIN}/dashboard.html#reach`, w: 1440, h: 900, wait: 6500, auth: true },
    { name: 'dashboard-loyalty', url: `${ORIGIN}/dashboard.html#loyalty`, w: 1440, h: 900, wait: 7000, auth: true },
    { name: 'dashboard-bookings',url: `${ORIGIN}/dashboard.html#bookings`, w: 1440, h: 900, wait: 7000, auth: true },
    { name: 'dashboard-insights',url: `${ORIGIN}/dashboard.html#insights`, w: 1440, h: 900, wait: 7500, auth: true }
];

/**
 * The authed screens need a token in localStorage, and localStorage is
 * per-origin — so the seeder has to be SERVED from the same origin. This writes
 * a throwaway page at the web root that signs in, stores the session, then
 * forwards to the real screen. It is deleted in a finally block.
 */
const SEED_PATH = path.join(__dirname, '..', '__shot-seed.html');

function writeSeed(target) {
    fs.writeFileSync(SEED_PATH, `<!DOCTYPE html><meta charset="utf-8"><body style="background:#0f0f1a">
<script>
(async () => {
  const r = await fetch('/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: ${JSON.stringify(DEMO_USER)}, password: ${JSON.stringify(DEMO_PASS)} })
  });
  const d = await r.json();
  localStorage.setItem('gs_token', d.token);
  localStorage.setItem('gs_biz', JSON.stringify({
    name: d.name, company: d.company, projectUrl: d.projectUrl, username: d.username,
    slug: d.slug, tier: d.tier, billingCycle: d.billingCycle, subStatus: d.subStatus,
    caps: d.caps || [], regionId: d.regionId, surfaces: d.surfaces || {},
    directoryStatus: d.directoryStatus || 'none', paymentChannel: d.paymentChannel || 'none'
  }));
  location.replace(${JSON.stringify(target)});
})();
</script></body>`);
}

function capture(shot) {
    const out = path.join(OUT, `${shot.name}.png`);
    const url = shot.auth ? `${ORIGIN}/__shot-seed.html` : shot.url;

    if (shot.auth) writeSeed(shot.url);

    const args = [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--force-device-scale-factor=2',          // retina, so it stays crisp when scaled down
        `--window-size=${shot.w},${shot.h}`,
        `--virtual-time-budget=${shot.wait}`,
        `--screenshot=${out}`,
        url
    ];
    if (shot.mobile) args.splice(1, 0, '--force-device-scale-factor=3');

    try {
        execFileSync(CHROME, args, { stdio: 'pipe', timeout: 60000 });
        const kb = Math.round(fs.statSync(out).size / 1024);
        console.log(`  + ${shot.name}.png  ${shot.w}x${shot.h}  ${kb}KB`);
        return true;
    } catch (e) {
        console.log(`  ! ${shot.name} failed: ${String(e.message).split('\n')[0]}`);
        return false;
    }
}

function main() {
    if (!fs.existsSync(CHROME)) {
        console.error('Google Chrome not found at the expected path.');
        process.exit(1);
    }
    fs.mkdirSync(OUT, { recursive: true });

    console.log('\nCapturing the real product…\n');
    let ok = 0;
    try {
        for (const shot of SHOTS) if (capture(shot)) ok++;
    } finally {
        if (fs.existsSync(SEED_PATH)) fs.unlinkSync(SEED_PATH);
    }
    console.log(`\n${ok}/${SHOTS.length} captured into assets/product/`);
    console.log('Now run:  node scripts/optimise-shots.js   (PNG -> JPEG @1800px)\n');
}

main();
