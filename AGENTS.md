# Diff Review

Diff Review is a local daemon and browser GUI for reviewing Git changes. The React client renders diffs and annotations, while the Node.js server resolves Git targets and stores review sessions locally.

Use `pnpm test` for tests, `pnpm run typecheck` for TypeScript checks, and `pnpm run build` for a production build.

Use sentence case for UI labels; do not use all-caps labels.

Treat GitHub API rate limits as a design constraint. Minimize `gh` and GitHub API calls by caching and deduplicating requests, combining overlapping queries, and avoiding polling, automatic retries, or focus-based refetches. Remember that paginated commands can make multiple API requests, and verify request counts when changing GitHub integration paths.

After making code changes, stop any running Diff Review server, build the project, and restart the server from the newly built output. Do not leave a stale server running an older build.
