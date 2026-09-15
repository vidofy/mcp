/**
 * Where the server points, and which credential it carries.
 *
 * ONE credential, ONE door — never both. The two modes bill different wallets:
 *
 *   VIDOFY_TOKEN   (vmt_…)  → the user's own coins      (account mode — served)
 *   VIDOFY_API_KEY (vky_…)  → a different balance       (key mode — refused)
 *
 * Mixing them would mean a caller could not tell which balance a generation
 * was going to spend until after it spent it, so a request carrying both is
 * refused at startup rather than resolved by precedence.
 *
 * Key mode is DETECTED but NOT SERVED, and that is the settled shape of the
 * product rather than a gap (owner decision, 2026-09-11): this server is for
 * personal Vidofy accounts and spends their own coins. It is detected only so
 * that a key can be refused with an explanation instead of failing later as an
 * unexplained 401.
 *
 * Detected rather than ignored so that someone who sets VIDOFY_API_KEY is told
 * where to go, instead of watching the server start and then fail on every
 * call. See the refusal in index.ts.
 */

/** Which wallet this process will spend from. */
export type Mode = 'account' | 'key';

export interface Config {
    mode: Mode;
    /** The raw credential. Never logged, never echoed in a tool result. */
    credential: string;
    /** Origin only, no trailing slash — e.g. https://vidofy.ai */
    baseUrl: string;
    /** Sent on every request so usage can be attributed. */
    userAgent: string;
    version: string;
    /**
     * This connector's own canonical resource (RFC 8707), when the credential
     * came from an OAuth flow.
     *
     * Declared to /app/v1 on every call so the server can check the token's
     * audience. Undefined for the stdio package and for a
     * hand-made token, and that absence is meaningful rather than missing: it
     * pairs with a token that declares no resource, and a hand-made token is refused at a
     * connector precisely because the connector always declares one.
     */
    resource?: string;
}

export class ConfigError extends Error {}

const DEFAULT_BASE = 'https://vidofy.ai';

/**
 * Read the environment into a Config, or throw a message a human can act on.
 *
 * @param env  Defaults to process.env; injectable so this is testable without
 *             mutating the real environment.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, version = '0.0.0'): Config {
    const token = (env['VIDOFY_TOKEN'] ?? '').trim();
    const apiKey = (env['VIDOFY_API_KEY'] ?? '').trim();

    if (token !== '' && apiKey !== '') {
        throw new ConfigError(
            'Both VIDOFY_TOKEN and VIDOFY_API_KEY are set. They bill different balances — ' +
            'your personal coins and the API credit wallet — so pick one and remove the other.'
        );
    }
    if (token === '' && apiKey === '') {
        throw new ConfigError(
            'No credential. Set VIDOFY_TOKEN to a personal MCP token from ' +
            'https://vidofy.ai/en/studio/account/mcp-tokens (this bills your own Vidofy coins).'
        );
    }

    const mode: Mode = token !== '' ? 'account' : 'key';
    const credential = token !== '' ? token : apiKey;

    /* Catch a swapped credential HERE rather than as a 401 on the first call.
       The prefixes are the server's own: vmt_ for a personal MCP token,
       vky_ for a partner API key. */
    if (mode === 'account' && !credential.startsWith('vmt_')) {
        throw new ConfigError(
            'VIDOFY_TOKEN does not look like a personal MCP token (they start with "vmt_"). ' +
            (credential.startsWith('vky_')
                ? 'That looks like an API key — set it as VIDOFY_API_KEY instead.'
                : 'Create one at https://vidofy.ai/en/studio/account/mcp-tokens')
        );
    }
    if (mode === 'key' && !credential.startsWith('vky_')) {
        throw new ConfigError(
            'VIDOFY_API_KEY does not look like an API key (they start with "vky_"). ' +
            (credential.startsWith('vmt_')
                ? 'That looks like a personal MCP token — set it as VIDOFY_TOKEN instead.'
                : 'Find yours in the API platform on vidofy.ai')
        );
    }

    return {
        mode,
        credential,
        baseUrl: resolveBaseUrl(env),
        version,
        // Recorded server-side against the request in key mode and against the
        // token in account mode, which is how "how much traffic came from MCP"
        // is answered without any new tracking.
        userAgent: `vidofy-mcp/${version}`,
    };
}

/**
 * A Config for ONE `vmt_` token, with the origin still taken from the process
 * environment.
 *
 * This exists for the remote transport, where the two halves of a Config arrive
 * from different places and at different times: the origin is server
 * configuration, fixed at boot, while the credential belongs to whoever is
 * making this particular request. loadConfig cannot serve that case — it reads
 * the credential from the environment, which in a multi-user process would mean
 * every caller spending one account's coins.
 *
 * The prefix check is deliberately the SAME one loadConfig applies. A remote
 * caller pasting `vky_` into an Authorization header deserves the answer the
 * local user gets, not a 401 that says nothing.
 *
 * @throws ConfigError — the caller turns it into a 401 with a readable message.
 */
