/**
 * Level 7 OpenCode plugin: should I compact.
 *
 *   tools: should_i_compact, compact_now
 *   hooks: turn tracking, session compaction instructions
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tool, type Plugin } from "@opencode-ai/plugin";
import { decide, levelConfig, report } from "./opencode-report.ts";
import {
  COMPACT_QUESTIONS,
  DEFAULT_LINES,
  decideTier,
  tierMessage,
  compactVerdict,
  cutPointQuestion,
  cutPointInstructions,
  type CompactAnswers,
  type CompactState,
  type CompactDecision,
  type Lines,
  type TurnSummary,
} from "../src/levels/level07/index.ts";

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export const JevCompactPlugin: Plugin = async (ctx) => {
  const cfg = levelConfig<{ lines: Lines }>({ lines: DEFAULT_LINES });
  const lines: Lines = { ...DEFAULT_LINES, ...(cfg.lines ?? {}) };

  const opencodeDir = join(ctx?.directory || process.cwd(), ".opencode");
  const stateFile = join(opencodeDir, "jev-compact-state.json");

  const userMessages: string[] = [];
  let turn = 0;
  let estimatedTokens = 8000;

  if (existsSync(stateFile)) {
    try {
      const saved = JSON.parse(readFileSync(stateFile, "utf8"));
      if (Array.isArray(saved.userMessages)) userMessages.push(...saved.userMessages);
      if (typeof saved.turn === "number") turn = saved.turn;
      if (typeof saved.estimatedTokens === "number") estimatedTokens = saved.estimatedTokens;
    } catch {}
  }

  function saveState() {
    if (existsSync(opencodeDir)) {
      try {
        writeFileSync(stateFile, JSON.stringify({ userMessages, turn, estimatedTokens }));
      } catch {}
    }
  }

  let current: { decision: CompactDecision; message: string | null; usage: { tokens: number; pct: number }; answers: CompactAnswers } | null = null;

  function usageOf(): { tokens: number; window: number; pct: number } {
    const window = 128_000;
    const tokens = estimatedTokens;
    const pct = (tokens / window) * 100;
    return { tokens, window, pct };
  }

  function buildState(recentText: string, tools: string[] = []): CompactState {
    const previous = [...userMessages.slice(0, -1).map((m) => clip(m, 200))].filter(Boolean).join("\n");
    return {
      current_request: clip(userMessages.at(-1) ?? "Analyze repository", 600),
      previous_work: previous || "(nothing before this request)",
      recent_turn: clip(recentText || `(tool calls only: ${tools.join(", ") || "none"})`, 600),
      tools_this_turn: tools,
    };
  }

  async function evaluate(recentText: string, source: string) {
    const usage = usageOf();
    const state = buildState(recentText);
    const compactable = usage.tokens > 4000;

    if (userMessages.length < 2 && source !== "should_i_compact") {
      const decision: CompactDecision = { tier: "silent", reason: "first request, nothing to move on from" };
      current = { decision, message: null, usage, answers: null as unknown as CompactAnswers };
      report(ctx, "hook", { hook: source, turn, usage, lines, compactable, tier: decision.tier, reason: decision.reason, message: null, skipped: true });
      return current;
    }

    const { answers } = await decide(ctx, source, state, COMPACT_QUESTIONS, { turn, context: usage, lines });
    const a = answers as unknown as CompactAnswers;
    const decision = decideTier(a, usage, compactable, lines, state);
    const message = tierMessage(decision, usage);
    current = { decision, message, usage, answers: a };
    report(ctx, "hook", { hook: source, turn, usage, lines, compactable, tier: decision.tier, reason: decision.reason, message });
    return current;
  }

  return {
    "chat.message": async (input, output) => {
      const text = output.parts
        .filter((p: any) => p.type === "text")
        .map((p: any) => p.text)
        .join("\n");
      if (text && userMessages.at(-1) !== text) {
        userMessages.push(text);
        turn++;
        estimatedTokens += 3500;
        saveState();
      }
    },

    "tool.execute.after": async (input, output) => {
      estimatedTokens += 500;
      saveState();
      if (input.tool !== "should_i_compact" && input.tool !== "compact_now") {
        try {
          await evaluate(String(output.output ?? "").slice(0, 300), "turn_end");
        } catch (err: any) {
          report(ctx, "error", { hook: "turn_end", message: err?.message ?? String(err) });
        }
      }
    },

    "experimental.session.compacting": async (_input, output) => {
      try {
        const turns: TurnSummary[] = userMessages.map((m, i) => ({ index: i, request: clip(m, 120) }));
        if (turns.length >= 2) {
          const { answers } = await decide(ctx, "session_before_compact", { turns }, cutPointQuestion(turns), { context: usageOf() });
          const cut = cutPointInstructions(turns, (answers as any).live_from);
          report(ctx, "hook", { hook: "session_before_compact", liveFrom: cut.liveFrom, confidence: cut.confidence, instructions: cut.instructions });
          output.context.push(cut.instructions);
        }
      } catch (err: any) {
        report(ctx, "error", { hook: "session_before_compact", message: err?.message ?? String(err) });
      }
    },

    tool: {
      should_i_compact: tool({
        description:
          "Ask whether now is a good moment to compact the conversation. Returns should_compact, a tier (silent, notice, recommend, request), the reason, and the current context percent. Cheap, call it freely.",
        args: {},
        async execute() {
          try {
            const r = await evaluate("The agent called should_i_compact to check whether to compact.", "should_i_compact");
            const empty = {
              switched_gears: { type: "noul", noul: 0 },
              at_boundary: { type: "noul", noul: 0 },
              needs_history: { type: "score", score: 2 },
              mid_operation: { type: "noul", noul: 0 },
            } as unknown as CompactAnswers;
            const verdict = compactVerdict(r.decision, r.answers ?? empty, r.usage, lines);
            return JSON.stringify(verdict, null, 2);
          } catch (err: any) {
            return `should_i_compact error: ${err?.message ?? err}`;
          }
        },
      }),

      compact_now: tool({
        description:
          "Compact the conversation now. Pass a short note_to_self: what you were doing, what is done, what is next. The note is kept in the summary so you can pick up where you left off.",
        args: {
          note_to_self: tool.schema.string().describe("Two to five lines: state of the work, next step."),
        },
        async execute(args) {
          const usage = usageOf();
          report(ctx, "compact", { note: args.note_to_self, usage });
          current = null;
          estimatedTokens = 2500;
          saveState();
          report(ctx, "compact-done", { usage: usageOf() });
          return `Compaction recorded. Note saved: "${args.note_to_self}". Context reduced. Continue with the current request.`;
        },
      }),
    },
  };
};

export default JevCompactPlugin;
