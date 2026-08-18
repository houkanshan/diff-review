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

## Layers

| Layer | Owns | Depends on |
| --- | --- | --- |
| CLI (`src/server/cli.ts`) | Ensure daemon, open browser, agent `session create` / `annotate` / `pi resume` | HTTP API only |
| Daemon (`src/server/daemon.ts`) | Loopback HTTP, SIGINT/SIGTERM | `ApiHandler`, `ReviewStore` |
| API (`src/server/api.ts`) | Routes, validation, SSE, session reuse | store, git, github, pi, difftastic |
| Git (`src/server/git.ts`) | Target resolution, patch, snapshot file reads, annotation line checks | `command.ts` |
| Store (`src/server/store.ts`) | SQLite CRUD; IDs `drs_`, `ann_`, `pir_` | shared types |
| GitHub (`src/server/github.ts`) | `gh` CLI / GraphQL; cache and dedupe | `command.ts` |
| Pi (`src/server/pi.ts`) | Detached PR worktrees and Pi sessions | store, git |
| Client (`src/client`) | Routes, `@pierre/diffs` / difftastic UI, annotation composer | `/api/*`, `src/shared` |
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

**Render diffs.** Client parses `session.patch` with `@pierre/diffs`. File bytes come from `GET /api/sessions/:id/file`. Optional `GET .../difftastic` runs the `difft` CLI.

**Annotate.** Browser composer or `diff-review annotate` → `POST /api/sessions/:id/annotations` → `validateAnnotationTarget` → SQLite → SSE `session-updated`. Client SSE uses a Web Lock leader plus BroadcastChannel so one tab holds the stream.

**PR workspace.** `POST /api/pull-requests/:n/open` returns GitHub metadata, sessions, revision history, and Pi status. Client never calls GitHub; the server uses `gh`.

**Explain with Pi.** `POST /api/sessions/:id/pi-review` creates a worktree under `worktrees/` and a Pi session under `pi-sessions/`. Resume: `diff-review pi resume pir_…`. Retention: 14 days; cleanup at daemon start and every six hours; skip active runs and dirty worktrees.

## Extension points

- New Git target: `ReviewTarget` + `resolveTarget` in `git.ts`
- New HTTP surface: `ApiHandler.handleApi`
- Persistence: `ReviewStore`
- UI: routes and `ReviewWorkspace` in `src/client/App.tsx`

Keep GitHub/`gh` traffic cached and deduplicated. Do not start `daemon serve` in a tool call that waits for exit.
