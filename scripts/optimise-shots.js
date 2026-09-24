#!/usr/bin/env node
/**
 * scripts/optimise-shots.js — shrink captured screenshots for the web.
 *
 * Chrome writes PNG at the device scale factor, which for these came to about
 * 3.7MB across nine files. They are displayed between 500 and 900 CSS pixels
 * wide, so almost all of that was bytes nobody could see on a landing page
 * whose whole job is loading fast enough to be read.
 *
 * Requires `sips` (ships with macOS). Run after capture-product-shots.js.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DIR = path.join(__dirname, '..', 'assets', 'product');
const MAX_W = 1800;
const QUALITY = 'normal';   // sips quality step; ~82% equivalent

let before = 0, after = 0, n = 0;
for (const f of fs.readdirSync(DIR).filter(f => f.endsWith('.png'))) {
    const src = path.join(DIR, f);
    const out = src.replace(/\.png$/, '.jpg');
    before += fs.statSync(src).size;
    execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', QUALITY,
                          '-Z', String(MAX_W), src, '--out', out], { stdio: 'pipe' });
    after += fs.statSync(out).size;
    fs.unlinkSync(src);
    n++;
    console.log(`  ${path.basename(out)}`);
}
if (!n) { console.log('Nothing to optimise (no .png in assets/product).'); process.exit(0); }
console.log(`\n${n} files: ${Math.round(before/1024)}KB -> ${Math.round(after/1024)}KB\n`);
