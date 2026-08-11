# Claude Session Viewer

A small React + Node tool that wires a UI to **Claude Code sessions** so you can *see the decision-making*: the prompt, the reasoning ("why"), every tool call and which file/command/URL it touched ("what"), the result, and the conclusions — as a live or historical **decision map**. It can also start, resume, and manage sessions.

It reads Claude Code's own transcript store (`~/.claude/projects/<project>/<session-id>.jsonl`), so it works for **any** project on the machine it runs on — that machine's sessions show up automatically.

---

## Run it yourself

Anyone can run their own copy — it only ever reads **its own machine's** `~/.claude/projects`, so two people running it are fully isolated (different machines, different data, nothing shared).

```bash
git clone <this-repo-url> claude-session-viewer
cd claude-session-viewer
npm install      # installs web + server (npm workspaces)
npm run check    # compatibility preflight — tells you what's ready
npm run dev      # server on 127.0.0.1:3737, web on :5273
```

Open <http://localhost:5273>.

**Prerequisites**

- **Node 18+** (built and tested on Node 24).
- The **`claude` CLI** on your PATH — only needed to *start/resume* sessions from the UI. Reading and visualizing existing sessions works without it.
- You've used **Claude Code** on the machine at least once (so `~/.claude/projects` exists).

## Compatibility

`npm run check` reports all of this for your machine. Summary:

| Area | Status |
| --- | --- |
| **Reading / visualizing** (parse transcripts, decision map, files, diffs, cost, context meter, review export) | ✅ Windows · macOS · Linux — pure Node file reads, no OS assumptions |
| **Starting / resuming sessions** (spawns the `claude` CLI) | ✅ **Windows** (built + tested). ⚠️ **macOS / Linux**: should work (the prompt is piped via stdin, paths derive from `os.homedir()`), but not yet verified there — test the **New session** button before relying on it. |
| Node | 18+ (24 recommended) |

Nothing is hardcoded to a specific user or path — `SESSIONS_ROOT`, `CLAUDE_BIN`, `HOST`, `PORT` are all environment-overridable (see Configuration).

## What you get

- **Sidebar** — every session on the machine, searchable, running sessions float to top with a live ⟳ spinner and a "N running" count. Delete a session from its card (🗑 → confirm).
- **Decision map** — prompt → 💭 reasoning → 🔧 tool call (file/command/url) → ✓/✗ result → 💬 conclusion. Clickable stats/tool-badges focus the timeline; auto-scrolls to the latest row; per-tool spinner while a call is in flight.
- **Files tab** — every file read/edited/written, filter by action, and a **git-style diff** for each Write/Edit.
- **Cost + context** — per-session token cost (priced per model, cache-aware; unknown models estimated by tier), rolling 5h/24h/7d usage, and a **context-window meter** showing how close the session is to auto-compaction.
- **Live "working" indicator** — driven by the CLI process lifetime, so it stays lit through the thinking phase and clears only when the turn truly ends.
- **New session / follow-up** — start or resume a session (model + permission-mode picker, directory browser), then **live-tail** it. The prompt is piped via stdin, so multi-line pastes and shell characters are safe.
- **Review export** — a de-noised Markdown trace at `/api/sessions/:id/review.md` for a human or another agent to review.

## How it works

```
claude CLI ──writes──▶  ~/.claude/projects/<slug>/<id>.jsonl
                                   │
                        chokidar file-watch
                                   │
     server (Express)  parse+normalize JSONL ──▶  /api/… (+ SSE live-tail + activity)
                                   │
     web (React + Vite)  decision map / files / cost / review
```

Key modules: `server/src/transcript.ts` (parser), `pricing.ts` / `context.ts` / `usage.ts` (cost + context), `launch.ts` (spawn/resume via stdin), `activity.ts` (process-lifetime "working" signal), `web/src/diff.ts` (line diff).

## Configuration

