/**
 * One line of diagnostics, on stderr.
 *
 * WHY STDERR, ALWAYS: on the stdio transport, stdout IS the protocol. A single
 * stray `console.log` there is framed as a JSON-RPC message, the client fails to
 * parse it, and the connection dies with an error that names nothing. There is no
 * "just this once" for stdout in this package.
 *
 * WHY ITS OWN MODULE, as of 2026-09-13: it used to live in index.ts, which every
 * other module already imports FROM — so `tools/generation.ts` importing `log` from
 * index.ts made a cycle (index → tools/generation → index). It happened to work,
 * because `log` is only called from inside functions that run long after both
 * modules are evaluated, and that is exactly the kind of "works by luck" that
 * breaks the first time somebody logs something at module top level. A leaf module
 * with no imports of its own cannot participate in a cycle at all.
 *
 * index.ts re-exports it so existing callers keep working.
 */
export function log(message: string): void {
    process.stderr.write(`[vidofy-mcp] ${message}\n`);
}
