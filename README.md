# @vidofy/mcp

[![npm](https://img.shields.io/npm/v/@vidofy/mcp?color=cb3837&logo=npm)](https://www.npmjs.com/package/@vidofy/mcp)
[![node](https://img.shields.io/badge/node-%E2%89%A518-5fa04e?logo=node.js&logoColor=white)](https://nodejs.org)
[![licence](https://img.shields.io/badge/licence-MIT-blue)](./LICENSE)
[![MCP](https://img.shields.io/badge/Model_Context_Protocol-server-6f42c1)](https://modelcontextprotocol.io)

**MCP server for [Vidofy](https://vidofy.ai)** — generate images, video, audio and speech from
Claude Desktop, Cursor, or any MCP client, **billed to your own Vidofy account**, at the same
prices the website charges.

Over 570 models, including **Veo 3.1**, **Kling 3.0**, **Flux 2**, **Seedance 2.5**, **Wan 2.7**,
**Hailuo 2.3**, **Runway**, **Luma Ray 2**, **Qwen Image 3.0**, **Vidu Q3** and **LTX 2** —
text-to-video, image-to-video, text-to-image, image editing, video and photo effects, lipsync,
text-to-speech and voice cloning. The agent browses the catalogue, prices a generation before
running it, and follows one to its result.

> **Status: v0.1.0, the first public release.**
>
> **This server is for personal Vidofy accounts.** It takes one credential,
> `VIDOFY_TOKEN`, and spends **your own coins** — the same balance the website
> spends, at the same prices. There is no other billing mode: `VIDOFY_API_KEY` is
> refused at startup, and that is a decision, not a feature waiting on a release.

## Tools

| Tool | What it does | Spends |
|---|---|---|
| `list_modes` | What Vidofy can generate: text-to-image, image-to-video, lipsync, speech… | no |
| `list_models` | The models in one mode, with each one's credit cost and rough duration | no |
| `get_model` | One model's full input contract: a JSON Schema, its file slots and their limits | no |
| `estimate_cost` | What a generation will cost, before running it | no |
| **`generate`** | **Runs it. The only tool that spends the balance.** | **yes** |
| `get_status` | Whether a generation has finished | no |
| `get_result` | The finished media | no |
| `get_balance` | Coins left, and how many expire with the subscription | no |
| `get_usage` | Recent generations and what they cost | no |

The usual order is `list_modes` → `list_models` → `get_model` → `estimate_cost` → `generate`
→ `get_status` → `get_result`.

`generate` is the only tool without `readOnlyHint`, which is what tells a client to ask the user
before running it. It charges at **submit**, not on success, and returns immediately with an id —
a generation takes from ~30 seconds to several minutes, so the agent polls `get_status` rather
than holding the call open. Output is **private by default**; pass `public: true` only when the
user asked for a permanent public link.

File inputs take a **path on the machine running the server**. The package reads the user's own
file and streams it with the submit — it never makes a temporary copy — and checks the extension
and size against that model's own limits first, so a file the server would reject never leaves
the disk.

**Not exposed, deliberately:** checkout, auto top-up, purchases, referrals, the daily reward.
Nothing in this package can buy coins or change a plan, however it is prompted.

## Setup

Create a personal MCP token at **vidofy.ai → Studio → Account → MCP Access**. It is shown once.

Then add the server to your client. Nothing to install — `npx` fetches it on first run:

```jsonc
// claude_desktop_config.json   (Cursor: .cursor/mcp.json — same shape)
{
  "mcpServers": {
    "vidofy": {
      "command": "npx",
      "args": ["-y", "@vidofy/mcp"],
      "env": { "VIDOFY_TOKEN": "vmt_..." }
    }
  }
}
```

Restart the client. Ask it to *"list Vidofy modes"* to confirm the connection, then
*"make me a 5-second clip of a red bicycle"* — it will price it before it runs it.

Prefer a pinned copy? `npm i -g @vidofy/mcp`, then:

```jsonc
{ "command": "vidofy-mcp", "env": { "VIDOFY_TOKEN": "vmt_..." } }
```

### Environment

| Variable | Required | What it does |
|---|---|---|
| `VIDOFY_TOKEN` | **yes** | Personal MCP token (`vmt_…`). Spends **your own Vidofy coins**, exactly as the studio does. |
| `VIDOFY_API_BASE` | no | Override the origin the server talks to — an **origin only**, no path. Defaults to `https://vidofy.ai`, which is what you want. |

`VIDOFY_API_KEY` is recognised only in order to be **refused**: a `vky_…` key bills a
different balance, which this server does not serve. Setting it stops startup with a message
naming the token to use instead — and setting *both* is refused too, since the two bill
different balances and no precedence rule is worth having to remember.

## Development

```bash
npm install
npm run build
npm run inspect      # MCP Inspector — spends nothing
```

`VIDOFY_API_BASE` points it at a different origin, if you are running one.

**Nothing here writes to stdout.** With stdio transport, stdout *is* the protocol channel — a
single stray `console.log()` puts a non-JSON line in the stream and the client drops the
connection with an error that explains nothing. Diagnostics go to stderr via the `log()` helper
in `src/index.ts`.

## Layout

```
src/config.ts          credential + mode + base URL, validated at startup
src/backend.ts         the only place that talks HTTP: auth, retries, multipart, errors
src/schema.ts          one model's m_options → a JSON Schema the agent can fill in
src/map/b2c.ts         both response shapes → one; strips the provider cost
src/tools/info.ts      list_modes, list_models, get_model
src/tools/generation.ts estimate_cost, generate, get_status, get_result
src/tools/account.ts   get_balance, get_usage
src/index.ts           the server: stdio transport, tool registration, annotations


server.json     MCP registry manifest (name must match package.json "mcpName")
```

## Licence

MIT
