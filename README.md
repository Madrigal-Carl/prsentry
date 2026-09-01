# PRsentry

AI-powered PR reviewer that checks pull requests against your repo's style guide — right from the command line or as a GitHub Action.

## How it works

PRsentry pulls a pull request's diff via the GitHub API, sends it to Google's Gemini model along with your repo's style guide, and posts the findings back as inline review comments on the PR.

## Tools used

- **Node.js CLI** — built with [`commander`](https://www.npmjs.com/package/commander)
- **GitHub API** — [`@octokit/rest`](https://www.npmjs.com/package/@octokit/rest) for fetching PR diffs/metadata and posting reviews
- **Gemini API** — [`@google/genai`](https://www.npmjs.com/package/@google/genai), using the `gemini-3.6-flash` model for the actual code review
- **`dotenv`** — loads `GITHUB_TOKEN` and `GEMINI_API_KEY` from a local `.env` file
- **`prompts`** — interactive confirmation prompt during `init`
- **`zod`** — schema validation

## Installation

```bash
npm install -g prsentry
```

Or run it without installing, via `npx`:

```bash
npx prsentry init
```

## Setup

Create a `.env` file in the directory where you'll run `prsentry review`:

```
GITHUB_TOKEN=your_github_personal_access_token
GEMINI_API_KEY=your_gemini_api_key
```

`GITHUB_TOKEN` needs read access to the repo (and write access to PRs if you want it posting reviews). `GEMINI_API_KEY` is your Gemini API key.

## Commands

### `prsentry init`

Sets up PRsentry in the current directory:

- Creates a default `PRSENTRY_STYLE_GUIDE.md` in the project root (skipped if one already exists).
- Prompts you to optionally set up a GitHub Action so reviews run automatically on every new PR. If you accept, it creates `.github/workflows/prsentry.yml` and reminds you to add `GEMINI_API_KEY` as a repo secret.

### `prsentry add-action`

Adds the `.github/workflows/prsentry.yml` GitHub Action workflow on its own — useful if you skipped that step during `init`, or want to add it later.

### `prsentry review <pr-number> --repo <owner/repo>`

Manually reviews a pull request:

```bash
prsentry review 42 --repo octocat/hello-world
```

Fetches the PR diff, sends it to Gemini against your style guide, prints the findings to the console, and posts them as a PR review on GitHub. Requires `GITHUB_TOKEN` and `GEMINI_API_KEY` to be set.

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

This file is fully yours to edit — add, remove, or rewrite any rule to match your team's conventions. On each review, PRsentry looks for `PRSENTRY_STYLE_GUIDE.md` in the target repo first and uses that; if the repo doesn't have one, it falls back to the default guide above.

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

The Action only reviews PRs in the repo it's installed in — the PR number and repo are both pulled from the triggering workflow's own context.

## License

MIT