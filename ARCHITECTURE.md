# Architecture

Diff Review is a loopback-only Node daemon plus a React SPA. The daemon resolves Git targets into unified patches, stores review sessions and annotations in SQLite, and serves the client. The browser renders diffs and comments. Agents talk to the same HTTP API through the CLI.

## Topology

```
╭──────────────────╮         HTTP (loopback)          ╭──────────────────────────────╮
│  Browser (React) │◀────────────────────────────────▶│  Node daemon (port 47658)    │
│  dist/client     │   /api/*  +  SSE /api/events     │  ApiHandler + ReviewStore    │
╰────────┬─────────╯                                    ╰──────┬───────────┬───────────╯
         │ @pierre/diffs                                       │           │
         │ parsePatchFiles(session.patch)                      │           │
         │                                                   git/gh      SQLite
         ▼                                                   spawn       reviews.db
   Diff + annotations UI                                Local repo     ~/.diff-review/
                                                       + gh CLI       worktrees/, pi-sessions/
```

Default bind: `127.0.0.1:47658` (`DIFF_REVIEW_PORT` / `DIFF_REVIEW_HOST`; host must be loopback). Data lives under `~/.diff-review` or `DIFF_REVIEW_DATA_DIR`.

`ApiAuth` is the HTTP authorization boundary, before API dispatch (including SSE/media). `DIFF_REVIEW_TOKEN` falls back to `PI_MONITOR_TOKEN`; configured tokens have no loopback bypass. CLI/Monitor send bearer credentials. Browser AuthGate shows a neutral loading status while probing `/api/auth/status`, mounts App for an authenticated browser, and shows the token form only after authentication is required or the probe fails. It posts a token to `/api/auth/login`, then uses a 30-day signed HttpOnly cookie for fetch, images and EventSource. Public HTTPS cookies use `__Host-`, Secure and SameSite=Strict; direct loopback cookies use a distinct name and are not accepted on public/forwarded requests. Signatures bind the cookie name to prevent replay across local/public scopes. Status reports the canonical `publicOrigin` so Monitor can reject a mismatched daemon before returning a public review URL. Cookie mutations require exact trusted Origin; authentication failures unmount App and reopen the gate. Cookie-authenticated SSE streams close at the signed expiry deadline, including already-open connections; bearer and tokenless streams have no browser-session deadline. Logout clears the cookie; token rotation revokes all signed cookies.

An independent HTTPS proxy may expose the loopback daemon only with a token and `DIFF_REVIEW_PUBLIC_ORIGIN`. Host validation rejects DNS rebinding; forwarded requests require both settings. Without a token the daemon supports direct loopback only. No permissive CORS is supplied; API responses use CORP same-origin. Frame CSP permits self, HTTP loopback and explicit `DIFF_REVIEW_EMBED_ORIGINS` HTTPS origins. Third-party cookie restrictions fall back to standalone review in a new tab, not weaker token transport.

## Layers

| Layer | Owns | Depends on |
| --- | --- | --- |
| CLI (`src/server/cli.ts`) | Ensure daemon, `service` lifecycle, open browser, agent `session create` / `annotate` | HTTP API and local process control |
| Daemon (`src/server/daemon.ts`) | Loopback HTTP, PID file, SIGINT/SIGTERM | `ApiHandler`, `ReviewStore` |
| API (`src/server/api.ts`) | Routes, validation, SSE, session reuse | store, git, github, pi, difftastic |
| Git (`src/server/git.ts`) | Target resolution, patch, snapshot file reads, annotation line checks | `command.ts` |
| Store (`src/server/store.ts`) | SQLite CRUD; IDs `drs_`, `ann_`, `pir_` | shared types |
| GitHub (`src/server/github.ts`) | `gh` CLI / GraphQL; cache and dedupe | `command.ts` |
| Pi (`src/server/pi.ts`) | Detached PR worktrees and Pi sessions | store, git |
| Client (`src/client`) | Routes, `@pierre/diffs` / difftastic UI, annotation composer; allowlisted-parent embed location bridge | `/api/*`, `src/shared` |
| Shared (`src/shared`) | Types and pure helpers | nothing runtime-specific |

Build: Vite → `dist/client`; `tsc` (`tsconfig.server.json`) → `dist/node`. Production daemon serves both API and static client. Dev: Vite `:5173` proxies `/api` to the daemon.

## Core data

`ReviewTarget` is one of: `worktree`, `branch-worktree`, `unstaged`, `staged`, `{ kind: 'range'; expression }`, `{ kind: 'pr'; number }`.

`resolveTarget()` produces a `ResolvedReview`: label, git command, unified `patch`, old/new `SnapshotRef` (`commit` | `index` | `worktree`), and commits.

`ReviewSession` stores that patch plus `target`, `revisionBaseOid` / `revisionHeadOid`, `annotations`, `viewedFiles`, and commit selection.

Session reuse (`createOrReuseSession`): when both snapshots are commits, lookup by `(repositoryRoot, revision_base_oid, revision_head_oid)`. Same SHAs keep the same `drs_` id and annotations. PR sessions stay immutable; local range sessions refresh the patch in place.

Annotations: user or agent; optional GitHub `review-comment` intent on PRs. Agent annotations stay local. Submit review publishes queued user comments via `gh`.

## Main flows

