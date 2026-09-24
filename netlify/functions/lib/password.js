/**
 * lib/password.js — the ONLY place that decides how passwords are stored.
 *
 * Passwords are PLAIN TEXT while building, behind a switch. This is a standing
 * instruction, not an oversight: hashing is one-way, so a password typed into
 * Airtable to test a screen cannot be read back, and a login handler that
 * silently upgrades a hand-seeded row to a digest makes that password
 * single-use. On a spec build the thing being protected is a table of invented
 * accounts, and the cost of hashing is paid every single day.
 *
 *   HASH_PASSWORDS unset / '0'  → plain text        (build state)
 *   HASH_PASSWORDS = '1'        → bcrypt on write   (launch state)
 *
 * An existing hash is ALWAYS honoured, whichever way the flag is set, so
 * toggling never locks anybody out. Only what gets WRITTEN changes.
 *
 * ---------------------------------------------------------------------------
 * >>> SET HASH_PASSWORDS=1 BEFORE THE FIRST REAL MEMBER SIGNS UP. <<<
 * ---------------------------------------------------------------------------
 * The directory gives Global Storefront a second, much larger user population —
 * ordinary shoppers, who reuse passwords everywhere. Every day the flag is off
 * after that launch is a day real people's passwords sit legible in a
 * spreadsheet. Flip it before Phase 4 goes live, and run
 * `node scripts/reset-passwords.js --rehash` to convert existing rows.
 */

const HASH_PASSWORDS = () => process.env.HASH_PASSWORDS === '1';

/** Does this stored value look like a bcrypt digest? */
function isHashed(stored) {
    return typeof stored === 'string' && /^\$2[aby]\$\d{2}\$/.test(stored);
}

/** Hash for storage — plain text while the flag is off. */
async function hashPassword(pw) {
    if (!HASH_PASSWORDS()) return String(pw);
    const bcrypt = require('bcryptjs');
    return bcrypt.hash(String(pw), 10);
}

/**
 * Verify a submitted password against whatever is stored.
 * Honours an existing hash regardless of the flag.
 */
async function checkPassword(pw, stored) {
    if (isHashed(stored)) {
        const bcrypt = require('bcryptjs');
        return bcrypt.compare(String(pw), stored);
    }
    return String(stored || '') !== '' && String(stored) === String(pw);
}

/**
 * Should this row be migrated to a hash after a successful plain-text login?
 * Only when the flag is on — otherwise a test login would silently burn the
 * seeded password.
 */
function shouldMigrate(stored) {
    return HASH_PASSWORDS() && !isHashed(stored);
}

module.exports = { HASH_PASSWORDS, isHashed, hashPassword, checkPassword, shouldMigrate };
