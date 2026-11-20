/**
 * Terminal runner for agentic levels (Levels 6 to 10) using the agent session manager (OpenCode or pi).
 *
 * Usage:
 *   node src/agent-runner.mjs 6 A
 *   node src/agent-runner.mjs 10 A
 */
import { SCENARIOS } from "../server/scenarios.mjs";
import * as agents from "../server/agent-session.mjs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const APP = fileURLToPath(new URL("../", import.meta.url));
const EXT_DIR = join(APP, "extensions");
const SANDBOX = join(APP, "sandbox");

const MINT = "\x1b[38;2;128;255;228m";
const MAGENTA = "\x1b[38;2;249;53;248m";
const YELLOW = "\x1b[38;2;255;215;0m";
const RED = "\x1b[38;2;255;99;71m";
const DIM = "\x1b[90m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

async function run() {
  const levelNum = Number(process.argv[2] || 6);
  const optionKey = (process.argv[3] || "A").toUpperCase();
  const inputIndex = Number(process.argv[4] || 0);

  const scenario = SCENARIOS[levelNum];
  if (!scenario || !scenario.agent) {
    console.error(`Level ${levelNum} is not an agent level (choose 6 to 10)`);
    process.exit(1);
  }

  const option = scenario.options.find((o) => o.key === optionKey);
  if (!option) {
    console.error(`Option ${optionKey} not found for level ${levelNum}`);
    process.exit(1);
  }

  const inputSet = option.inputs[inputIndex] || option.inputs[0];
  const harness = agents.detectHarness();

  console.log(`\n${BOLD}${MINT}LEVEL ${levelNum} (${option.key}): ${option.name}${RESET}`);
  console.log(`${DIM}Harness: ${harness} | Backend: ${process.env.JEV_BACKEND || "openrouter/mock"}${RESET}`);
  console.log(`${DIM}Prompt: ${inputSet.prompt}${RESET}\n`);

  const session = agents.start({
    level: levelNum,
    option: option.key,
    extension: join(EXT_DIR, option.extension),
    tools: option.tools,
    cwd: SANDBOX,
    config: inputSet,
  });

  session.subscribe((item) => {
    const { event, data } = item;
    if (event === "prompt") {
      console.log(`${BOLD}${MAGENTA}▶ YOU:${RESET} ${data.message}`);
    } else if (event === "message_end") {
      const text = data.message?.content?.map((c) => c.text).join("") || "";
      if (text) console.log(`${BOLD}${MINT}◀ AGENT:${RESET} ${text.trim()}\n`);
    } else if (event === "tool_execution_start") {
      console.log(`  ${DIM}⚙ TOOL START:${RESET} ${data.toolName}(${JSON.stringify(data.args)})`);
    } else if (event === "tool_execution_end") {
      const statusColor = data.isError ? RED : DIM;
      console.log(`  ${statusColor}⚙ TOOL END [${data.isError ? "BLOCKED/ERROR" : "OK"}]:${RESET} ${data.result?.content?.[0]?.text?.slice(0, 150) ?? ""}`);
    } else if (event === "jev") {
      if (data.kind === "jev") {
        console.log(`  ${YELLOW}◆ JEV DECISION (${data.source}):${RESET} ${JSON.stringify(data.answers)} (${data.ms}ms)`);
      } else if (data.kind === "hook") {
        console.log(`  ${YELLOW}🛡 HOOK (${data.hook}):${RESET} ${data.block !== undefined ? (data.block ? "BLOCKED" : "ALLOWED") : (data.tier || data.instructions || "screened")} ${data.reason || data.banner || ""}`);
      } else if (data.kind === "compact") {
        console.log(`  ${MINT}✂ COMPACT:${RESET} "${data.note}" (${data.usage?.pct?.toFixed(1) || ""}% context)`);
      } else if (data.kind === "compact-done") {
        console.log(`  ${MINT}✂ COMPACT DONE:${RESET} context reset to ${data.usage?.tokens || 2500} tokens`);
      } else if (data.kind === "ledger") {
        console.log(`  ${DIM}📊 LEDGER:${RESET} ${data.summary}`);
      }
    } else if (event === "error") {
      console.error(`  ${RED}✖ ERROR:${RESET} ${data.message}`);
    }
  });

  try {
    await session.prompt(inputSet.prompt);
    if (inputSet.then) {
      console.log(`\n${DIM}Follow-up turn...${RESET}`);
      await session.prompt(inputSet.then);
    }
  } finally {
    session.close();
  }
  console.log(`\n${BOLD}${MINT}✔ Completed Level ${levelNum} Option ${option.key}${RESET}\n`);
}

run().catch((err) => {
  console.error("Runner error:", err);
  process.exit(1);
});
