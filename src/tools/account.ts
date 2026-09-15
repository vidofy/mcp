/**
 * Account tools — what the balance is, and where it went.
 *
 * Both read-only. Neither can move money: the endpoints that could (checkout,
 * auto-topup, purchases) are deliberately not exposed by this package at all,
 * so an agent cannot buy coins on the user's behalf however it is prompted.
 */

import { z } from 'zod';

import type { Config } from '../config.js';
import { request } from '../backend.js';
import { stripProviderCost } from '../map/b2c.js';

const rec = (v: unknown): Record<string, unknown> =>
    v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const int = (v: unknown): number | null => {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v !== '' ? Number(v) : NaN;
    return Number.isFinite(n) ? n : null;
};

const str = (v: unknown): string | null => {
    if (v === null || v === undefined) return null;
    const s = String(v);
    return s === '' ? null : s;
};

/* ── get_balance ─────────────────────────────────────────────────────────── */

export async function getBalance(cfg: Config): Promise<unknown> {
    const payload = await request(cfg, { method: 'GET', path: 'account/balance' });
    const d = rec(rec(payload)['data']);

    if (cfg.mode === 'key') {
        /* Unreachable in practice — index.ts registers no tools in key mode, so
         * nothing can call this. Kept as a belt-and-braces answer in case a
         * future refactor registers the tools before checking the mode, and
         * worded like the startup refusal so the two cannot tell a user
         * different stories. Not a stub awaiting a phase: the server is for
         * personal accounts by decision (2026-09-11). */
        return {
            unit: 'credits',
            note: 'This server serves personal Vidofy accounts only, and reports the '
                + 'coin balance of the account whose token it holds.',
        };
    }

    const sub = rec(d['active_subscription']);
    const expiring = int(d['u_coins_expiring']) ?? 0;

    return {
        coins: int(d['u_coins']),
        unit: 'coins',
        /* Two numbers, because they answer different questions. Coins from a
           subscription expire when the cycle ends; bought or earned coins do
           not. An agent that reports only the total will tell someone they have
           plenty on the day most of it disappears. */
        coins_permanent: int(d['coins_permanent']),
        coins_expiring: expiring,
        coins_expire_at: expiring > 0 ? str(d['coins_expire_at']) : null,
        subscription: str(d['active_subscription']) === null && Object.keys(sub).length === 0
            ? null
            : {
                  plan: str(sub['plan_name']),
                  status: str(sub['status']),
                  renews_or_ends: str(sub['expires_at']),
                  cancel_at_period_end: sub['cancel_at_period_end'] === true,
              },
        account_status: str(d['u_status']),
        email: str(d['u_email']),
        /* Not a hint the agent can act on inside this server — nothing here
           can buy coins. It exists so a "you are out of coins" answer can tell
           the user where to go. */
        top_up_url: 'https://vidofy.ai/en/pricing',
    };
}

/* ── get_usage ───────────────────────────────────────────────────────────── */

export const getUsageInput = z.object({
    days: z
        .number()
        .int()
        .min(1)
        .max(365)
        .optional()
        .describe('How many days back to look. Default 30.'),
    limit: z.number().int().min(1).max(100).optional().describe('Rows to return. Default 20.'),
    offset: z.number().int().min(0).optional().describe('Rows to skip, for paging.'),
});

export async function getUsage(
    cfg: Config,
    args: { days?: number | undefined; limit?: number | undefined; offset?: number | undefined }
): Promise<unknown> {
    const payload = await request(cfg, {
        method: 'GET',
        path: 'account/usage',
        query: { days: args.days, limit: args.limit, offset: args.offset },
    });

    // Every field below has already been through the strip: usage carries
    // aul_api_cost per row and total_api_cost in the summary, both of which are
    // what Vidofy pays its providers.
    const root = rec(stripProviderCost(payload));
    const d = rec(root['data']);
    const summary = rec(d['summary']);
    const filters = rec(d['filters']);
    const items = Array.isArray(d['items']) ? d['items'] : [];

    return {
        window_days: int(filters['days']) ?? 30,
        unit: cfg.mode === 'account' ? 'coins' : 'credits',
        summary: {
            requests: int(summary['total_requests']),
            succeeded: int(summary['success_requests']),
            failed: int(summary['failed_requests']),
            still_running: int(summary['processing_requests']),
            spent: int(summary['total_coins_charged']) ?? int(summary['total_api_credits_charged']),
        },
        // `requests` above is a count over the whole window, not the size of
        // this page — so paging with offset is meaningful.
        items: items.map((raw) => {
            const r = rec(raw);
            return {
                /* aul_request_uid FIRST, and it is not a stylistic preference.
                 *
                 * The B2C usage endpoint renames its columns to the aul_* names
                 * for old mobile builds, and in doing so it exposes TWO ids:
                 * `media_id` is an internal integer key, `aul_request_uid` is
                 * the 25-character m_id. get_status and get_result look up by
                 * m_id, so
                 * returning the integer gives the agent an id that 404s on the
                 * very next call. Caught in adversarial review 2026-09-07;
                 * the fixture account has no usage rows, so no test had ever
                 * seen this mapping run on data. */
                id: str(r['aul_request_uid']) ?? str(r['m_id']) ?? str(r['media_id']),
                at: str(r['aul_created_at']) ?? str(r['created_at']) ?? str(r['m_time']),
                mode: str(r['aul_mode']) ?? str(r['m_mode']),
                model: str(r['aul_model_key']) ?? str(r['m_model_key']) ?? str(r['m_name']),
                status: str(r['aul_status']) ?? str(r['m_status']),
                spent: int(r['aul_coins_charged']) ?? int(r['m_coins']),
                error: str(r['aul_error_message']) ?? str(r['m_api_error']),
            };
        }),
    };
}