export function configForToken(
    token: string,
    env: NodeJS.ProcessEnv = process.env,
    version = '0.0.0',
    resource?: string
): Config {
    const credential = token.trim();
    if (credential === '') {
        throw new ConfigError('No bearer token. Send Authorization: Bearer vmt_… with every request.');
    }
    if (!credential.startsWith('vmt_')) {
        throw new ConfigError(
            credential.startsWith('vky_')
                ? 'That is an API key (vky_…). This connector serves personal Vidofy accounts and bills '
                  + 'your own coins — set VIDOFY_TOKEN (vmt_…) instead, from '
                  + 'https://vidofy.ai/en/studio/account/mcp-tokens.'
                : 'Not a personal MCP token. They start with "vmt_" — create one at '
                  + '/en/studio/account/mcp-tokens.'
        );
    }
    return {
        mode: 'account',
        credential,
        baseUrl: resolveBaseUrl(env),
        version,
        userAgent: `vidofy-mcp/${version}`,
        ...(resource !== undefined && resource !== '' ? { resource } : {}),
    };
}

/**
 * Validate and normalise VIDOFY_API_BASE.
 *
 * Factored out of loadConfig so the remote transport cannot end up with a
 * weaker check than the local one — the checks below are the whole reason a
 * hostile value in claude_desktop_config.json cannot redirect a credential, and
 * a second copy of them would be a second chance to get one wrong.
 */
export function resolveBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
    // VIDOFY_API_BASE exists for development against a local instance. Trailing
    // slashes are stripped so callers can join paths without doubling them.
    const baseUrl = ((env['VIDOFY_API_BASE'] ?? '').trim() || DEFAULT_BASE).replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(baseUrl)) {
        throw new ConfigError(`VIDOFY_API_BASE must start with http:// or https:// — got "${baseUrl}"`);
    }
    /* The scheme check alone is not a check.
     *
     * This value is set in claude_desktop_config.json, which people copy and
     * paste from install snippets they found somewhere — so it is exactly the
     * field a hostile snippet would target, and the credential goes wherever it
     * points. Measured, all of these passed the scheme test:
     *
     *   https://vidofy.ai@evil.example  → host is evil.example; the token ships there
     *   http://vidofy.ai                → the vmt_ token crosses the network in clear
     *   https://vidofy.ai/#             → every path lands on the homepage instead
     *   https://vidofy.ai?x=1           → same, and nothing says why
     *
     * The last two are not attacks, just silent breakage — which is worse to
     * diagnose than a refusal at startup. */
    let parsedBase: URL;
    try {
        parsedBase = new URL(baseUrl);
    } catch {
        throw new ConfigError(`VIDOFY_API_BASE is not a valid URL — got "${baseUrl}"`);
    }
    if (parsedBase.username !== '' || parsedBase.password !== '') {
        throw new ConfigError(
            `VIDOFY_API_BASE must not contain a username or password. In "${baseUrl}" the real ` +
            `host is "${parsedBase.host}", not what appears before the "@".`
        );
    }
    /* Tested on the RAW string, not on the parsed parts: a bare "#" produces
       an empty `hash`, so `parsedBase.hash !== ''` waves through
       "https://vidofy.ai/#" — which then swallows every path appended to it
       and sends the whole API to the homepage. */
    /* Whitespace is rejected on the RAW string too. WHATWG URL silently strips
       a newline, so "https://vidofy.ai\nevil" parses as host `vidofy.aievil`
       while the value a user skims in claude_desktop_config.json still reads
       as vidofy.ai — the same smuggling this block exists to stop. */
    if (/\s/.test(baseUrl)) {
        throw new ConfigError('VIDOFY_API_BASE must not contain whitespace or line breaks.');
    }
    if (/[?#]/.test(baseUrl) || parsedBase.pathname !== '/') {
        throw new ConfigError(
            `VIDOFY_API_BASE must be an origin only — no path, query or fragment. Got "${baseUrl}".`
        );
    }
    /* URL.hostname keeps the brackets on an IPv6 literal — `new URL('http://[::1]')`
       gives '[::1]', not '::1' — so comparing against the bare form refused
       IPv6 loopback although it is listed right here as allowed. Strip them
       once and compare. `.localhost` and `.test` are RFC 6761 loopback/testing
       names, and host.docker.internal is how a container reaches this host;
       all three are development, none reaches the internet. */
    const host = parsedBase.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const localHost =
        host === 'localhost' ||
        host === '127.0.0.1' ||
        host === '::1' ||
        host === 'host.docker.internal' ||
        host.endsWith('.local') ||
        host.endsWith('.localhost') ||
        host.endsWith('.test');
    if (parsedBase.protocol !== 'https:' && !localHost) {
        throw new ConfigError(
            `VIDOFY_API_BASE must use https:// — "${baseUrl}" would send your credential in clear text. ` +
            'Plain http is accepted only for localhost and .local development hosts.'
        );
    }

    // The parsed origin, not the raw string — so whatever survived the checks
    // above is still normalised to scheme://host[:port] before anything
    // concatenates a path onto it.
    return parsedBase.origin;
}

/** The credential header for this mode. Kept next to loadConfig so the two cannot drift. */
export function authHeaders(cfg: Config): Record<string, string> {
    const creds = cfg.mode === 'account'
        ? { Authorization: `Bearer ${cfg.credential}` }
        : { 'X-API-Key': cfg.credential };
    /* The audience travels with the credential because it is part of deciding
       whether the credential is valid HERE — see Config.resource. Omitted
       entirely when there is none, since an empty header and no header are the
       same thing to the reader but not to a proxy. */
    return cfg.resource !== undefined && cfg.resource !== ''
        ? { ...creds, 'X-Vidofy-MCP-Resource': cfg.resource }
        : creds;
}

/** `/app/v1` or `/api/v1` — the door this mode speaks to. */
export function apiPrefix(cfg: Config): string {
    return cfg.mode === 'account' ? '/app/v1' : '/api/v1';
}