| Env var | Default | Meaning |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Interface to bind. Loopback by default so the RCE-capable endpoints aren't reachable from the network. For remote access, set to your Tailscale IP (never `0.0.0.0`). |
| `PORT` | `3737` | Server port. |
| `SESSIONS_ROOT` | `~/.claude/projects` | Where transcripts live. Point it anywhere. |
| `CLAUDE_BIN` | `claude` | Path to the Claude Code CLI used to launch/resume. |
| `CORS_ORIGINS` | `http://localhost:5273,http://127.0.0.1:5273` | Comma-separated browser origins allowed to call the API. |
| `AUTH_MODE` | `off` | `tailscale` requires a `Tailscale-User-Login` header (injected by `tailscale serve`, unforgeable) in `ALLOWED_LOGINS`. Gates every request. Fails closed. |
| `ALLOWED_LOGINS` | — | Comma-separated Tailscale logins allowed when `AUTH_MODE=tailscale` (e.g. `you@example.com`). |
| `AUTO_COMPACT_PCT` | `0.92` | Estimated fraction of the context window at which Claude Code auto-compacts (the real trigger isn't stored locally). |
| `CONTEXT_WINDOW_OVERRIDES` | — | JSON map of model→window tokens for unknown models. |
| `PRICING_OVERRIDES` | — | JSON map of model→`{input,output}` $/Mtok to override built-in rates. |

## ⚠️ Security — read before exposing it anywhere

The **New session / resume** endpoints spawn a `claude` agent on the host: with `acceptEdits`/`bypassPermissions` that **writes files and runs commands** — effectively remote code execution as your user. `/api/fs` reads arbitrary directories. **Do not port-forward or bind this to a public interface.**

By default the server binds **loopback only** (`127.0.0.1`), so it's reachable only from the machine itself. To use it from your phone, put the laptop and phone on a private network (**Tailscale**) and set `HOST` to the tailnet IP — never `0.0.0.0`, never a router port-forward. A hardened remote-access design (Tailscale + a passkey/OIDC login + per-action confirmation + a low-privilege agent account) is the recommended path before any remote use; see `docs/` if present, or ask.

## Phone access over Tailscale (remote mode)

Reach the viewer from your phone with the laptop left on — **privately, over your tailnet, with identity auth**. No public exposure, no port-forwarding. The app is gated by your Tailscale identity: Tailscale injects a `Tailscale-User-Login` header it **strips from any client-supplied value** (so it can't be forged), and the app admits only logins in `ALLOWED_LOGINS`.

### A. One-time setup

1. **Install Tailscale** on the laptop and phone; sign in with the **same account** so both join one tailnet. Verify:
   ```bash
   tailscale status      # should list both devices, same owner, nobody else
   ```
2. In the **Tailscale admin console → DNS** (<https://login.tailscale.com/admin/dns>) enable both:
   - **MagicDNS** (gives your machine a name)
   - **HTTPS Certificates** (required for the `https://` URL — without it, cert provisioning fails and the page times out)
3. Find your **machine's name** and **login** (needed below):
   ```bash
   tailscale status --json     # Self.DNSName  ->  https://<machine>.<tailnet>.ts.net
                               # your login    ->  the tailnet owner, e.g. you@example.com
   ```
4. **Windows:** if `tailscale` isn't recognized in your terminal, add it to PATH (new terminals):
   ```powershell
   [Environment]::SetEnvironmentVariable('Path', ([Environment]::GetEnvironmentVariable('Path','User').TrimEnd(';') + ';C:\Program Files\Tailscale'), 'User')
   ```
   …or just prefix commands with `& "C:\Program Files\Tailscale\tailscale.exe"`.

### B. Every time you want phone access

1. **Build the UI** (once, and after any code change):
   ```bash
   npm run build
   ```
2. **Start the gated server** on loopback and leave the terminal open (this is your "always-on"):
   ```powershell
   # PowerShell (Windows)
   $env:AUTH_MODE="tailscale"; $env:ALLOWED_LOGINS="you@example.com"; npm start
   ```
   ```bash
   # bash/zsh (macOS/Linux)
   AUTH_MODE=tailscale ALLOWED_LOGINS=you@example.com npm start
   ```
3. **Expose it to your tailnet** over HTTPS (background; run in a second terminal):
   ```bash
   tailscale serve --bg 3737
   tailscale serve status         # expect: https://<machine>.<tailnet>.ts.net -> 127.0.0.1:3737
   ```
4. **On your phone** (Tailscale connected), open **`https://<machine>.<tailnet>.ts.net`**. You're logged in automatically by your Tailscale identity — your sessions appear.

### C. Gotchas (all seen in practice)

- **First HTTPS load can take 10–30 s** while the cert provisions. Wait and retry.
- **`https://` times out?** HTTPS Certificates probably isn't enabled (step A2). Either enable it, **or** serve over plain HTTP instead — still private (the tailnet is WireGuard-encrypted), just no public cert:
  ```bash
  tailscale serve reset
  tailscale serve --bg --http=80 3737     # then open  http://<machine>.<tailnet>.ts.net
  ```
- **`localhost:3737` returns `401 unauthorized` — that's correct.** With the gate on there is no local bypass by design; use the `…ts.net` URL on the laptop too.
- **Stop serving:** `tailscale serve reset`.
- **Never** run `tailscale funnel` — that exposes it to the public internet. Serve is tailnet-only.
- This is a solid posture for a **private, single-user tailnet**. For a shared tailnet, add a per-device ACL and consider the passkey/OIDC + per-action step-up upgrade (see Security).

### D. Run it purely locally (no Tailscale, no login)

The gate is **off by default** — just start without `AUTH_MODE`:

```bash
npm run dev     # http://localhost:5273  (hot reload, for editing)
# or
npm start       # http://localhost:3737  (built UI)
```

Local and remote modes share port **3737**, so run **one at a time** — stop one before starting the other.

## Honest scope

You're viewing Claude's **stated** reasoning (thinking/text blocks) and its **observable** actions (tool calls, files, commands) — not the model's internal computation. On many local transcripts the private `thinking` text is redacted (signature-only); the tool flags that and the narrated "why" comes through the "Claude says" cards. Costs for models not in the exact price table are estimated by tier (shown with `≈`). The auto-compact threshold is an estimate (`AUTO_COMPACT_PCT`).

## License

MIT — see `LICENSE`.
