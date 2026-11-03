/**
 * Level 9 OpenCode plugin: files at scale.
 *
 *   ask_jev_files(paths_or_globs, questions_json, recursive?)
 *   pick_first_file(question, candidates)
 */
import { tool, type Plugin } from "@opencode-ai/plugin";
import { decide } from "./opencode-report.ts";
import { askFiles, pickFirstFile } from "../src/levels/level09/index.ts";

const QUESTION_SCHEMA =
  'questions_json is a JSON object keyed by question id. Three types. ' +
  'noul: {"type":"noul","instructions":"Does `content` ...?","criteria":{"true":"...","false":"..."}} returns a probability of yes. ' +
  'choice: {"type":"choice","instructions":"Which ... is `content`?","criteria":{"option_a":"when it applies","option_b":"...","other":"none of the above"}} returns one of your keys plus confidence, up to 255 options. ' +
  'score: {"type":"score","instructions":"How ... is `content`?","criteria":["lowest situation","...","highest situation"]} returns a position on your levels, two to ten of them. ' +
  "Write every question against `content`, the file's text; `path` is also in the state. Ask every question you might need in one block, it is one call per file either way.";

export const AskJevFilesPlugin: Plugin = async (ctx) => {
  const cwd = ctx.directory || process.cwd();

  return {
    tool: {
      ask_jev_files: tool({
        description:
          "Ask the same typed questions of many files at once without reading any of them. Code expands globs and directories, " +
          "drops node_modules, .git, binaries, and files over the budget, caps the list at 255, then makes one Jev call per file in parallel. " +
          "Returns { results: [{ path, answers }], skipped: [{ path, reason }], calls }. " +
          QUESTION_SCHEMA +
          " Use read when you need a file's code; use grep for exact strings.",
        args: {
          paths_or_globs: tool.schema
            .union([tool.schema.array(tool.schema.string()), tool.schema.string()])
            .describe('Files, directories, or globs, relative to the repo, for example ["src/**/*.ts"] or ["src/http"]'),
          questions_json: tool.schema.string().describe("The question block as a JSON string"),
          recursive: tool.schema.boolean().optional().describe("For directories: include every file below them. Default false."),
        },
        async execute(args) {
          try {
            let patterns: string[] = [];
            if (typeof args.paths_or_globs === "string") {
              try {
                patterns = JSON.parse(args.paths_or_globs);
              } catch {
                patterns = [args.paths_or_globs];
              }
            } else if (Array.isArray(args.paths_or_globs)) {
              patterns = args.paths_or_globs;
            }

            const result = await askFiles(patterns, args.questions_json, cwd, {
              recursive: args.recursive ?? false,
              decide: (s, q) => decide(ctx, "ask_jev_files", s, q, { path: (s as any).path }),
            });
            return JSON.stringify(result, null, 2);
          } catch (err: any) {
            return `error: ${err?.message ?? err}`;
          }
        },
      }),

      pick_first_file: tool({
        description:
          "After ask_jev_files, choose which of a list of files to open first for a goal. One Choice keyed by path, so the pick is always a real file. " +
          "Returns { path | null, confidence, probabilities }. Pass a short note per path if you have one, for example the answers you already got.",
        args: {
          question: tool.schema.string().describe("The goal, for example: Which file should I open first to fix the proration bug?"),
          candidates: tool.schema
            .union([
              tool.schema.array(tool.schema.object({ path: tool.schema.string(), note: tool.schema.string().optional() })),
              tool.schema.string(),
            ])
            .describe("Paths, with an optional one line note each, or a JSON array."),
        },
        async execute(args) {
          try {
            let candidatesList: Array<{ path: string; note?: string }> = [];
            if (typeof args.candidates === "string") {
              try {
                candidatesList = JSON.parse(args.candidates);
              } catch {
                candidatesList = args.candidates.split(",").map((p) => ({ path: p.trim() }));
              }
            } else if (Array.isArray(args.candidates)) {
              candidatesList = args.candidates;
            }

            const result = await pickFirstFile(args.question, candidatesList, (s, q) =>
              decide(ctx, "pick_first_file", s, q)
            );
            return JSON.stringify(result, null, 2);
          } catch (err: any) {
            return `error: ${err?.message ?? err}`;
          }
        },
      }),
    },
  };
};

export default AskJevFilesPlugin;
