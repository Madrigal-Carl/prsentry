# PRsentry

AI-powered PR reviewer that checks pull requests against your repo's style guide — right from the command line or as a GitHub Action.

## How it works

PRsentry pulls a pull request's diff via the GitHub API, sends it to Google's Gemini model along with your repo's style guide, and posts the findings back as inline review comments on the PR.

Before anything gets posted, you get a say: PRsentry shows you each finding and lets you **approve, always approve, or reject** it — nothing goes to GitHub without your sign-off, unless you've turned on auto-approve.

## Tools used

- **Node.js CLI** — built with [`commander`](https://www.npmjs.com/package/commander)
- **GitHub API** — [`@octokit/rest`](https://www.npmjs.com/package/@octokit/rest) for fetching PR diffs/metadata and posting review comments
- **Gemini API** — [`@google/genai`](https://www.npmjs.com/package/@google/genai) for the actual code review (model is configurable — see [Choosing a model](#choosing-a-model))
- **`dotenv`** — loads `GITHUB_TOKEN` and `GEMINI_API_KEY` from a `.env` file, wherever you tell it to look
- **`prompts`** — interactive prompts during `init` and for approving/rejecting review findings
- **`zod`** — the single source of truth for what a "finding" looks like. Gemini's response is validated against it (`safeParse`, not a bare `parse`) before anything downstream trusts it, so a malformed or truncated response fails loudly and just skips that batch instead of crashing or posting garbage
- **`zod-to-json-schema`** — derives the JSON schema handed to Gemini's `responseSchema` directly from the zod schema above, so there's only one place to update the shape of a finding instead of two schemas that can quietly drift apart

## Installation

```bash
npm install prsentry
```

Or run it without installing, via `npx`:

```bash
npx prsentry init
```

Because the `.env` location is configurable (see below), PRsentry works just as well dropped into a `backend/` folder of an existing project as it does at a repo root — you don't need `.env` to live next to `package.json`.

## Setup

Create a `.env` file with your credentials:

```
GITHUB_TOKEN=your_github_personal_access_token
GEMINI_API_KEY=your_gemini_api_key
```

`GITHUB_TOKEN` needs read access to the repo (and write access to PRs so it can post reviews). `GEMINI_API_KEY` is your Gemini API key.

### Where PRsentry looks for `.env`

You're not required to keep `.env` in the directory you run `prsentry` from. It's resolved in this order:

1. `--env-file <path>` passed on the command line
2. `PRSENTRY_ENV_FILE` environment variable (handy for CI or backend deployments)
3. `envPath` saved in `.prsentry-config.json` (set via `prsentry set-env-path`)
4. `./.env` relative to the current directory (the default)

So if your `.env` lives somewhere else — a shared root config, a secrets-mounted path, etc. — point PRsentry at it once and forget about it:

```bash
prsentry set-env-path ../.env
```

or per-command, without changing your saved config:

```bash
prsentry review 42 --repo octocat/hello-world --env-file ../.env
```

`init` also asks whether you want to set a custom `.env` location as part of first-time setup.

## Choosing a model

PRsentry defaults to `gemini-3.6-flash`, but the model is configurable — useful if you want a stronger model for higher-stakes repos, or need to move off a model that's been deprecated. Resolved in this order:

1. `--model <model>` passed to `prsentry review` for that run only
2. `GEMINI_MODEL` environment variable
3. the default saved via `prsentry set-model` in `.prsentry-config.json`
4. the built-in default (`gemini-3.6-flash`)

```bash
prsentry set-model gemini-2.5-pro     # use this model from now on
prsentry set-model                    # clear it, fall back to GEMINI_MODEL or the built-in default
prsentry review 42 --repo octocat/hello-world --model gemini-2.5-pro   # override for one run
```

## Large diffs

Big PRs can easily exceed a model's context window. PRsentry handles this automatically: the diff is split per file, then grouped into batches that stay under a safe size, and each batch is reviewed with a separate Gemini call, with findings merged together at the end. You'll see progress logged as `Sending batch i/N to Gemini...` when a diff is large enough to need more than one batch.

If a single file's diff is so large it alone exceeds a batch, that file is reviewed on its own with the excess truncated and clearly marked (`[... file truncated by PRsentry ...]`) rather than the run failing outright.

## Reliability

A few things PRsentry does to keep a single flaky moment from ruining an entire review run:

- **Rate-limit retries.** If Gemini rate-limits a batch (`429` / `RESOURCE_EXHAUSTED`), PRsentry retries with exponential backoff (2s, 4s, 8s) before giving up on that batch. Retries only kick in for actual rate-limit errors — a bad API key or invalid model fails immediately rather than retrying something that'll never succeed.
- **Partial results are kept, not discarded.** If a batch still fails after retries (or on a large PR split into several batches), PRsentry doesn't abandon the whole run — it skips that batch, keeps the findings the other batches already produced, and tells you at the end which batch numbers failed so you know coverage was partial.
- **Hallucinated findings are filtered out.** Before anything is posted, PRsentry checks every finding's `file`/`line` against the actual diff. GitHub will only accept a comment on a line that's genuinely part of the diff, so a finding pointing at a line the model imagined is dropped with a warning instead of failing when posted.
- **Comments post one at a time.** Approved findings are posted as individual review comments rather than one all-or-nothing batched review, so if GitHub rejects one comment (a stale position after a force-push, for example), the rest still go through. A short summary comment is posted afterward noting how many landed and how many failed.

## Commands

### `prsentry init`

Sets up PRsentry in the current directory:

- Creates a default `PRSENTRY_STYLE_GUIDE.md` in the project root (skipped if one already exists).
- Prompts you to optionally set up a GitHub Action so reviews run automatically on every new PR. **This integration is experimental and off by default** — you have to opt in. If you accept, it creates `.github/workflows/prsentry.yml` and reminds you to add `GEMINI_API_KEY` as a repo secret.
- Prompts you to optionally set a custom `.env` file location, saved to `.prsentry-config.json` for future runs.

### `prsentry add-action`

Adds the `.github/workflows/prsentry.yml` GitHub Action workflow on its own — useful if you skipped that step during `init`, or want to add it later. Same experimental status applies (see [GitHub Action](#github-action)).

### `prsentry review <pr-number> --repo <owner/repo>`

Manually reviews a pull request:

```bash
prsentry review 42 --repo octocat/hello-world
```

Fetches the PR diff, batches it if needed (see [Large diffs](#large-diffs)), sends it to Gemini against your style guide (retrying on rate limits — see [Reliability](#reliability)), filters out any finding that doesn't map to a real line in the diff, and prints what's left to the console. Unless auto-approve is on, you'll be prompted for each finding:

- **Approve** — post this one comment
- **Always approve** — post this one and everything remaining, and turn auto-approve on for future runs too
- **Reject** — skip this comment, it won't be posted

Approved findings are posted as individual review comments on GitHub, followed by a short summary comment. Requires `GITHUB_TOKEN` and `GEMINI_API_KEY` to be resolvable per the `.env` lookup order above.

**Flags:**
- `-r, --repo <owner/repo>` — the repo to review (required)
- `-e, --env-file <path>` — use this `.env` file for just this run
- `--auto-approve` — apply all findings automatically without prompting, for this run only (doesn't change your saved config — this is what the GitHub Action uses, since CI has no terminal to answer prompts with)
- `--model <model>` — use this Gemini model for just this run (see [Choosing a model](#choosing-a-model))

### `prsentry auto-approve <on|off>`

Toggles auto-approve for all future `review` runs, saved to `.prsentry-config.json`:

```bash
prsentry auto-approve on   # skip the approval prompt from now on
prsentry auto-approve off  # go back to reviewing findings one by one
```

### `prsentry set-env-path [path]`

Sets (or clears) the `.env` location PRsentry should use by default, saved to `.prsentry-config.json`:

```bash
prsentry set-env-path ../config/.env   # use this file from now on
prsentry set-env-path                  # clear it, fall back to PRSENTRY_ENV_FILE or ./.env
```

### `prsentry set-model [model]`

Sets (or clears) the default Gemini model PRsentry should use, saved to `.prsentry-config.json`. See [Choosing a model](#choosing-a-model) for the full override order.

```bash
prsentry set-model gemini-2.5-pro   # use this model from now on
prsentry set-model                  # clear it, fall back to GEMINI_MODEL or the built-in default
```

> `.prsentry-config.json` is automatically added to `.gitignore` the first time it's written (creating `.gitignore` if you don't have one yet), since it can contain a machine-specific `.env` path, a personal auto-approve preference, and a personal model choice — not something you'd want to commit or share across a team.

## Style guide

`init` generates a default `PRSENTRY_STYLE_GUIDE.md` written for a MERN stack (MongoDB, Express, React, Node.js), covering:

- General code quality (no stray `console.log`s, no hardcoded secrets, function length, magic numbers)
- Error handling (try/catch, proper HTTP status codes)
- Naming conventions
- Node.js / Express (service layer, middleware, input validation)
- MongoDB / Mongoose (ObjectId refs, pagination, `select: false`, `.lean()`)
- React (hook usage, `useEffect` dependencies, prop drilling)
- Security (no leaked stack traces, CORS, password hashing, file upload validation)
- API design (REST conventions, consistent response shapes)

This file is fully yours to edit — add, remove, or rewrite any rule to match your team's conventions. PRsentry reads `PRSENTRY_STYLE_GUIDE.md` straight from the directory you run it in — not from GitHub — so edits apply immediately without needing to be committed or pushed first. If no local copy exists, it falls back to the default guide above. (For the GitHub Action, that means the style guide it uses is whatever's committed in the checked-out branch, since the Action runs from a repo checkout.)

## GitHub Action

> **Experimental.** This integration works, but hasn't seen enough real-world PR traffic to be considered battle-tested. It's off by default during `init` — you have to opt in — and it's worth reviewing its comments carefully rather than trusting auto-approve blindly until it's had more mileage.

Once set up (via `init` or `add-action`), PRsentry runs automatically on every PR opened or updated in that repo:

```yaml
name: PRsentry Review

on:
  pull_request:
    types: [opened, synchronize]

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
      contents: read
    steps:
      - uses: Madrigal-Carl/prsentry@main
        with:
          gemini-api-key: ${{ secrets.GEMINI_API_KEY }}
```

Add `GEMINI_API_KEY` as a repo secret under **Settings → Secrets and variables → Actions**. `github-token` defaults to the built-in `${{ github.token }}`, so you don't need to set it manually unless you need broader permissions.

The Action always runs with auto-approve on (via an `auto-approve: 'true'` input, which you can override to `'false'` if needed), since GitHub Actions runners have no terminal to answer an interactive approve/reject prompt with.

The Action only reviews PRs in the repo it's installed in — the PR number and repo are both pulled from the triggering workflow's own context. It coexists fine alongside any other workflows you already have (e.g. a Laravel or other CI pipeline) — each `.github/workflows/*.yml` file runs independently.

> **Note:** the Action currently points at `@main`, which tracks whatever's latest on the default branch rather than a fixed release. Until a tagged version is published, treat this the same as any other experimental dependency pinned to a moving target.

## License

MIT