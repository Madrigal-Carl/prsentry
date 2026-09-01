#!/usr/bin/env node

import dotenv from "dotenv";
import { Command } from "commander";
import { Octokit } from "@octokit/rest";
import { GoogleGenAI } from "@google/genai";
import { writeFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { join, resolve, isAbsolute } from "path";
import prompts from "prompts";

const program = new Command();

const STYLE_GUIDE_FILENAME = "PRSENTRY_STYLE_GUIDE.md";
const CONFIG_FILENAME = ".prsentry-config.json";

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

function readConfig() {
    const configPath = join(process.cwd(), CONFIG_FILENAME);

    if (!existsSync(configPath)) {
        return { autoApprove: false, envPath: null };
    }

    try {
        const raw = readFileSync(configPath, "utf-8");
        return { autoApprove: false, envPath: null, ...JSON.parse(raw) };
    } catch (error) {
        console.log(`Warning: could not parse ${CONFIG_FILENAME}, using defaults.`);
        return { autoApprove: false, envPath: null };
    }
}

function ensureConfigGitignored() {
    const gitignorePath = join(process.cwd(), ".gitignore");

    try {
        if (!existsSync(gitignorePath)) {
            writeFileSync(gitignorePath, `${CONFIG_FILENAME}\n`);
            console.log(`✔ Created .gitignore and added ${CONFIG_FILENAME}`);
            return;
        }

        const content = readFileSync(gitignorePath, "utf-8");
        const alreadyIgnored = content
            .split(/\r?\n/)
            .some((line) => line.trim() === CONFIG_FILENAME);

        if (!alreadyIgnored) {
            const needsLeadingNewline = content.length > 0 && !content.endsWith("\n");
            writeFileSync(gitignorePath, content + (needsLeadingNewline ? "\n" : "") + `${CONFIG_FILENAME}\n`);
            console.log(`✔ Added ${CONFIG_FILENAME} to .gitignore`);
        }
    } catch (error) {
        console.log(`Warning: could not update .gitignore automatically (${error.message}). Add "${CONFIG_FILENAME}" to it manually so it isn't committed.`);
    }
}

function writeConfig(config) {
    const configPath = join(process.cwd(), CONFIG_FILENAME);
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    ensureConfigGitignored();
}

function resolveEnvPath(cliEnvPath, config) {
    const candidate = cliEnvPath || process.env.PRSENTRY_ENV_FILE || config.envPath || ".env";
    return isAbsolute(candidate) ? candidate : resolve(process.cwd(), candidate);
}

function loadEnv(cliEnvPath, config) {
    const envPath = resolveEnvPath(cliEnvPath, config);

    if (!existsSync(envPath)) {
        return { envPath, loaded: false };
    }

    dotenv.config({ path: envPath });
    return { envPath, loaded: true };
}

program
    .name("prsentry")
    .description("AI-powered PR reviewer that checks pull requests against your repo's style guide")
    .version("1.0.4")
    .option(
        "-e, --env-file <path>",
        "path to a .env file containing GEMINI_API_KEY and GITHUB_TOKEN (overrides config and PRSENTRY_ENV_FILE)"
    );

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
            type: "select",
            name: "setupAction",
            message: "Also set up a GitHub Action to run PRsentry automatically on new PRs?",
            choices: [
                { title: "Yes", value: true },
                { title: "No", value: false },
            ],
        });

        if (response.setupAction) {
            createWorkflowFile();
            console.log("Reminder: add GEMINI_API_KEY as a repo secret on GitHub (Settings → Secrets and variables → Actions) for the Action to work.");
        } else {
            console.log("Skipping GitHub Action setup. Run `prsentry add-action` later if you change your mind.");
        }

        const customEnvResponse = await prompts({
            type: "select",
            name: "useCustomEnv",
            message: "Use a custom .env file location instead of the default ./.env?",
            choices: [
                { title: "Yes", value: true },
                { title: "No", value: false },
            ],
        });

        if (customEnvResponse.useCustomEnv) {
            const envResponse = await prompts({
                type: "text",
                name: "envPath",
                message: "Path to your .env file (relative or absolute):",
                initial: "",
            });

            if (envResponse.envPath && envResponse.envPath.trim() !== "") {
                const config = readConfig();
                config.envPath = envResponse.envPath.trim();
                writeConfig(config);
                console.log(`✔ Saved env file location to ${CONFIG_FILENAME}: ${config.envPath}`);
            } else {
                console.log("No path entered — keeping the default ./.env.");
            }
        }

        console.log("Reminder: make sure GEMINI_API_KEY and GITHUB_TOKEN are set in that .env file to run `prsentry review` manually.");
    });

program
    .command("add-action")
    .description("Add the GitHub Action workflow file (if you skipped it during init)")
    .action(() => {
        createWorkflowFile();
        console.log("Reminder: add GEMINI_API_KEY as a repo secret on GitHub (Settings → Secrets and variables → Actions) for the Action to work.");
    });

program
    .command("auto-approve")
    .description("Turn automatic approval of PRsentry findings on or off")
    .argument("<state>", "on or off")
    .action((state) => {
        const normalized = state.toLowerCase();

        if (normalized !== "on" && normalized !== "off") {
            console.error("Error: state must be 'on' or 'off'");
            process.exit(1);
        }

        const config = readConfig();
        config.autoApprove = normalized === "on";
        writeConfig(config);

        console.log(`✔ Auto-approve is now ${config.autoApprove ? "ON" : "OFF"}`);
    });

