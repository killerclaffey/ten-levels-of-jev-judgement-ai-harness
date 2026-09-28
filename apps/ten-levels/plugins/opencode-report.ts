/**
 * Reporting side channel for OpenCode plugins.
 *
 * Emits JEV_EVENT lines on stderr so the lab server folds them into the event stream,
 * exactly matching how the extensions worked with pi.
 */
import { JevClient } from "../src/core/client.ts";
import { validateQuestions, type Answer, type Questions, type State } from "../src/core/types.ts";

let client: JevClient | undefined;
export const jev = () => {
  if (client) return client;
  const backend = (process.env.JEV_BACKEND as any) || (process.env.TYPESAFE_API_KEY ? "typesafe" : process.env.OPENROUTER_API_KEY ? "openrouter" : "mock");
  return (client = new JevClient({ provider: backend }));
};

export function levelConfig<T extends object>(fallback: T): T {
  try {
    const raw = process.env.JEV_LEVEL_CONFIG;
    return raw ? { ...fallback, ...(JSON.parse(raw) as Partial<T>) } : fallback;
  } catch {
    return fallback;
  }
}

export function report(ctx: any, kind: string, payload: Record<string, unknown>): void {
  const body = { kind, at: Date.now(), ...payload };
  process.stderr.write("JEV_EVENT " + JSON.stringify(body) + "\n");
}

export interface Decision {
  answers: Record<string, Answer>;
  usage: { input_tokens: number; output_tokens: number; cost?: number };
  model: string;
  ms: number;
}

export async function decide(
  ctx: any,
  source: string,
  state: State,
  questions: Questions,
  extra: Record<string, unknown> = {}
): Promise<Decision> {
  validateQuestions(questions);
  const started = performance.now();
  const result = await jev().systemOne(state, questions);
  const out: Decision = {
    answers: result.answers,
    usage: result.usage,
    model: result.model,
    ms: Math.round(performance.now() - started),
  };
  report(ctx, "jev", {
    source,
    state,
    questions,
    answers: out.answers,
    usage: out.usage,
    model: out.model,
    ms: out.ms,
    ...extra,
  });
  return out;
}
