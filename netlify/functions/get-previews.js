const T = require('./lib/tenants');

/**
 * GET /api/get-previews — every client build, for Aaron's master page.
 *
 * The same job as Global Media's function of the same name: list the Clients
 * rows, read each build's showcase.json server-side, and hand master.html a
 * link that opens the app signed in as each role.
 *
 * Aaron's master account signs in through the normal client login, so its
 * token carries role 'client'. This gates on WHO the token belongs to. Keep
 * MASTER_EMAILS in step with admin-login.js.
 */

const MASTER_EMAILS = (process.env.MASTER_EMAILS || 'globallyballinspam@gmail.com')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

// Client showcase sites serve no CORS headers, so the browser cannot read showcase.json
// itself. Resolving it here server-side is the only way the master page learns what roles
// a build offers.
async function fetchJson(url, ms = 4500) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
        const res = await fetch(url, { signal: ctrl.signal });
        if (!res.ok) return { error: `HTTP ${res.status}` };
        return { data: await res.json() };
    } catch (err) {
        return { error: err.name === 'AbortError' ? 'Timed out' : 'Unreachable' };
    } finally {
        clearTimeout(timer);
    }
}

// Persona notes are authored as HTML in showcase.json. The master page renders them as
// text, so flatten the markup rather than passing tags through.
function plain(value) {
    return String(value || '')
        .replace(/<[^>]*>/g, '')
        .replace(/&mdash;/g, '—')
        .replace(/&ndash;/g, '–')
        .replace(/&nbsp;/g, ' ')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim();
}

// A build declares its ultra admin by saying so in the persona note (Three Fires does).
// Where nothing is declared, the last keyed persona is the highest role the build offers
// — flagged as undeclared so the page does not overstate it.
function pickUltra(personas) {
    const keyed = personas.filter(p => p.key);
    if (!keyed.length) return null;
    const declared = keyed.find(p => /ultra[\s-]*admin/i.test(p.note || ''));
    const chosen = declared || keyed[keyed.length - 1];
    return { key: chosen.key, label: chosen.label, declared: Boolean(declared) };
}

async function resolveBuild(projectUrl) {
    if (!projectUrl) return { reachable: false, error: 'No project URL on the record' };

    let origin;
    try {
        origin = new URL(projectUrl).origin;
    } catch (err) {
        return { reachable: false, error: 'Project URL is not a valid URL' };
    }

    const { data, error } = await fetchJson(`${origin}/showcase.json`);
    if (error) {
        return { reachable: false, origin, error: `showcase.json ${error}` };
    }

    const appUrl = new URL(data.appHome || '/index.html', origin).href;
    const personas = (Array.isArray(data.personas) ? data.personas : []).map(p => ({
        key: p.key || '',
        label: p.label || (p.key ? p.key : 'Visitor'),
        note: plain(p.note)
    }));
    const ultra = pickUltra(personas);

    return {
        reachable: true,
        origin,
        appName: data.name || '',
        appUrl,
        personas: personas.map(p => ({
            ...p,
            url: appUrl + (p.key ? `?demo=${encodeURIComponent(p.key)}` : ''),
            isUltra: Boolean(ultra && p.key && p.key === ultra.key)
        })),
        ultra: ultra
            ? { ...ultra, url: `${appUrl}?demo=${encodeURIComponent(ultra.key)}` }
            : null,
        error: null
    };
}

exports.handler = async (event) => {
    const guard = T.guardMethod(event, ['GET']);
    if (guard) return guard;

    const decoded = T.decodeToken(event);
    if (!decoded) return T.unauthorized('Sign in with the master login', 'GET');
    const viewer = String(decoded.email || '').toLowerCase();
    if (decoded.role !== 'admin' && !MASTER_EMAILS.includes(viewer)) {
        return T.forbidden('Master access required', 'GET');
    }

    try {
        const records = await T.getBase()(T.TABLES.TENANTS).select({ pageSize: 100 }).all();

        // A build is a row with somewhere to go. The master row itself, the
        // internal portal logins (relative URLs) and the seeded demo-directory
        // tenants (no URL at all) are not builds.
        const builds = records.map(r => ({
            id: r.id,
            name: r.get('Name') || '',
            email: r.get('Email') || '',
            username: r.get('Username') || '',
            company: r.get('Company') || '',
            projectUrl: r.get('ProjectURL') || '',
            clientType: r.get('SiteType') || '',
            status: r.get('SubStatus') || '',
            createdAt: r.get('CreatedAt') || '',
            lastLogin: r.get('LastLogin') || '',
            notes: r.get('Notes') || ''
        }))
            .filter(c => /^https?:\/\//i.test(c.projectUrl))
            .filter(c => !MASTER_EMAILS.includes(c.email.toLowerCase()))
            .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

        const clients = await Promise.all(builds.map(async (client) => ({
            ...client,
            build: await resolveBuild(client.projectUrl)
        })));

        return T.ok({ viewer: decoded.email || '', clients }, 'GET');
    } catch (error) {
        return T.serverError(error, 'GET');
    }
};
