#!/usr/bin/env node

import "dotenv/config";
import { Command } from "commander";
import { Octokit } from "@octokit/rest";
import { GoogleGenAI } from "@google/genai";
import { writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import prompts from "prompts";

const program = new Command();

const STYLE_GUIDE_FILENAME = "PRSENTRY_STYLE_GUIDE.md";

const DEFAULT_STYLE_GUIDE = `# Style Guide (MERN Stack)

## General Code Quality
- No console.log statements left in production code (use a proper logger if needed)
- No hardcoded API keys, passwords, tokens, secrets, or connection strings — use environment variables
- Functions should not exceed 50 lines; split large functions into smaller, single-purpose ones
- No commented-out code blocks left in — remove or explain why they're kept
- No magic numbers/strings — use named constants for repeated or meaningful values

## Error Handling
- All async functions must handle errors using try/catch or .catch()
- Never swallow errors silently (empty catch blocks, or catch blocks that only log without handling)
- API route handlers must return proper HTTP status codes on failure, not just 200 with an error message

## Naming
- Variable and function names must be descriptive, not single letters (except loop counters like i, j)
- Boolean variables should read like yes/no questions (e.g. isLoading, hasError — not loading_flag)
- Files and components should use consistent casing (PascalCase for React components, camelCase for utilities)

## Node.js / Express
- Route handlers should not contain business logic directly — delegate to a service/controller layer
- Middleware should be used for cross-cutting concerns (auth, validation, logging) instead of duplicating checks in every route
- Input from req.body, req.query, and req.params must be validated before use — never trust client input directly
- Avoid deeply nested callbacks; prefer async/await over .then() chains for readability

## MongoDB / Mongoose
- Schema fields that reference other documents should use proper ObjectId refs, not raw strings
- Avoid unbounded queries (e.g. Model.find() with no limit) on collections that can grow large — paginate results
- Sensitive fields (passwords, tokens) should use select: false in the schema so they aren't returned by default
- Use .lean() for read-only queries where Mongoose document methods aren't needed, for performance

## React (Frontend)
- Components should not have more than 5-6 useState hooks — consider useReducer or splitting the component
- useEffect hooks must list all dependencies in the dependency array — no suppressed lint warnings without justification
- Avoid inline function definitions inside JSX for expensive operations (recreated on every render)
- API calls should not be made directly inside component bodies — use useEffect, a data-fetching hook, or a query library
- Props drilling more than 2-3 levels deep is a signal to consider Context or a state management library

## Security
- Never expose stack traces or internal error details to the client in production
- CORS configuration should not use a wildcard origin (*) in production
- Passwords must be hashed (e.g. bcrypt) before storage — never stored or logged in plain text
- File uploads must validate file type and size before processing

## API Design
- Endpoints should follow REST conventions (proper use of GET/POST/PUT/PATCH/DELETE)
- Response shapes should be consistent across endpoints (e.g. always { data, error } or similar)
`;

const WORKFLOW_CONTENT = `name: PRsentry Review

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
          gemini-api-key: \${{ secrets.GEMINI_API_KEY }}
`;

function createWorkflowFile() {
    const workflowDir = join(process.cwd(), ".github", "workflows");
    const workflowPath = join(workflowDir, "prsentry.yml");

    if (existsSync(workflowPath)) {
        console.log("GitHub Action workflow already exists. Skipping.");
        return;
    }

    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(workflowPath, WORKFLOW_CONTENT);
    console.log("✔ Created .github/workflows/prsentry.yml");
}

program
    .command("init")
    .description(`Create a default ${STYLE_GUIDE_FILENAME}, optionally with a GitHub Action`)
    .action(async () => {
        const styleGuidePath = join(process.cwd(), STYLE_GUIDE_FILENAME);

        if (existsSync(styleGuidePath)) {
            console.log(`${STYLE_GUIDE_FILENAME} already exists in this directory. Skipping.`);
        } else {
            writeFileSync(styleGuidePath, DEFAULT_STYLE_GUIDE);
            console.log(`✔ Created ${STYLE_GUIDE_FILENAME}`);
        }

        const response = await prompts({
            type: "confirm",
            name: "setupAction",
            message: "Also set up a GitHub Action to run PRsentry automatically on new PRs?",
            initial: false,
        });

        if (response.setupAction) {
            createWorkflowFile();
            console.log("Reminder: add GEMINI_API_KEY as a repo secret on GitHub (Settings → Secrets and variables → Actions) for the Action to work.");
        } else {
            console.log("Skipping GitHub Action setup. Run `prsentry add-action` later if you change your mind.");
        }

        console.log("Reminder: make sure GEMINI_API_KEY and GITHUB_TOKEN are set in your .env file to run `prsentry review` manually.");
    });

program
    .command("add-action")
    .description("Add the GitHub Action workflow file (if you skipped it during init)")
    .action(() => {
        createWorkflowFile();
        console.log("Reminder: add GEMINI_API_KEY as a repo secret on GitHub (Settings → Secrets and variables → Actions) for the Action to work.");
    });

async function fetchStyleGuide(octokit, owner, repo) {
    try {
        const { data } = await octokit.rest.repos.getContent({
            owner,
            repo,
            path: STYLE_GUIDE_FILENAME,
        });
        const content = Buffer.from(data.content, "base64").toString("utf-8");
        console.log(`Using repo's ${STYLE_GUIDE_FILENAME}`);
        return content;
    } catch (error) {
        console.log(`No ${STYLE_GUIDE_FILENAME} found in repo, using default style guide`);
        return DEFAULT_STYLE_GUIDE;
    }
}

const findingSchema = {
    type: "object",
    properties: {
        findings: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    file: { type: "string" },
                    line: { type: "integer" },
                    severity: { type: "string", enum: ["low", "medium", "high"] },
                    comment: { type: "string" },
                },
                required: ["file", "line", "severity", "comment"],
            },
        },
    },
    required: ["findings"],
};

