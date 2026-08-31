# bb-plugin-github

GitHub issues and pull requests inside BB, with one-click agent dispatch.

Install it from the BB Official catalog:

```sh
bb plugin install github
```

## What it does

- **Sidebar panel** (GitHub logo, full width): Issues and Pull requests tabs
  across every tracked repo, with a repo filter (persisted in localStorage)
  and a New issue form.
- **Issue detail**: markdown body, comments, comment box, status,
  assignee, and label editing, plus "Send agent".
  Deep-linkable via the URL hash: `#/issues/<owner>/<repo>/<number>`.
- **Send agent / Review with agent**: spawns a BB worker thread on the issue
  (or a review thread on the PR) in the repo's BB project. The issue/PR then
  shows a ⚡ pill linking to the thread.
- **Homepage section**: recent open issues with the same Send agent buttons.
- **Mentions**: `@` or `#` in any composer completes GitHub issues and PRs; the
  selected item's title/body/state is attached as agent context at send time.
- **`bb github` CLI**: `repos`, `issues [repo]`, `prs [repo]`, `sync` — also
  discoverable by agents through the plugin-commands skill.

## Auth

Uses the GitHub CLI. If `gh auth status` passes, the plugin works; otherwise
it reports needs-configuration. No tokens are stored by the plugin.

## Which repos are tracked

Tracking is opt-in. The plugin never follows an `upstream` remote.

- **Shared repositories** (`extraRepos`): comma-separated `owner/repo` list
  you explicitly grant. These are tracked even if you only have public-read
  access. Entries that are not `owner/repo` — a `owner/*` wildcard, a bare
  owner, a typo — are not tracked; the plugin log warns once per distinct
  set. Wildcards are not supported.
- **BB project remotes** (`trackProjectRemotes`, on by default): each
  project's GitHub `origin` remote, and only when GitHub granted you more
  than public-read access (`TRIAGE` / `WRITE` / `MAINTAIN` / `ADMIN`). A
  public clone of someone else's repo — including an upstream you forked
  from — is not auto-tracked.
- **Ignored repositories** (`ignoredRepos`): never tracked, even if they
  appear in extraRepos or as a project origin.
- `defaultProject`: where threads spawn for repos with no project.

```
bb plugin config github set extraRepos "owner/repo, owner/other"
bb plugin config github set ignoredRepos "get-bb/bb"
bb plugin config github set trackProjectRemotes false
bb plugin reload github
```

A background service refreshes the issue/PR cache every 5 minutes; the
panel's Refresh button (or `bb github sync`) forces it. Untracked repos
are dropped from the cache on each sync.

## Development

Run the checks from the repository root:

```sh
pnpm exec turbo run typecheck test --filter=bb-plugin-github
```
