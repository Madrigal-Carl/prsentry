#!/usr/bin/env node

import dotenv from "dotenv";
import { Command } from "commander";
import { Octokit } from "@octokit/rest";
import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { writeFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { join, resolve, isAbsolute } from "path";
import prompts from "prompts";

const program = new Command();

const STYLE_GUIDE_FILENAME = "PRSENTRY_STYLE_GUIDE.md";
const CONFIG_FILENAME = ".prsentry-config.json";
const DEFAULT_MODEL = "gemini-3.6-flash";

// Keep each batch of diff sent to Gemini comfortably within its context window
// (style guide + prompt scaffolding also eat into the budget).
const MAX_DIFF_CHARS_PER_BATCH = 60000;

// Retry policy for Gemini calls that get rate limited mid-run. Exponential
// backoff starting at 2s: 2s, 4s, 8s.
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 2000;

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

// NOTE: The GitHub Action integration is experimental. It works, but hasn't
// seen enough real-world PR traffic yet to be considered battle-tested —
// review its comments carefully rather than trusting auto-approve blindly.
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
    console.log("✔ Created .github/workflows/prsentry.yml (experimental)");
}

function readConfig() {
    const configPath = join(process.cwd(), CONFIG_FILENAME);

    if (!existsSync(configPath)) {
        return { autoApprove: false, envPath: null, model: null };
    }

    try {
        const raw = readFileSync(configPath, "utf-8");
        return { autoApprove: false, envPath: null, model: null, ...JSON.parse(raw) };
    } catch (error) {
        console.log(`Warning: could not parse ${CONFIG_FILENAME}, using defaults.`);
        return { autoApprove: false, envPath: null, model: null };
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

function resolveModel(cliModel, config) {
    return cliModel || process.env.GEMINI_MODEL || config.model || DEFAULT_MODEL;
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
    .version("1.1.1")
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
            message: "Also set up a GitHub Action to run PRsentry automatically on new PRs? (experimental — off by default)",
            choices: [
                { title: "No", value: false },
                { title: "Yes", value: true },
            ],
            initial: 0,
        });

        if (response.setupAction) {
            createWorkflowFile();
            console.log("Reminder: this integration is experimental. Add GEMINI_API_KEY as a repo secret on GitHub (Settings → Secrets and variables → Actions) for the Action to work.");
        } else {
            console.log("Skipping GitHub Action setup. Run `prsentry add-action` later if you change your mind (still experimental).");
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
    .description("Add the GitHub Action workflow file (experimental, if you skipped it during init)")
    .action(() => {
        createWorkflowFile();
        console.log("Reminder: this integration is experimental. Add GEMINI_API_KEY as a repo secret on GitHub (Settings → Secrets and variables → Actions) for the Action to work.");
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

program
    .command("set-model")
    .description("Set (or clear) the Gemini model PRsentry should use by default")
    .argument("[model]", `model name (e.g. ${DEFAULT_MODEL}); omit to clear the saved model`)
    .action((model) => {
        const config = readConfig();
        config.model = model || null;
        writeConfig(config);

        if (model) {
            console.log(`✔ Default model saved to ${CONFIG_FILENAME}: ${model}`);
        } else {
            console.log(`✔ Cleared saved model. PRsentry will fall back to GEMINI_MODEL or the built-in default (${DEFAULT_MODEL}).`);
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

// Single source of truth for the shape of a finding. The JSON schema handed
// to Gemini's responseSchema is derived from this zod schema (below) rather
// than hand-duplicated, so the two can't silently drift apart when one is
// edited and the other isn't.
const findingZodSchema = z.object({
    findings: z.array(
        z.object({
            file: z.string(),
            line: z.number().int(),
            severity: z.enum(["low", "medium", "high"]),
            comment: z.string(),
        })
    ),
});

// openApi3 target avoids draft-7-only keywords (like $schema, additionalProperties
// defaults) that Gemini's structured-output schema doesn't understand, and
// inlines the schema instead of using $ref/$defs since we're not naming it.
const findingSchema = zodToJsonSchema(findingZodSchema, { target: "openApi3" });

// Splits a unified diff into one chunk per file, so large diffs can be
// batched without cutting a file's diff in half mid-hunk.
function splitDiffIntoFileChunks(diff) {
    const lines = diff.split("\n");
    const chunks = [];
    let current = [];

    for (const line of lines) {
        if (line.startsWith("diff --git ") && current.length > 0) {
            chunks.push(current.join("\n"));
            current = [];
        }
        current.push(line);
    }
    if (current.length > 0) {
        chunks.push(current.join("\n"));
    }

    return chunks;
}

// Groups per-file diff chunks into batches that each stay under
// maxCharsPerBatch, so a single Gemini request never blows past its context
// window on a large PR. A single file whose diff alone exceeds the budget is
// truncated on its own, with a clear note in place of the missing content.
function batchFileChunks(chunks, maxCharsPerBatch) {
    const batches = [];
    let currentBatch = [];
    let currentLength = 0;

    for (const chunk of chunks) {
        if (chunk.length > maxCharsPerBatch) {
            if (currentBatch.length > 0) {
                batches.push(currentBatch);
                currentBatch = [];
                currentLength = 0;
            }
            const truncated =
                chunk.slice(0, maxCharsPerBatch) +
                "\n\n[... file truncated by PRsentry — diff too large to review in full ...]";
            batches.push([truncated]);
            continue;
        }

        if (currentLength + chunk.length > maxCharsPerBatch && currentBatch.length > 0) {
            batches.push(currentBatch);
            currentBatch = [];
            currentLength = 0;
        }

        currentBatch.push(chunk);
        currentLength += chunk.length;
    }

    if (currentBatch.length > 0) {
        batches.push(currentBatch);
    }

    return batches;
}

function sleep(ms) {
    return new Promise((res) => setTimeout(res, ms));
}

// Recognizes a Gemini rate-limit error across the shapes the SDK/HTTP layer
// might throw it in (a numeric status/code, or a message mentioning 429 /
// RESOURCE_EXHAUSTED), since the SDK doesn't guarantee one consistent form.
function isRateLimitError(error) {
    const status = error?.status ?? error?.code;
    if (status === 429 || status === "429" || status === "RESOURCE_EXHAUSTED") {
        return true;
    }
    return /\b429\b|RESOURCE_EXHAUSTED|rate limit/i.test(error?.message || "");
}

// Wraps a single Gemini generateContent call with exponential backoff, but
// only for rate-limit errors — anything else (bad API key, invalid model,
// malformed request) fails immediately rather than retrying a request that
// will never succeed.
async function generateContentWithRetry(ai, params, batchLabel) {
    let attempt = 0;

    for (; ;) {
        try {
            return await ai.models.generateContent(params);
        } catch (error) {
            if (!isRateLimitError(error) || attempt >= MAX_RETRIES) {
                throw error;
            }

            const delayMs = RETRY_BASE_DELAY_MS * 2 ** attempt;
            attempt += 1;
            console.log(`Rate limited by Gemini on ${batchLabel} — retrying in ${Math.round(delayMs / 1000)}s (attempt ${attempt}/${MAX_RETRIES})...`);
            await sleep(delayMs);
        }
    }
}

// Parses a unified diff into a Map of file path -> Set of line numbers that
// actually exist on the "RIGHT" (post-change) side. GitHub only accepts a
// review comment on a line that's part of the diff; a finding referencing a
// file/line Gemini hallucinated would otherwise cause GitHub to reject that
// comment (and, if posted as part of a single batched review, potentially
// the whole review). Used to filter findings before posting rather than
// discovering the problem at request time.
function buildValidLineIndex(diff) {
    const index = new Map();
    let currentFile = null;
    let rightLine = null;

    for (const line of diff.split("\n")) {
        const fileMatch = line.match(/^\+\+\+ b\/(.+)$/);
        if (fileMatch) {
            currentFile = fileMatch[1];
            if (!index.has(currentFile)) {
                index.set(currentFile, new Set());
            }
            rightLine = null;
            continue;
        }

        const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (hunkMatch) {
            rightLine = Number(hunkMatch[1]);
            continue;
        }

        if (currentFile === null || rightLine === null) {
            continue;
        }

        if (line.startsWith("+")) {
            index.get(currentFile).add(rightLine);
            rightLine += 1;
        } else if (line.startsWith("-")) {
            // Removed line — doesn't exist on the RIGHT side, don't advance.
        } else if (line.startsWith(" ")) {
            // Context line — exists on both sides.
            index.get(currentFile).add(rightLine);
            rightLine += 1;
        }
        // Lines like "diff --git", "index ...", "---" carry no line-number info.
    }

    return index;
}

// Splits findings into ones that reference a real file/line in the diff and
// ones that don't (likely hallucinated), so the latter can be dropped with a
// clear warning instead of failing when posted to GitHub.
function partitionFindingsByValidity(findings, validLineIndex) {
    const valid = [];
    const invalid = [];

    for (const finding of findings) {
        const validLines = validLineIndex.get(finding.file);
        if (validLines && validLines.has(finding.line)) {
            valid.push(finding);
        } else {
            invalid.push(finding);
        }
    }

    return { valid, invalid };
}

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
    .option("--model <model>", `Gemini model to use for this run (overrides GEMINI_MODEL env var and saved config; default: ${DEFAULT_MODEL})`)
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
        const model = resolveModel(options.model, config);

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

        const fileChunks = splitDiffIntoFileChunks(diff);
        const batches = batchFileChunks(fileChunks, MAX_DIFF_CHARS_PER_BATCH);

        if (batches.length > 1) {
            console.log(`Diff is large (${diff.length} chars, ${fileChunks.length} file(s)) — splitting into ${batches.length} batches for review.`);
        }

        let allFindings = [];
        const failedBatches = [];

        for (let i = 0; i < batches.length; i++) {
            const batchDiff = batches[i].join("\n");
            const batchLabel = `batch ${i + 1}/${batches.length}`;
            console.log(`Sending ${batchLabel} to Gemini (model: ${model})...`);

            let response;
            try {
                response = await generateContentWithRetry(
                    ai,
                    {
                        model,
                        contents: `You are a strict code reviewer. Review the following diff against this style guide:

${styleGuide}

Only flag real violations of the style guide above. Reference exact file names and line numbers from the diff. If there are no issues, return an empty findings array.

DIFF:
${batchDiff}`,
                        config: {
                            temperature: 0,
                            responseMimeType: "application/json",
                            responseSchema: findingSchema,
                        },
                    },
                    batchLabel
                );
            } catch (error) {
                // A batch that fails even after retries doesn't take down the whole
                // run — whatever findings other batches already produced are kept,
                // and we surface the failure clearly at the end instead.
                console.error(`Failed to get review from Gemini for ${batchLabel} after retries:`, error.message);
                failedBatches.push(i + 1);
                continue;
            }

            let parsed;
            try {
                parsed = JSON.parse(response.text);
            } catch (error) {
                console.error(`Warning: Gemini's response for ${batchLabel} wasn't valid JSON — skipping this batch's findings.`);
                continue;
            }

            const validated = findingZodSchema.safeParse(parsed);
            if (!validated.success) {
                console.error(`Warning: Gemini's response for ${batchLabel} didn't match the expected shape — skipping this batch's findings.`);
                for (const issue of validated.error.issues) {
                    console.error(`  - ${issue.path.join(".") || "(root)"}: ${issue.message}`);
                }
                continue;
            }

            allFindings = allFindings.concat(validated.data.findings);
        }

        if (failedBatches.length > 0) {
            console.log(`\nWarning: ${failedBatches.length} of ${batches.length} batch(es) failed and were skipped (batch #${failedBatches.join(", #")}). The findings below only reflect the batches that succeeded — re-run \`prsentry review\` to retry the whole PR if you want full coverage.`);
        }

        // Drop findings that reference a file/line not actually present in the
        // diff — almost always a model hallucination — rather than letting a
        // bad position fail when posted to GitHub.
        const validLineIndex = buildValidLineIndex(diff);
        const { valid: validFindings, invalid: invalidFindings } = partitionFindingsByValidity(allFindings, validLineIndex);

        if (invalidFindings.length > 0) {
            console.log(`\nDropped ${invalidFindings.length} finding(s) that referenced a file/line not present in the diff (likely a model hallucination):`);
            for (const f of invalidFindings) {
                console.log(`  - ${f.file}:${f.line}`);
            }
        }

        const result = { findings: validFindings };

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

        // Posted one at a time (rather than as a single batched review) so that
        // one comment GitHub rejects — a stale position, a race with a force-push,
        // etc. — doesn't take the rest of the approved findings down with it.
        let posted = 0;
        let failedToPost = 0;

        for (const finding of approvedFindings) {
            try {
                await octokit.rest.pulls.createReviewComment({
                    owner,
                    repo,
                    pull_number: Number(prNumber),
                    commit_id: prMeta.head.sha,
                    path: finding.file,
                    line: finding.line,
                    side: "RIGHT",
                    body: `**[${finding.severity.toUpperCase()}]** ${finding.comment}`,
                });
                posted += 1;
            } catch (error) {
                failedToPost += 1;
                console.error(`Failed to post comment on ${finding.file}:${finding.line}:`, error.message);
            }
        }

        if (posted > 0) {
            try {
                await octokit.rest.issues.createComment({
                    owner,
                    repo,
                    issue_number: Number(prNumber),
                    body: `PRsentry found ${approvedFindings.length} approved issue(s) based on the repo's style guide. ${posted} posted as inline comment(s)${failedToPost > 0 ? `, ${failedToPost} failed to post — see the run logs.` : "."}`,
                });
            } catch (error) {
                console.error("Failed to post summary comment to GitHub:", error.message);
            }
        }

        if (failedToPost > 0) {
            console.error(`\n${posted} comment(s) posted, ${failedToPost} failed.`);
            process.exit(1);
        }

        console.log(`\n${posted} comment(s) posted successfully!`);
    });

program.parse();