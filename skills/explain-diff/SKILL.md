---
name: explain-diff
description: Explains a code diff in plain language. Use when the user invokes /explain-diff.
disable-model-invocation: true
---

# Explain Diff

Help someone review this diff. Explain the change in the context of what moved, appeared, or disappeared — purpose, behavior deltas, risks, and tests. A reviewer already has the new code; they need why this hunk is here and how it relates to the rest of the patch.

Example: `retry()` deleted from `a.ts` and added in `b.ts` → one note that this is a move into `b.ts`, and why that home makes sense.

Explain in plain human language, with no jargon and speak coherently. Use the system’s established terms for features, concepts, and states consistently. If a term may be unfamiliar, explain it briefly rather than replacing it with a new name. The user didn't read the code so do not assume they have the context.

For each explanation, start with one short, plain-language sentence saying what changed. Leave a blank line, then add the details needed to understand why it changed, how it works, or what to watch for. In the first annotation for each function or logical block you annotate, begin the details with a brief explanation of what that function or block does overall, then explain the local change. Do not repeat this context in later annotations within the same function or block.

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

Organize the explanation as ordered sections: a short overview, then inline annotations, then the next overview and its annotations. Choose a meaningful uppercase prefix (2–12 letters/digits, starting with a letter), such as RETRY. Create the section before adding notes.

`section set` updates only supplied fields: changing the overview preserves its order, annotations and replies; changing only `--order` preserves its overview. Order is ascending and accepts finite decimals. New sections default to the largest order + 10 (first: 10); existing sections keep their order when omitted. Equal orders retain creation order.

```bash
diff-review section list "$session_id" --json
diff-review section set "$session_id" RETRY --order 10 \
  --body "Retries move next to the request lifecycle." --json
diff-review annotation add "$session_id" RETRY \
  --file src/example.ts --new-line 42-48 \
  --body $'move(requests): Retries now live in b.ts.\n\nThe retry logic moved from a.ts so related code stays together; its behavior is unchanged.' \
  --json
# Use the returned short ID for later corrections.
diff-review annotation update "$session_id" RETRY-1 --body "Revised explanation." --json
diff-review section set "$session_id" RETRY --order 9.5 --json
```

Use exactly one of `--new-line` or `--old-line` (`42` or `42-48`, inclusive). Use new-side numbers for current code and old-side numbers for deleted code. Prefix inline note bodies with `action(domain):`, where action describes the edit and domain names the feature. Pass Markdown with `--body` or `--body-file` (`-` reads stdin), not both.

The server assigns stable IDs such as RETRY-1; they identify notes, not reading order. Update an existing note rather than adding a replacement, so its anchor and user replies stay attached. Repeating `add` creates another note; do not blindly retry an uncertain result. Reuse an existing section prefix when revising its overview rather than creating another section.

Each file appears once, under the earliest ordered section referencing it; later sections link to their notes on that file. Moving a section can move a shared file. Unreferenced files remain accessible at the end. Importance is no longer accepted or used for sorting or line wash.
