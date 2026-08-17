# Diff Review

A local browser review desk for Git changes. The daemon resolves Git targets, stores review sessions and comments in SQLite, and renders diffs with [`@pierre/diffs`](https://diffs.com/docs).

## Setup

Requires Node.js 22.12 or newer and Git. GitHub PR review also requires an authenticated [GitHub CLI](https://cli.github.com/).

```bash
npm install
npm run build
npm link
```

Open a review from any Git repository:

```bash
# All staged, unstaged, and untracked changes
diff-review

diff-review --unstaged
diff-review --staged
diff-review origin/master...HEAD
diff-review HEAD~3..HEAD
diff-review HEAD
diff-review --pr 42
```

The command starts the loopback-only daemon when needed and opens the review in a browser. In a multi-commit review, use the header's **Commits** dropdown: click a commit to view it alone or Shift-click another commit to select a continuous range.

## Agent annotations

An already-running agent can create a session without opening the browser:

```bash
diff-review session create --repo . origin/master...HEAD
```

Alternatively, copy the session ID from the browser. The agent can keep inspecting changes with ordinary `git diff`, then annotate lines in changed files with one command:

```bash
diff-review annotate drs_abc123 \
  --file src/retry.ts \
  --new-line 42-48 \
  --comment "The retry condition now includes every 5xx response" \
  --importance 1
```

Use exactly one of `--new-line` or `--old-line`. `--comment` and `--importance` are independently optional, but at least one is required.

Importance controls only the changed-line background:

- `0`: no red/green background; the diff border remains
- omitted: normal diff intensity, equivalent to `0.5`
- `1`: strongest readable background

Diff comments default to local annotations stored in `~/.diff-review/reviews.db`; set `DIFF_REVIEW_DATA_DIR` to use another directory. On a pull request, select **Review comment** while adding or editing a comment to queue that user comment for GitHub. **Submit review** publishes the queued user comments with the review; agent annotations always stay local.

## Explain PR sessions

**Explain with Pi** saves both the detached PR worktree and the Pi session. The Annotations panel shows their paths and a resume command:

```bash
diff-review pi resume pir_abc123
```

Saved runs remain available for 14 days after their last use. The daemon checks for expired runs at startup and every six hours. Automatic cleanup skips active runs and worktrees with modified or untracked files; annotations remain in Diff Review after the worktree and Pi session are removed.

Run assets are stored under `~/.diff-review/worktrees` and `~/.diff-review/pi-sessions`, or the corresponding `DIFF_REVIEW_DATA_DIR`.


## Development

```bash
npm run dev
npm test
npm run typecheck
npm run build
```
