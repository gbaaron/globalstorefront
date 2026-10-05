#!/usr/bin/env node
/**
 * scripts/capture-work-wall.js — phone screenshots of the REAL client builds.
 *
 * The landing page used to sell Global Storefront with one invented bakery.
 * This shoots the builds that actually exist, at phone size, into
 * assets/work/ as WebP. index.html builds its hero wall and the "recent
 * builds" grid from these, so re-running this refreshes the page.
 *
 *   node scripts/capture-work-wall.js            # everything
 *   node scripts/capture-work-wall.js zeeland    # one build, by key prefix
 *   FORCE=1 node scripts/capture-work-wall.js    # re-shoot screens already saved
 *
 * Resume-safe: a screen already in assets/work/wall is left alone, so a run
 * cut short by a dropped connection can simply be started again.
 *
 * Requires Google Chrome and `cwebp` (brew install webp). A page that does not
 * answer 200 is skipped rather than photographed as a 404.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = path.join(__dirname, '..', 'assets', 'work');
const TMP = path.join(OUT, '.tmp');
const W = 390, H = 844;
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

// key -> origin + the pages worth showing. The first page (or
// `feature`, when the home page photographs badly) is the shot used in the
// builds grid; every page goes on the wall. A null keeps the
// numbering stable where a page was dropped for showing a placeholder photo or
// a failed load — a broken screen on the wall is worse than one fewer.
const BUILDS = [
    { key: 'zeeland',  feature: 1, origin: 'https://zeelandbakery.netlify.app',   pages: ['', 'menu.html', 'order-ahead.html', 'rewards.html?demo=true', 'about.html'] },
    { key: 'lacreme',  origin: 'https://lacrem.netlify.app',          pages: ['', 'menu.html', null, 'rewards.html?demo=true', null] },
    { key: 'sushi',    origin: 'https://sushigogo.netlify.app',       pages: ['', null, 'rewards.html?demo=true', null] },
    { key: 'bricks',   origin: 'https://bible-bricks-app.netlify.app', pages: ['', 'shop.html', 'drops.html', 'vote.html', 'build.html', 'rewards.html'] },
    { key: 'leelanau', origin: 'https://leelanau-cellars.netlify.app', pages: ['', 'shop.html', 'club.html', 'events.html', 'visit.html', null] },
    { key: 'fires',    origin: 'https://three-fires-golf.netlify.app', pages: ['', 'teetimes.html', 'course.html', 'shop.html', 'leagues.html', 'range.html'] },
    { key: 'cards',    origin: 'https://tc-sportscards.netlify.app',  pages: ['', 'shop.html', 'rewards.html?demo=true', 'about.html'] },
    { key: 'harvest',  origin: 'https://harvest-stand.netlify.app',   pages: ['', 'needs.html', 'give.html', 'events.html', 'volunteer.html'] }
];

function status(url) {
    try {
        return execFileSync('curl', ['-s', '-o', '/dev/null', '-m', '15', '-w', '%{http_code}', url]).toString().trim();
    } catch (e) { return '000'; }
}

function shoot(url, png) {
    execFileSync(CHROME, [
        '--headless=new', '--disable-gpu', '--hide-scrollbars',
        '--force-device-scale-factor=2',
        `--window-size=${W},${H}`,
        `--user-agent=${UA}`,
        '--virtual-time-budget=9000',
        `--screenshot=${png}`,
        url
    ], { stdio: 'pipe', timeout: 90000 });
}

function webp(png, out, width) {
    execFileSync('cwebp', ['-quiet', '-q', '80', '-resize', String(width), '0', png, '-o', out], { stdio: 'pipe' });
}

function main() {
    const only = process.argv[2];
    for (const d of ['wall', 'feature', '.tmp']) fs.mkdirSync(path.join(OUT, d), { recursive: true });

    let n = 0;
    for (const b of BUILDS.filter(b => !only || b.key.startsWith(only))) {
        b.pages.forEach((page, i) => {
            if (page === null) return;
            const url = `${b.origin}/${page}`;
            const name = `${b.key}_${i}`;
            if (!process.env.FORCE && fs.existsSync(path.join(OUT, 'wall', `${name}.webp`))) return;
            if (status(url) !== '200') { console.log(`  - ${name}  skipped (not 200)  ${url}`); return; }
            const png = path.join(TMP, `${name}.png`);
            try {
                shoot(url, png);
                webp(png, path.join(OUT, 'wall', `${name}.webp`), 300);
                if (i === (b.feature || 0)) webp(png, path.join(OUT, 'feature', `${b.key}.webp`), 500);
                n++;
                console.log(`  + ${name}  ${url}`);
            } catch (e) {
                console.log(`  ! ${name} failed: ${String(e.message).split('\n')[0]}`);
            }
        });
    }
    fs.rmSync(TMP, { recursive: true, force: true });
    console.log(`\n${n} screens captured into assets/work/\n`);
}

main();
