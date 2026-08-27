---
name: explain-diff
description: Explains a code diff in plain language. Use when the user invokes /explain-diff.
disable-model-invocation: true
---

# Explain Diff

Help someone review this diff. Explain the change in the context of what moved, appeared, or disappeared — purpose, behavior deltas, risks, and tests. A reviewer already has the new code; they need why this hunk is here and how it relates to the rest of the patch.

Example: `retry()` deleted from `a.ts` and added in `b.ts` → one note that this is a move into `b.ts`, and why that home makes sense.

## Tools

`diff-review` starts a local daemon when needed and writes notes onto a review session.

```bash
# Open a session in the browser (optional)
diff-review                    # All worktree changes
diff-review --unstaged         # Unstaged changes only
diff-review --staged           # Staged changes only
diff-review origin/main...HEAD # Current branch compared with its base
diff-review --pr 42            # GitHub pull request 42
```

Create a session without opening the browser. Pass the repo as an absolute path (`--repo`); the CLI resolves relative paths from its own cwd.

```bash
repo="/absolute/path/supplied/for/the/repo"
session_json="$(diff-review session create origin/main...HEAD --repo "$repo" --json)"
session_id="$(jq -r '.sessionId' <<<"$session_json")"
# Confirm .repository equals $repo before annotating.
```

Global comment — session-level text, no `--file` or line flags:

```bash
diff-review annotate "$session_id" --comment "[summary] …" --json
```

Line annotation — attaches to a file and a changed range. Exactly one of `--new-line` or `--old-line` (`42` or `42-48`). Prefix `--comment` with `action(domain):`: **action** is the edit verb (what happened to the code), **domain** is the feature or concern it belongs to, e.g. `move(feature-A):`. `--comment` and `--importance` (`0`–`1`) are independently optional; at least one is required. `0` drops the red/green line wash; `1` is the strongest wash.

```bash
diff-review annotate "$session_id" \
  --file src/example.ts \
  --new-line 42-48 \
  --comment "move(feature-A): …" \
  --importance 0.8 \
  --json
```
