import { generateText, streamText } from "ai";
import { formatLlmError, isLikelyRequestOrStreamFailure } from "./errorDetail";

export interface LlmTurnArgs {
  model: any;
  system: any;
  messages: any[];
  tools: Record<string, any>;
  stopWhen: (args: { steps: any[] }) => boolean;
  temperature?: number;
}

export interface LlmTurnResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  toolCallCount: number;
  toolCallsMade: { toolName: string; input: unknown }[];
}

function callArgs(args: LlmTurnArgs) {
  return {
    model: args.model,
    system: args.system,
    messages: args.messages,
    tools: args.tools,
    stopWhen: args.stopWhen,
    ...(args.temperature !== undefined ? { temperature: args.temperature } : {}),
  };
}

function fromUsage(usage: any) {
  return {
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    cachedTokens: usage?.cachedInputTokens ?? 0,
  };
}

function fromSteps(steps: any[] | undefined) {
  const list = steps ?? [];
  return {
    toolCallCount: list.reduce((n, s) => n + (s.toolCalls?.length ?? 0), 0),
    toolCallsMade: list.flatMap((s) =>
      (s.toolCalls ?? []).map((tc: any) => ({
        toolName: tc.toolName as string,
        input: tc.input,
      })),
    ),
  };
}

async function streamTurn(args: LlmTurnArgs): Promise<LlmTurnResult> {
  const result = streamText(callArgs(args));
  let text = "";
  for await (const chunk of result.textStream) {
    text += chunk;
  }
  const usage = await result.usage;
  const steps = await result.steps;
  return { text, ...fromUsage(usage), ...fromSteps(steps) };
}

async function generateTurn(args: LlmTurnArgs): Promise<LlmTurnResult> {
  const result = await generateText(callArgs(args));
  return {
    text: result.text ?? "",
    ...fromUsage(result.usage),
    ...fromSteps(result.steps),
  };
}

/**
 * streamText primero (todas las providers). Si OpenAI/Workers devuelve 400
 * o un stream vacío, un generateText no-SSE suele pasar — Telegram igual
 * espera el texto completo antes de mandar chunks.
 */
export async function runLlmTurn(args: LlmTurnArgs): Promise<LlmTurnResult> {
  try {
    return await streamTurn(args);
  } catch (e) {
    if (!isLikelyRequestOrStreamFailure(e)) throw e;
    console.warn("[runLlmTurn] streamText failed; retrying without SSE:", formatLlmError(e));
    return await generateTurn(args);
  }
}
