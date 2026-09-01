# PRsentry

AI-powered PR reviewer that checks pull requests against your repo's style guide — right from the command line or as a GitHub Action.

## How it works

PRsentry pulls a pull request's diff via the GitHub API, sends it to Google's Gemini model along with your repo's style guide, and posts the findings back as inline review comments on the PR.

Before anything gets posted, you get a say: PRsentry shows you each finding and lets you **approve, always approve, or reject** it — nothing goes to GitHub without your sign-off, unless you've turned on auto-approve.

## Tools used

- **Node.js CLI** — built with [`commander`](https://www.npmjs.com/package/commander)
- **GitHub API** — [`@octokit/rest`](https://www.npmjs.com/package/@octokit/rest) for fetching PR diffs/metadata and posting reviews
- **Gemini API** — [`@google/genai`](https://www.npmjs.com/package/@google/genai), using the `gemini-3.6-flash` model for the actual code review
- **`dotenv`** — loads `GITHUB_TOKEN` and `GEMINI_API_KEY` from a `.env` file, wherever you tell it to look
- **`prompts`** — interactive prompts during `init` and for approving/rejecting review findings
- **`zod`** — schema validation

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

## Commands

### `prsentry init`

Sets up PRsentry in the current directory:

- Creates a default `PRSENTRY_STYLE_GUIDE.md` in the project root (skipped if one already exists).
- Prompts you to optionally set up a GitHub Action so reviews run automatically on every new PR. If you accept, it creates `.github/workflows/prsentry.yml` and reminds you to add `GEMINI_API_KEY` as a repo secret.
- Prompts you to optionally set a custom `.env` file location, saved to `.prsentry-config.json` for future runs.

### `prsentry add-action`

Adds the `.github/workflows/prsentry.yml` GitHub Action workflow on its own — useful if you skipped that step during `init`, or want to add it later.

### `prsentry review <pr-number> --repo <owner/repo>`

Manually reviews a pull request:

```bash
prsentry review 42 --repo octocat/hello-world
```

Fetches the PR diff, sends it to Gemini against your style guide, and prints the findings to the console. Unless auto-approve is on, you'll be prompted for each finding:

- **Approve** — post this one comment
- **Always approve** — post this one and everything remaining, and turn auto-approve on for future runs too
- **Reject** — skip this comment, it won't be posted

Only approved findings are posted as a PR review on GitHub. Requires `GITHUB_TOKEN` and `GEMINI_API_KEY` to be resolvable per the `.env` lookup order above.

**Flags:**
- `-r, --repo <owner/repo>` — the repo to review (required)
- `-e, --env-file <path>` — use this `.env` file for just this run
- `--auto-approve` — apply all findings automatically without prompting, for this run only (doesn't change your saved config — this is what the GitHub Action uses, since CI has no terminal to answer prompts with)

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

> `.prsentry-config.json` is automatically added to `.gitignore` the first time it's written (creating `.gitignore` if you don't have one yet), since it can contain a machine-specific `.env` path and a personal auto-approve preference — not something you'd want to commit or share across a team.

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

## License

MIT