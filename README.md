# Diff Review

A local browser review desk for Git changes. The daemon resolves Git targets, stores review sessions and comments in SQLite, and renders diffs with [`@pierre/diffs`](https://diffs.com/docs).

## Security

The daemon has no authentication. It binds only to loopback (`127.0.0.1` / `localhost`) and rejects any other `DIFF_REVIEW_HOST`. Do not expose it on the public internet, reverse-proxy it, publish its port, or otherwise make it reachable beyond this machine. Anyone who can reach the HTTP API can read local Git data, call `gh` with your credentials, and start Pi sessions.

## Setup

Requires Node.js 22.12 or newer and Git. GitHub PR review also requires an authenticated [GitHub CLI](https://cli.github.com/).

```bash
npm install
npm run build
npm link
diff-review setup-skill
```

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

The command starts the loopback-only daemon when needed and opens the review in a browser. In a multi-commit review, use the header's **Commits** dropdown: click a commit to view it alone or Shift-click another commit to select a continuous range.

When embedded by Pi Session Monitor, the **Files** tab opens changed files in `@pierre/diffs` Edit mode. Save writes back only to worktree-backed reviews (`worktree`, `branch-worktree`, or `unstaged`); commit, pull-request, staged, deleted, symlink, binary, and externally changed files remain protected.

## Agent annotations

An already-running agent can open a session without opening the browser:

```bash
diff-review session create --repo . origin/master...HEAD
```

The same repository and resolved commit range (`base...head`) reuse the existing local session, so later `session create` calls keep the same ID and annotations. A new session is opened when those commit SHAs change. Pull requests still open a new session when the base or head revision changes.

Working-tree reviews (`unstaged`, `staged`, `worktree`, `branch-worktree`) reuse the session for the same repository, target kind, and HEAD commit. Refresh and later creates update that session's diff in place. A different HEAD commit opens a new session. Annotations stay on the session and are not remapped when the working tree changes. Live sessions created before this identity (no stored HEAD) are not reused.

Alternatively, copy the session ID from the browser. The agent can keep inspecting changes with ordinary `git diff`, then add a global summary or line notes:

```bash
diff-review annotate drs_abc123 --comment "Retry now covers every 5xx"
diff-review annotate drs_abc123 \
  --file src/retry.ts \
  --new-line 42-48 \
  --comment "The retry condition now includes every 5xx response" \
  --importance 1
```

Omit `--file` and line flags to add a session global comment. You can add more than one. For a line annotation, use exactly one of `--new-line` or `--old-line`. `--comment` and `--importance` are independently optional on line annotations, but at least one is required.

Importance controls only the changed-line background:

- `0`: no red/green background; the diff border remains
- omitted: normal diff intensity, equivalent to `0.5`
- `1`: strongest readable background

Diff comments default to local annotations stored in `~/.diff-review/reviews.db`; set `DIFF_REVIEW_DATA_DIR` to use another directory. On a pull request, select **Review comment** while adding or editing a comment to queue that user comment for GitHub. **Submit review** publishes the queued user comments with the review; agent annotations always stay local.

## Chat

**Chat** on a pull request opens a drawer over the review. The first message creates a detached PR worktree and a Pi RPC session under `~/.diff-review/worktrees` and `~/.diff-review/pi-sessions` (or `DIFF_REVIEW_DATA_DIR`). Follow-ups reuse that session. Saved runs remain available for 14 days after their last use. The daemon checks for expired runs at startup and every six hours. Automatic cleanup skips the live Pi process and worktrees with modified or untracked files; annotations remain in Diff Review after the worktree and Pi session are removed.

## Development

```bash
npm run dev
npm test
npm run typecheck
npm run build
```
