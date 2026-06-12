import Anthropic from "@anthropic-ai/sdk";
import { Resource } from "sst";

/** Default model for every Claude-backed endpoint. */
export const CLAUDE_MODEL = "claude-opus-4-8";
const DEFAULT_MAX_TOKENS = 16000;

let client: Anthropic | undefined;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey: Resource.ANTHROPIC_API_KEY.value });
  }
  return client;
}

export type CompleteOptions = {
  system: string;
  prompt: string;
  model?: string;
  maxTokens?: number;
};

/**
 * Single-shot completion. Streams (and resolves the final message) so large
 * outputs don't hit the SDK's HTTP timeout. Adaptive thinking is on by default.
 * The system prompt is marked cacheable so a stable persona is reused across calls.
 */
export async function complete(options: CompleteOptions): Promise<string> {
  const { system, prompt, model = CLAUDE_MODEL, maxTokens = DEFAULT_MAX_TOKENS } = options;
  const stream = getClient().messages.stream({
    model,
    max_tokens: maxTokens,
    thinking: { type: "adaptive" },
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: prompt }]
  });
  const message = await stream.finalMessage();
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

/**
 * Run a structured-context analysis: a stable `system` persona plus a per-request
 * `instruction` and JSON `context`. Keeps the volatile context after the cached
 * system prompt. Returns Claude's prose.
 */
export async function analyze(options: {
  system: string;
  instruction: string;
  context: unknown;
  model?: string;
  maxTokens?: number;
}): Promise<string> {
  const prompt = [
    options.instruction,
    "",
    "Ground every claim in the numbers below. Do not invent data; if a figure is missing, say so explicitly.",
    "",
    "## Context (JSON)",
    JSON.stringify(options.context, null, 2)
  ].join("\n");
  return complete({
    system: options.system,
    prompt,
    model: options.model,
    maxTokens: options.maxTokens
  });
}

/**
 * `analyze` wrapped so a failed Claude call degrades to a null result with an
 * error note instead of throwing — lets the endpoint still return its computed
 * context. Use in request handlers that should never hard-fail on inference.
 */
export async function safeAnalyze(options: {
  system: string;
  instruction: string;
  context: unknown;
  model?: string;
  maxTokens?: number;
}): Promise<{ analysis: string | null; analysisError: string | null }> {
  try {
    return { analysis: await analyze(options), analysisError: null };
  } catch (cause) {
    console.error("claude.safeAnalyze failed", { cause });
    return { analysis: null, analysisError: "Claude inference failed; returning computed context only." };
  }
}

/** Strip an optional ```json … ``` (or bare ```) fence so the body parses cleanly. */
function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  return (fenced ? fenced[1] : trimmed).trim();
}

/**
 * Like `analyze`, but asks Claude for a single JSON object matching the caller's
 * `shape` description and parses it. Throws if the model returns unparseable JSON.
 * Reuses the same cached-system / volatile-context layout as `analyze`.
 */
export async function analyzeJson<T>(options: {
  system: string;
  instruction: string;
  shape: string;
  context: unknown;
  model?: string;
  maxTokens?: number;
}): Promise<T> {
  const prompt = [
    options.instruction,
    "",
    "Ground every claim in the numbers below. Do not invent data; if a figure is missing, say so explicitly in the relevant note field.",
    "",
    "Return ONLY a single valid JSON object matching this exact shape. No prose, no markdown, no code fences:",
    options.shape,
    "",
    "## Context (JSON)",
    JSON.stringify(options.context, null, 2)
  ].join("\n");
  const raw = await complete({
    system: options.system,
    prompt,
    model: options.model,
    maxTokens: options.maxTokens
  });
  return JSON.parse(stripJsonFence(raw)) as T;
}

/**
 * `analyzeJson` wrapped so a failed call (inference error OR unparseable JSON)
 * degrades to `{ data: null, error }` instead of throwing. Use in crons that
 * should keep the last good cache when an inference run fails.
 */
export async function safeAnalyzeJson<T>(options: {
  system: string;
  instruction: string;
  shape: string;
  context: unknown;
  model?: string;
  maxTokens?: number;
}): Promise<{ data: T | null; error: string | null }> {
  try {
    return { data: await analyzeJson<T>(options), error: null };
  } catch (cause) {
    console.error("claude.safeAnalyzeJson failed", { cause });
    return { data: null, error: "Claude inference or JSON parsing failed." };
  }
}
