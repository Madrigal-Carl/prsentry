#!/usr/bin/env node
import { Command } from "commander";

const program = new Command();

program
    .name("prsentry")
    .description("AI-powered PR reviewer that checks pull requests against your repo's style guide")
    .version("0.1.0");

program
    .command("review")
    .description("Review a pull request")
    .argument("<pr-number>", "the pull request number to review")
    .option("-r, --repo <owner/repo>", "the GitHub repo to review (e.g. octocat/hello-world)")
    .action((prNumber, options) => {
        console.log("Review command triggered!");
        console.log("PR number:", prNumber);
        console.log("Options:", options);
    });

program.parse();