program
    .name("prsentry")
    .description("AI-powered PR reviewer that checks pull requests against your repo's style guide")
    .version("0.1.0");

program
    .command("review")
    .description("Review a pull request")
    .argument("<pr-number>", "the pull request number to review")
    .option("-r, --repo <owner/repo>", "the GitHub repo to review (e.g. octocat/hello-world)")
    .action(async (prNumber, options) => {
        if (!options.repo) {
            console.error("Error: --repo is required (e.g. --repo owner/reponame)");
            process.exit(1);
        }

        const [owner, repo] = options.repo.split("/");

        if (!process.env.GITHUB_TOKEN) {
            console.error("Error: GITHUB_TOKEN not found. Did you create a .env file?");
            process.exit(1);
        }
        if (!process.env.GEMINI_API_KEY) {
            console.error("Error: GEMINI_API_KEY not found. Did you create a .env file?");
            process.exit(1);
        }

        const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        const styleGuide = await fetchStyleGuide(octokit, owner, repo);

        console.log(`Fetching PR #${prNumber} from ${owner}/${repo}...`);

        let diff;
        try {
            const { data } = await octokit.rest.pulls.get({
                owner,
                repo,
                pull_number: Number(prNumber),
                mediaType: { format: "diff" },
            });
            diff = data;
        } catch (error) {
            console.error("Failed to fetch PR diff:", error.message);
            process.exit(1);
        }

        console.log("Sending diff to Gemini for review...");

        let result;
        try {
            const response = await ai.models.generateContent({
                model: "gemini-3.6-flash",
                contents: `You are a strict code reviewer. Review the following diff against this style guide:

${styleGuide}

Only flag real violations of the style guide above. Reference exact file names and line numbers from the diff. If there are no issues, return an empty findings array.

DIFF:
${diff}`,
                config: {
                    temperature: 0,
                    responseMimeType: "application/json",
                    responseSchema: findingSchema,
                },
            });

            result = JSON.parse(response.text);
        } catch (error) {
            console.error("Failed to get review from Gemini:", error.message);
            process.exit(1);
        }

        console.log("--- REVIEW FINDINGS ---");
        if (result.findings.length === 0) {
            console.log("No issues found.");
            process.exit(0);
        }
        result.findings.forEach((f) => {
            console.log(`[${f.severity.toUpperCase()}] ${f.file}:${f.line} — ${f.comment}`);
        });

        console.log("Posting review to GitHub...");

        try {
            const { data: prMeta } = await octokit.rest.pulls.get({
                owner,
                repo,
                pull_number: Number(prNumber),
            });

            await octokit.rest.pulls.createReview({
                owner,
                repo,
                pull_number: Number(prNumber),
                commit_id: prMeta.head.sha,
                event: "COMMENT",
                body: `PRsentry found ${result.findings.length} issue(s) based on the repo's style guide.`,
                comments: result.findings.map((f) => ({
                    path: f.file,
                    line: f.line,
                    side: "RIGHT",
                    body: `**[${f.severity.toUpperCase()}]** ${f.comment}`,
                })),
            });

            console.log("Review posted successfully!");
        } catch (error) {
            console.error("Failed to post review to GitHub:", error.message);
            process.exit(1);
        }
    });

program.parse();