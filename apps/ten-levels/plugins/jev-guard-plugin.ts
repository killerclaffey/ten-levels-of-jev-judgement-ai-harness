/**
 * Level 6 OpenCode plugin: guardrail hooks.
 *
 *   tool.execute.before   bash: gateBashCommand, block irreversible or destructive commands
 *                         write, edit, patch: gateWriteCall, block paths outside repo and credentials
 *   tool.execute.after    read, bash: screenToolResult, prepend warning banner when output carries instructions
 */
import type { Plugin } from "@opencode-ai/plugin";
import { decide, levelConfig, report } from "./opencode-report.ts";
import { BLOCK_NOTICE, gateBashCommand, gateWriteCall, screenToolResult } from "../src/levels/level06/index.ts";

type Option = "A" | "B" | "C";

export const JevGuardPlugin: Plugin = async (ctx) => {
  const cfg = levelConfig<{ gates: Option[] }>({ gates: ["A", "B", "C"] });
  const on = (o: Option) => cfg.gates.includes(o);
  const cwd = ctx.directory || process.cwd();

  return {
    "tool.execute.before": async (input, output) => {
      try {
        const toolName = input.tool;
        const args = { ...((input as any)?.args ?? {}), ...((output as any)?.args ?? {}) };

        if (toolName === "bash" && on("A")) {
          const command = String(args.command ?? "");
          const d = await gateBashCommand(command, cwd, (s, q) => decide(ctx, "tool_call bash", s, q));
          report(ctx, "hook", { hook: "tool_call", tool: "bash", command, block: d.block, reason: d.reason });
          if (d.block) {
            throw new Error(`jev-guard blocked this command: ${d.reason}. ${BLOCK_NOTICE}`);
          }
        }

        if ((toolName === "write" || toolName === "edit" || toolName === "patch" || toolName === "apply_patch") && on("B")) {
          const path = String(args.path ?? args.filePath ?? "");
          const content = String(args.content ?? args.newText ?? args.new_string ?? args.patchText ?? args.patch ?? "");
          const d = await gateWriteCall(path, content, cwd, (s, q) => decide(ctx, `tool_call ${toolName}`, s, q));
          report(ctx, "hook", { hook: "tool_call", tool: toolName, path, block: d.block, reason: d.reason });
          if (d.block) {
            throw new Error(`jev-guard blocked this ${toolName}: ${d.reason}. ${BLOCK_NOTICE}`);
          }
        }
      } catch (err: any) {
        if (err.message?.includes("jev-guard blocked")) {
          throw err;
        }
        report(ctx, "error", { hook: "tool_call", message: err?.message ?? String(err) });
      }
    },

    "tool.execute.after": async (input, output) => {
      const toolName = input.tool;
      if (!on("C") || !(toolName === "read" || toolName === "bash")) return;
      try {
        const text = String(output.output ?? "");
        const d = await screenToolResult(toolName, text, (s, q) => decide(ctx, `tool_result ${toolName}`, s, q));
        report(ctx, "hook", { hook: "tool_result", tool: toolName, flag: d.flag, noul: d.noul, banner: d.banner });
        if (d.flag && d.banner) {
          output.output = `${d.banner}\n\n${text}`;
        }
      } catch (err: any) {
        report(ctx, "error", { hook: "tool_result", message: err?.message ?? String(err) });
      }
    },
  };
};

export default JevGuardPlugin;
