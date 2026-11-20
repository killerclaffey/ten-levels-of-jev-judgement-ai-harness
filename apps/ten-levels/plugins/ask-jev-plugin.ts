/**
 * Level 10 OpenCode plugin: ask_jev on any situation.
 *
 *   ask_jev(questions_json, state?, paths?, command?)
 *   Tracks spend ledger and gates commands with Level 6 bash gate.
 */
import { exec } from "node:child_process";
import { tool, type Plugin } from "@opencode-ai/plugin";
import { decide, report } from "./opencode-report.ts";
import { BLOCK_NOTICE, gateBashCommand } from "../src/levels/level06/index.ts";
import {
  ASK_JEV_DESCRIPTION,
  AskStateError,
  assembleState,
  emptyLedger,
  parseQuestions,
  record,
  summarize,
  type CommandOutput,
} from "../src/levels/level10/index.ts";

const COMMAND_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_CHARS = 200_000;

function runCommand(command: string, cwd: string): Promise<CommandOutput> {
  return new Promise((resolve) => {
    exec(command, { cwd, timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_CHARS * 4, env: { ...process.env, CI: "1" } }, (err, stdout, stderr) => {
      const code = err && typeof (err as any).code === "number" ? (err as any).code : err ? null : 0;
      resolve({ command, exit_code: code, stdout: String(stdout).slice(0, MAX_OUTPUT_CHARS), stderr: String(stderr).slice(0, MAX_OUTPUT_CHARS) });
    });
  });
}

export const AskJevPlugin: Plugin = async (ctx) => {
  let ledger = emptyLedger();
  const cwd = ctx.directory || process.cwd();

  return {
    tool: {
      ask_jev: tool({
        description: ASK_JEV_DESCRIPTION,
        args: {
          questions_json: tool.schema.string().describe("The question block, a JSON object keyed by question id"),
          state: tool.schema.string().optional().describe("Your own state: plain text, or a JSON object as a string. Short. Not for pasting files or output."),
          paths: tool.schema
            .union([tool.schema.array(tool.schema.string()), tool.schema.string()])
            .optional()
            .describe('Files or globs for code to read into files["path"]. Up to 20 files.'),
          command: tool.schema.string().optional().describe("A command for code to run in the repo; its result goes into output. Runs through the bash gate."),
        },
        async execute(args) {
          try {
            let pathsList: string[] | undefined;
            if (typeof args.paths === "string") {
              try {
                pathsList = JSON.parse(args.paths);
              } catch {
                pathsList = args.paths.split(",").map((s) => s.trim());
              }
            } else if (Array.isArray(args.paths)) {
              pathsList = args.paths;
            }

            const questions = parseQuestions(args.questions_json);
            const run = async (command: string, dir: string) => {
              const gate = await gateBashCommand(command, dir, (s, q) => decide(ctx, "ask_jev command gate", s, q));
              report(ctx, "hook", { hook: "ask_jev command", tool: "bash", command, block: gate.block, reason: gate.reason });
              if (gate.block) {
                throw new AskStateError(`ask_jev: the command was refused by the bash gate: ${gate.reason}. ${BLOCK_NOTICE} ask_jev commands should only read.`);
              }
              return runCommand(command, dir);
            };

            const { state, summary } = await assembleState({ state: args.state, paths: pathsList, command: args.command }, cwd, run);
            const result = await decide(ctx, "ask_jev", state, questions, { summary });
            ledger = record(ledger, result.usage as any, Object.keys(result.answers).length);
            report(ctx, "ledger", { ...ledger, summary: summarize(ledger, 0) });
            return JSON.stringify({ answers: result.answers, state_summary: summary, usage: result.usage, model: result.model }, null, 2);
          } catch (err: any) {
            const text = err instanceof AskStateError ? err.message : `ask_jev error: ${err?.message ?? err}`;
            report(ctx, "error", { hook: "ask_jev", message: text });
            return `error: ${text}`;
          }
        },
      }),
    },
  };
};

export default AskJevPlugin;
