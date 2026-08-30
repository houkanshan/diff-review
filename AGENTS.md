# Diff Review

Diff Review is a local daemon and browser GUI for reviewing Git changes. The React client renders diffs and annotations, while the Node.js server resolves Git targets and stores review sessions locally.

Use `pnpm test` for tests, `pnpm run typecheck` for TypeScript checks, and `pnpm run build` for a production build.

Use sentence case for UI labels; do not use all-caps labels.

Minimize GitHub API and `gh` calls to avoid rate limits; cache and deduplicate requests when possible.

Rebuild after making code changes. Restart the Diff Review daemon when a change affects the running server or the client it serves.

`daemon serve` is a long-lived foreground process. Never start it in a tool call that waits for exit; that call will hang until timeout.

To restart after a build: `node dist/node/server/cli.js service restart`. Confirm readiness with `GET http://127.0.0.1:47658/api/health` (`ok: true`). Do not keep the serve process in the foreground of the agent session.

