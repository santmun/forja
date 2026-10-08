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

function plainStepText(step: any): string {
  if (typeof step?.text === "string") return step.text;
  if (!Array.isArray(step?.content)) return "";
  return step.content
    .filter((p: any) => p?.type === "text" && typeof p.text === "string")
    .map((p: any) => p.text as string)
    .join("");
}

/**
 * El stream junta el texto de cada paso (antes y después de una tool) sin
 * separador: "…el nuevo horario 💛Ya quedó anotado". Con dos o más trozos,
 * los une con una línea en blanco. Un solo trozo regresa null para dejar
 * el texto original intacto.
 */
export function joinStepTexts(steps: any[] | undefined): string | null {
  if (!steps?.length) return null;
  const parts: string[] = [];
  const push = (raw: string) => {
    const trimmed = raw.trim();
    if (trimmed) parts.push(trimmed);
  };

  for (const step of steps) {
    const content = Array.isArray(step?.content) ? step.content : null;
    const splitByTool = content?.some(
      (p: any) => p?.type === "tool-call" || p?.type === "tool-result",
    );
    if (content && splitByTool) {
      let buf = "";
      for (const part of content) {
        if (part?.type === "text" && typeof part.text === "string") buf += part.text;
        else if (part?.type === "tool-call" || part?.type === "tool-result") {
          push(buf);
          buf = "";
        }
      }
      push(buf);
    } else {
      push(plainStepText(step));
    }
  }

  if (parts.length < 2) return null;
  return parts.join("\n\n");
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
  return { text: joinStepTexts(steps) ?? text, ...fromUsage(usage), ...fromSteps(steps) };
}

async function generateTurn(args: LlmTurnArgs): Promise<LlmTurnResult> {
  const result = await generateText(callArgs(args));
  return {
    text: joinStepTexts(result.steps) ?? result.text ?? "",
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