**Open a review.** CLI `ensureDaemon()` → `POST /api/sessions` → resolve repo + target → create or reuse session → open `/s/{sessionId}`. PR sessions redirect to `/pull-requests`.

**Render diffs.** Client parses `session.patch` with `@pierre/diffs`. File bytes come from `GET /api/sessions/:id/file`. Optional `GET .../difftastic` runs the `difft` CLI. When embedded, the client accepts a nonce handshake only from its direct parent at an HTTP loopback or explicitly configured HTTPS origin (loaded from authentication status), and reports route changes to that exact source/origin with `postMessage`. A handshake received before configuration loads is validated after loading. The server's frame-ancestors CSP enforces the same embedding boundary.

**Refresh a review.** Opening a local review or returning to its visible browser tab checks its fingerprint. A stale review automatically follows the target only when it has no annotations (including archived ones), no global comments, no annotation draft, and uses the full commit range. Busy workspaces and active Pi reviews wait. The 10-second background check only shows the refresh badge; it does not interrupt reading. PR open resolves the current revision through cached GitHub details. Returning to a visible PR tab first refreshes its details, then reopens its selected revision against those cached details to discover the latest session and Pi status. An eligible old revision advances without a diff-refresh request; temporary busy/draft checks do not consume future attempts. Deliberate history selections are tracked separately from automatic navigation. Annotated revisions and explicit in-workspace history selections stay selected; older PR revisions show the update badge. The background timer never fetches GitHub details. Automatic local navigation replaces the history entry and rechecks eligibility after the refresh request so a newly started annotation is not discarded. The workspace and controlled CodeView remain mounted while session/patch data changes; automatic navigation preserves the current view and scroll instead of showing an intermediate loading screen. PR auto-advance seeds the destination query from the already-loaded current session.

**Copy comments.** ⌘C copies the reviewer's comments only when nothing is selected. Diff text lives in `@pierre/diffs` open ShadowRoots, so `window.getSelection()` often looks collapsed; use `hasDocumentSelection()` in `src/client/documentSelection.ts`, which also checks inputs, shadow-root selections, and composed ranges.

**Annotate.** Browser composer or `diff-review annotate` → `POST /api/sessions/:id/annotations` → `validateAnnotationTarget` → SQLite → SSE `session-updated`. Client SSE uses a Web Lock leader plus BroadcastChannel so one tab holds the stream.

**PR list filters.** The browser applies independent user-guide (`[User Guide]` / `[User Guides]`) and E2E (`[E2E]`) title-prefix exclusions, case-insensitively, to each loaded page. Both default on and persist in localStorage. GitHub's `viewerDidAuthor` field travels in the existing list query and browser cache, keeping the authenticated user's own PRs visible without extra API calls. The author filter still applies to all PRs. Filtering does not change server pagination or direct PR navigation.

**PR workspace.** `POST /api/pull-requests/:n/open` returns GitHub metadata, sessions, revision history, and Pi status. Client never calls GitHub; the server uses `gh`. Inline title/description editors send only the changed field to `POST /api/pull-requests/:n/update`; the server validates it, PATCHes GitHub, and invalidates details/list caches. The client updates cached metadata after success and revalidates. Descriptions may be cleared and retain Markdown whitespace. Editor drafts live above the loading/workspace switch and reset when the repository or PR changes. The sidebar Labels section owns label badges, the edit picker, and the additional-review removal shortcut. The picker lazily loads a cached, paginated repository label catalog from `GET /api/labels`, with selected labels sorted first and alphabetical ordering within each group. Each checkbox adds (`POST`) or removes (`DELETE`) a single label through `/api/pull-requests/:n/labels/:label`, preserving unrelated concurrent GitHub label edits. Successful mutations update client metadata and invalidate details/list caches; the additional-review removal shortcut uses the same path. Cmd+Enter / Ctrl+Enter saves these editors and submits conversation comments, thread replies, and review summaries; plain Enter remains a newline in those textareas.

**Chat.** `POST /api/sessions/:id/pi-chat` creates a detached PR worktree and a daemon-owned `pi --mode rpc` child. The model picker comes from `pi --list-models`, filtered to gpt-5.6 and gpt-6 (no `@` / `:` variants; openai-codex wins duplicates). The chosen model is per chat (repo + PR number): stored in `pi-chat-models.json`, shown after resume/refresh, and applied with `--model` / `--thinking` plus an RPC `set_model` before each prompt so Pi extensions cannot keep a default such as Grok. New chats use the first listed model. Missing entries fall back to a legacy sidecar or the transcript only when that model is in the gpt-5.6 / gpt-6 allowlist. Chat is per pull request, not per revision SHA: a new push reuses the same Pi transcript and refreshes the worktree to the selected head. `GET` pages projected turns from the Pi JSONL; SSE `pi-chat` events carry the live overlay. The browser never reads the session file. Retention: 14 days; cleanup at daemon start and every six hours; skip the live RPC child and dirty worktrees.

## Extension points

- New Git target: `ReviewTarget` + `resolveTarget` in `git.ts`
- New HTTP surface: `ApiHandler.handleApi`
- Persistence: `ReviewStore`
- UI: routes and `ReviewWorkspace` in `src/client/App.tsx`

Keep GitHub/`gh` traffic cached and deduplicated. Do not start `daemon serve` in a tool call that waits for exit.
