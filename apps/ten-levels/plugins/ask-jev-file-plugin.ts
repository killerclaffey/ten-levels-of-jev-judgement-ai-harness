/**
 * Level 8 OpenCode plugin: cheap reads. Three tools, one file each.
 *
 *   ask_jev_file_bool(path, question, yes?, no?)
 *   ask_jev_file_choice(path, question, options)
 *   ask_jev_file_score(path, question, levels)
 */
import { tool, type Plugin } from "@opencode-ai/plugin";
import { decide } from "./opencode-report.ts";
import { askFileBool, askFileChoice, askFileScore, FileStateError } from "../src/levels/level08/index.ts";

const WHEN =
  "Use this for a judgment about what a file does or contains, without reading it into your context. " +
  "Write the question against `content`, which is the file's text. Use the read tool instead when you need the code itself, to edit or quote it. " +
  "Exact lookups, does this string appear, how many lines, belong to grep, not here.";

export const AskJevFilePlugin: Plugin = async (ctx) => {
  const cwd = ctx.directory || process.cwd();

  return {
    tool: {
      ask_jev_file_bool: tool({
        description: `Yes or no about one file. Returns { path, answer, noul } where noul is the probability of yes, 0 to 1. ${WHEN}`,
        args: {
          path: tool.schema.string().describe("File path, relative to the repo"),
          question: tool.schema.string().describe("A yes or no question about `content`, for example: Does `content` validate authentication tokens?"),
          yes: tool.schema.string().optional().describe("What counts as yes"),
          no: tool.schema.string().optional().describe("What counts as no"),
        },
        async execute(args) {
          try {
            const res = await askFileBool(
              args.path,
              args.question,
              cwd,
              { yes: args.yes, no: args.no },
              (s, q) => decide(ctx, "ask_jev_file_bool", s, q, { path: args.path })
            );
            return JSON.stringify(res, null, 2);
          } catch (err: any) {
            return err instanceof FileStateError ? err.message : `error: ${err?.message ?? err}`;
          }
        },
      }),

      ask_jev_file_choice: tool({
        description: `Pick one option about one file. Returns { path, choice, confidence, probabilities }. The choice is always one of your options; an "other" option is added if you leave none. ${WHEN}`,
        args: {
          path: tool.schema.string().describe("File path, relative to the repo"),
          question: tool.schema.string().describe("The question, for example: Which layer is `content`?"),
          options: tool.schema
            .union([tool.schema.record(tool.schema.string(), tool.schema.string()), tool.schema.string()])
            .describe("Option name to description object or JSON string. Up to 255 options."),
        },
        async execute(args) {
          try {
            let opts: Record<string, string> = {};
            if (typeof args.options === "string") {
              try {
                opts = JSON.parse(args.options);
              } catch {
                opts = { option_a: args.options, other: "none of the above" };
              }
            } else if (typeof args.options === "object" && args.options !== null) {
              opts = args.options;
            }
            const res = await askFileChoice(
              args.path,
              args.question,
              opts,
              cwd,
              (s, q) => decide(ctx, "ask_jev_file_choice", s, q, { path: args.path })
            );
            return JSON.stringify(res, null, 2);
          } catch (err: any) {
            return err instanceof FileStateError ? err.message : `error: ${err?.message ?? err}`;
          }
        },
      }),

      ask_jev_file_score: tool({
        description: `A position on a scale you define, about one file. Returns { path, score, top, nearest, confidence, legend }. Levels are ordered low to high, two to ten of them, each a described situation. ${WHEN}`,
        args: {
          path: tool.schema.string().describe("File path, relative to the repo"),
          question: tool.schema.string().describe("The question, for example: How risky is a refactor of `content`?"),
          levels: tool.schema
            .union([tool.schema.array(tool.schema.string()), tool.schema.string()])
            .describe("Ordered low to high, each level a situation, or a JSON array of strings."),
        },
        async execute(args) {
          try {
            let lvls: string[] = [];
            if (typeof args.levels === "string") {
              try {
                lvls = JSON.parse(args.levels);
              } catch {
                lvls = args.levels.split(",").map((s) => s.trim());
              }
            } else if (Array.isArray(args.levels)) {
              lvls = args.levels;
            }
            const res = await askFileScore(
              args.path,
              args.question,
              lvls,
              cwd,
              (s, q) => decide(ctx, "ask_jev_file_score", s, q, { path: args.path })
            );
            return JSON.stringify(res, null, 2);
          } catch (err: any) {
            return err instanceof FileStateError ? err.message : `error: ${err?.message ?? err}`;
          }
        },
      }),
    },
  };
};

export default AskJevFilePlugin;