program
    .command("set-env-path")
    .description("Set (or clear) the .env file path PRsentry should load GEMINI_API_KEY and GITHUB_TOKEN from")
    .argument("[path]", "relative or absolute path to a .env file; omit to clear the saved path")
    .action((path) => {
        const config = readConfig();
        config.envPath = path || null;
        writeConfig(config);

        if (path) {
            console.log(`✔ Env file path saved to ${CONFIG_FILENAME}: ${path}`);
        } else {
            console.log(`✔ Cleared saved env file path. PRsentry will fall back to PRSENTRY_ENV_FILE or ./.env.`);
        }
    });

function loadStyleGuide() {
    const styleGuidePath = join(process.cwd(), STYLE_GUIDE_FILENAME);

    if (existsSync(styleGuidePath)) {
        console.log(`Using ${STYLE_GUIDE_FILENAME} (${styleGuidePath})`);
        return readFileSync(styleGuidePath, "utf-8");
    }

    console.log(`No ${STYLE_GUIDE_FILENAME} found in ${process.cwd()}, using default style guide. Run \`prsentry init\` to create one.`);
    return DEFAULT_STYLE_GUIDE;
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

async function reviewFindings(findings, config) {
    if (config.autoApprove) {
        console.log(`Auto-approve is ON — applying all ${findings.length} finding(s) automatically.`);
        return findings;
    }

    const approved = [];
    let alwaysApprove = false;

    for (const finding of findings) {
        console.log(`\n[${finding.severity.toUpperCase()}] ${finding.file}:${finding.line}`);
        console.log(finding.comment);

        if (alwaysApprove) {
            approved.push(finding);
            continue;
        }

        const response = await prompts({
            type: "select",
            name: "decision",
            message: "What do you want to do with this comment?",
            choices: [
                { title: "Approve", value: "approve" },
                { title: "Always approve (apply this and all future findings automatically)", value: "always" },
                { title: "Reject", value: "reject" },
            ],
        });

        if (response.decision === "approve") {
            approved.push(finding);
        } else if (response.decision === "always") {
            approved.push(finding);
            alwaysApprove = true;
            config.autoApprove = true;
            writeConfig(config);
            console.log("✔ Auto-approve turned ON — remaining findings in this run (and future runs) will be applied automatically. Run `prsentry auto-approve off` to turn it back off.");
        } else {
            console.log("Rejected — this comment will not be posted.");
        }
    }

    return approved;
}

program
    .command("review")
    .description("Review a pull request")
    .argument("<pr-number>", "the pull request number to review")
    .option("-r, --repo <owner/repo>", "the GitHub repo to review (e.g. octocat/hello-world)")
    .option("--auto-approve", "apply all findings automatically without an interactive prompt (does not persist to config — use for CI, where there's no TTY)")
    .action(async (prNumber, options, command) => {
        if (!options.repo) {
            console.error("Error: --repo is required (e.g. --repo owner/reponame)");
            process.exit(1);
        }

        const [owner, repo] = options.repo.split("/");

        // Global --env-file flag lives on the root program, not the subcommand.
        const globalOptions = command.parent.opts();
        const config = readConfig();
        const { envPath, loaded } = loadEnv(globalOptions.envFile, config);

        if (loaded) {
            console.log(`Loaded environment variables from ${envPath}`);
        } else {
            console.log(`No .env file found at ${envPath} — falling back to already-set environment variables.`);
        }

        if (!process.env.GITHUB_TOKEN) {
            console.error(`Error: GITHUB_TOKEN not found. Checked ${envPath} and the current environment.`);
            console.error("Set it in that .env file, export it directly, or point to the right file with --env-file / `prsentry set-env-path`.");
            process.exit(1);
        }
        if (!process.env.GEMINI_API_KEY) {
            console.error(`Error: GEMINI_API_KEY not found. Checked ${envPath} and the current environment.`);
            console.error("Set it in that .env file, export it directly, or point to the right file with --env-file / `prsentry set-env-path`.");
            process.exit(1);
        }

        const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

        console.log(`Fetching PR #${prNumber} from ${owner}/${repo}...`);

        let prMeta;
        try {
            const { data } = await octokit.rest.pulls.get({
                owner,
                repo,
                pull_number: Number(prNumber),
            });
            prMeta = data;
        } catch (error) {
            console.error("Failed to fetch PR metadata:", error.message);
            process.exit(1);
        }

        // Uses the local PRSENTRY_STYLE_GUIDE.md in the current working directory —
        // not whatever is (or isn't) committed to the GitHub repo — so edits to
        // your style guide apply immediately without needing to push first.
        const styleGuide = loadStyleGuide();

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

        // The --auto-approve flag forces auto-approve for this run only (handy for
        // CI, which has no TTY to answer prompts) without writing it to
        // .prsentry-config.json. If the user picks "Always approve" interactively,
        // reviewFindings still persists that to the real config object below.
        const runConfig = { ...config, autoApprove: config.autoApprove || Boolean(options.autoApprove) };
        const approvedFindings = await reviewFindings(result.findings, runConfig);

        if (approvedFindings.length === 0) {
            console.log("\nNo comments approved. Nothing posted to GitHub.");
            process.exit(0);
        }

        console.log(`\nPosting ${approvedFindings.length} approved comment(s) to GitHub...`);

        try {
            await octokit.rest.pulls.createReview({
                owner,
                repo,
                pull_number: Number(prNumber),
                commit_id: prMeta.head.sha,
                event: "COMMENT",
                body: `PRsentry found ${approvedFindings.length} approved issue(s) based on the repo's style guide.`,
                comments: approvedFindings.map((f) => ({
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