# Diff Review

A local browser review desk for Git changes. The daemon resolves Git targets, stores review sessions and comments in SQLite, and renders diffs with [`@pierre/diffs`](https://diffs.com/docs).

## Security

The private API always binds to loopback (`127.0.0.1` / `localhost`). An optional, separately authenticated HTTP entry can listen on one explicitly configured interface. Set `DIFF_REVIEW_TOKEN` (fallback: `PI_MONITOR_TOKEN`) to protect **all** API routes, including local CLI requests, images and event streams. Health and authentication status remain public; login validates the token. Without a token, only direct loopback use is supported; unknown Host names and forwarded requests are rejected.

Authenticated users can read local Git data, use your `gh` credentials, and start Pi sessions. Use a long random token (at least 32 random bytes recommended), keep it private, and restrict any remote entry to a trusted private network. This is not a multi-user permission system.

### Remote browser sign-in and Monitor embedding

Manually copy the Monitor token into Diff Review's `~/.diff-review/.env`, or set the same `PI_MONITOR_TOKEN` in both services. Setup does not read or copy secrets automatically. For an independent Tailscale HTTPS entry forwarding to `127.0.0.1:47658`, configure:

```dotenv
DIFF_REVIEW_TOKEN=<manually copied Monitor token>
DIFF_REVIEW_PUBLIC_ORIGIN=https://review-host.example.ts.net
DIFF_REVIEW_EMBED_ORIGINS=https://monitor-host.example.ts.net
```

For plain HTTP without sudo, a TLS proxy, or Tailscale Serve, configure a separate unprivileged entry instead:

```dotenv
DIFF_REVIEW_TOKEN=<manually copied Monitor token>
DIFF_REVIEW_PUBLIC_ORIGIN=http://ec2-dev:47659
DIFF_REVIEW_PUBLIC_LISTEN_HOST=100.100.246.17
DIFF_REVIEW_EMBED_ORIGINS=http://ec2-dev:4899
```

Replace the host, interface IP, and Monitor origin with your actual values. `DIFF_REVIEW_PUBLIC_LISTEN_HOST` must be one literal interface IP, never a wildcard. It enables an HTTP listener on the public origin's explicit port (1024–65535); authentication is mandatory. The private API stays on `127.0.0.1:47658`. Public requests require the exact configured Host, reject forwarded headers, and never trust loopback Host/Origin exceptions. Leaving this setting unset creates no public listener; existing external HTTPS entries continue to work.

**HTTP does not encrypt tokens, cookies, or review data.** Use it only on a trusted private connection and restrict access with your existing network controls. Cookies are host-only, but not port-isolated: other HTTP services on that hostname can receive the cookie. HTTPS remains available when transport encryption is needed.

Use your actual HTTP(S) origins (optional trailing slash, no credentials, paths, queries or fragments). Embed origins accept spaces or commas. Configure Monitor with `PI_MONITOR_DIFF_REVIEW_PUBLIC_ORIGIN` (or `DIFF_REVIEW_PUBLIC_ORIGIN`) pointing at the same review origin. Monitor checks that the running daemon reports this exact canonical `publicOrigin` from `/api/auth/status`; mismatched configuration is rejected. Keep the private API loopback-bound; an external HTTPS entry is not created automatically. Restart the daemon explicitly after changing configuration.

The browser shows a token sign-in dialog before loading reviews. Sign-in persists for 30 days in an HMAC-derived, host-only HttpOnly cookie, never localStorage or a URL. Public HTTPS uses a `__Host-` Secure, SameSite=Strict cookie; public HTTP uses a distinct HttpOnly, SameSite=Strict cookie without Secure; direct loopback HTTP uses a third, separate local cookie. Public signatures are bound to the cookie name and public origin, so renaming a local cookie or moving one to a differently configured origin cannot authorize public access. Native EventSource and images use that cookie automatically. Embedding requires same-site origins (scheme and registrable domain), not merely network reachability. Different ports on the same hostname are same-site; short names or raw IPs on different machines often are not. HTTP cannot use cross-site `SameSite=None` cookies because browsers require Secure for those cookies. If cross-site/third-party cookie restrictions prevent embedding, **Open in new tab** provides standalone review; signing in there does not bypass the browser's iframe restrictions.

Cookie-authenticated mutations and login/logout require an exact trusted Origin. Monitor embed origins authorize framing only, not cross-origin API calls. The CLI sends a bearer token from the same configuration; other API clients must do likewise. `POST /api/auth/logout` clears the browser cookie; rotating the token and restarting invalidates all existing sessions (logout does not revoke a copied cookie). Failed login attempts are limited to 20 per minute per daemon. Health is `GET /api/health`; `GET /api/auth/status` reports `required` and `authenticated` without exposing credentials.

## Setup

Requires Node.js 22.12 or newer and Git. GitHub PR review also requires an authenticated [GitHub CLI](https://cli.github.com/).

```bash
pnpm install
pnpm run build
pnpm link
diff-review setup-skill
```

`pnpm link` registers this package globally and puts the `diff-review` binary on your PATH (the directory from `pnpm bin -g`; run `pnpm setup` if that directory is missing). Confirm with `which diff-review` that it points at this checkout. If an older `npm link` still wins, remove it with `npm unlink -g diff-review`.

`setup-skill` installs the bundled `/explain-diff` skill at `~/.agents/skills/explain-diff/SKILL.md`. Run it again after updating Diff Review to refresh the skill.

Open a review from any Git repository:

```bash
# Unstaged changes, or origin/master...HEAD when the worktree is clean
diff-review

diff-review --unstaged
diff-review --staged
diff-review origin/master...HEAD
diff-review HEAD~3..HEAD
diff-review HEAD
diff-review --pr 42
```

The command starts the daemon when needed and opens the review in a browser. In a multi-commit review, use the header's **Commits** dropdown: click a commit to view it alone or Shift-click another commit to select a continuous range.

Control the daemon explicitly with:

```bash
diff-review service status
diff-review service start
diff-review service restart
diff-review service stop
```

It listens on `http://127.0.0.1:47658` by default (`DIFF_REVIEW_PORT`). On startup it loads `.env` from the current working directory, then `~/.diff-review/.env` (or `$DIFF_REVIEW_DATA_DIR/.env`). Variables already set in the environment are left unchanged.

## Agent annotations

An already-running agent can open a session without opening the browser:

```bash
diff-review session create --repo . origin/master...HEAD
```

The same repository and resolved commit range (`base...head`) reuse the existing local session, so later `session create` calls keep the same ID and annotations. A new session is opened when those commit SHAs change. Pull requests still open a new session when the base or head revision changes.

Alternatively, copy the session ID from the browser. The agent can keep inspecting changes with ordinary `git diff`, then add a global summary or line notes:

```bash
diff-review annotate drs_abc123 --comment "Retry now covers every 5xx"
diff-review annotate drs_abc123 \
  --file src/retry.ts \
  --new-line 42-48 \
  --comment "The retry condition now includes every 5xx response" \
  --importance 1
```

Omit `--file` and line flags to add a session global comment. You can add more than one. For a line annotation, use exactly one of `--new-line` or `--old-line` (`42` or `42-48`, inclusive). `--comment` and `--importance` are independently optional on line annotations, but at least one is required.

Importance controls only the changed-line background:

- `0`: no red/green background; the diff border remains
- omitted: normal diff intensity, equivalent to `0.5`
- `1`: strongest readable background

Diff comments default to local annotations stored in `~/.diff-review/reviews.db`; set `DIFF_REVIEW_DATA_DIR` to use another directory. On a pull request, select **Review comment** while adding or editing a comment to queue that user comment for GitHub. **Submit review** publishes the queued user comments with the review; agent annotations always stay local.

## Chat

**Chat** on a pull request opens a drawer over the review. The model list comes from `pi --list-models`, filtered to gpt-5.6 and gpt-6. Pick a model in the drawer; that chat keeps it across refresh and follow-ups, and a later change switches only that chat. Diff Review passes `--model` / `--thinking` to that Pi process only and reasserts the same model over RPC before each prompt — it does not change Pi's default. The first message creates a detached PR worktree and a Pi RPC session under `~/.diff-review/worktrees` and `~/.diff-review/pi-sessions` (or `DIFF_REVIEW_DATA_DIR`). Follow-ups reuse that session. Saved runs remain available for 14 days after their last use. The daemon checks for expired runs at startup and every six hours. Automatic cleanup skips the live Pi process and worktrees with modified or untracked files; annotations remain in Diff Review after the worktree and Pi session are removed.

## Development

```bash
pnpm run dev
pnpm test
pnpm run typecheck
pnpm run build
```
