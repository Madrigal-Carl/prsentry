#!/usr/bin/env node

import "dotenv/config";
import { Command } from "commander";
import { Octokit } from "@octokit/rest";
import { GoogleGenAI } from "@google/genai";

const program = new Command();

// Hardcoded for now — this becomes a per-repo STYLE_GUIDE.md file later
const STYLE_GUIDE = `
- No console.log statements left in code
- No hardcoded API keys, passwords, or secrets
- Functions should not exceed 50 lines
- Async functions must handle errors (try/catch or .catch())
- Variable and function names should be descriptive, not single letters (except loop counters)
`;

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

${STYLE_GUIDE}

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