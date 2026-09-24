/**
 * scripts/demo-accounts.js — the one place demo credentials are written down.
 *
 * Both the demo seeder and scripts/reset-passwords.js read this, so a password
 * you signed in with during testing can always be put back without hunting
 * through Airtable. Per the playbook, these stay plain text until launch.
 *
 * These are invented businesses in a demo directory. Do not add a real client
 * here.
 */

module.exports = [
    { username: 'dutch-oven-bakery',  email: 'dutch-oven-bakery@demo.globalstorefront.test',  password: 'demo1234' },
    { username: 'anchor-barbers',     email: 'anchor-barbers@demo.globalstorefront.test',     password: 'demo1234' },
    { username: 'windmill-cycles',    email: 'windmill-cycles@demo.globalstorefront.test',    password: 'demo1234' },
    { username: 'tulip-city-flowers', email: 'tulip-city-flowers@demo.globalstorefront.test', password: 'demo1234' },
    { username: 'big-lake-books',     email: 'big-lake-books@demo.globalstorefront.test',     password: 'demo1234' }
];
