/**
 * Liveness reporting, for the operator's own process dashboard.
 *
 * WHY THIS EXISTS. The remote connector runs as a long-lived managed process,
 * and every such process on this platform is expected to report that it is
 * alive. The dashboard does not interrogate the process manager — it reads a
 * key the program writes for itself. A program that is registered and writes
 * nothing therefore shows as **down forever** and raises a CRITICAL alert on a
 * process that is perfectly healthy, which is worse than not registering it at
 * all: the one alert nobody can act on is the one that teaches people to ignore
 * the page.
 *
 * The contract is the same one every other worker on the platform writes, and
 * the platform is the reference if the two ever disagree:
 *
 *   value the unix timestamp, as a decimal string
 *   TTL   300s — deliberately longer than the dashboard's 120s down window, so a
 *         healthy program's key never expires between writes. Down-detection
 *         compares the STORED timestamp, not key presence, so an expired key and
 *         a stale one read the same.
 *   every 30s
 *
 * The `cache:` prefix is correct here, unlike `mcp_oauth:`: this value is a
 * report about something else, so an operator clearing the cache erases one
 * 30-second window and no state. A pending authorization erased would cost a
 * user their sign-in, which is why that one sits outside the prefix.
 */
import { redisClient } from './oauth/store.js';
import { log } from './log.js';

/** Matches the platform's own workers. The dashboard's window is 120s. */
const INTERVAL_MS = 30_000;
const TTL_SEC = 300;

/** The managed-process name — this IS the dashboard's key, so it must match. */
const PROGRAM = 'vidofy-mcp';

let timer: NodeJS.Timeout | null = null;
let warned = false;

async function beat(): Promise<void> {
    const client = await redisClient();
    await client.setEx(`cache:scheduled_tasks:hb:${PROGRAM}`, TTL_SEC, String(Math.floor(Date.now() / 1000)));
}

/**
 * Start reporting liveness. Safe to call twice; the second call does nothing.
 *
 * Failure here must never take the connector down — it is a report, not the
 * work. But it must not be silent either, because a silent failure looks exactly
 * like a dead process on the dashboard and would send someone to restart a
 * server that was serving traffic the whole time. So the first failure logs, and
 * the rest do not (a Redis outage would otherwise write a line every 30s
 * forever).
 */
export function startHeartbeat(): void {
    if (timer !== null) return;

    const tick = (): void => {
        beat().catch((err: unknown) => {
            if (warned) return;
            warned = true;
            log(`heartbeat failed, so the process dashboard will read this connector as DOWN `
                + `even while it serves traffic: ${err instanceof Error ? err.message : String(err)}`);
        });
    };

    tick();                                 // the dashboard should not wait 30s for the first one
    timer = setInterval(tick, INTERVAL_MS);
    /* Unreferenced so it can never be the reason the process stays alive — the
       HTTP server is what holds it open, and a lingering interval would keep a
       shutting-down process from exiting. */
    timer.unref();
}
