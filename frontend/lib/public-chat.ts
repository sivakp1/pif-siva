import { z } from "zod";

// Public chat (no sign-in). The browser talks only to /api/public/chat; that route calls the
// PIF data plane /v1/chat with an API key that stays on the server. Every user prompt and every
// model answer is scanned by the firewall.

export const PUBLIC_CHAT_LIMITS = {
  maxMessages: 20, // conversation turns sent per request (most recent kept)
  maxChars: 4000, // per message
  perMinute: 10, // requests per visitor per minute
  perHour: 60, // requests per visitor per hour
};

export const ChatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1, "Message is empty").max(PUBLIC_CHAT_LIMITS.maxChars, `Message must be at most ${PUBLIC_CHAT_LIMITS.maxChars} characters`),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const PublicChatRequestSchema = z
  .object({ messages: z.array(ChatMessageSchema).min(1).max(PUBLIC_CHAT_LIMITS.maxMessages) })
  .strict()
  .refine((r) => r.messages.at(-1)?.role === "user", { message: "The last message must be from the user", path: ["messages"] });

/** What the browser receives: the verdict and the answer, nothing internal. */
export const PublicChatResponseSchema = z.object({
  action: z.enum(["allow", "flag", "sanitize", "block"]),
  output: z.string().nullable(),
  refusal: z.string().nullable(),
  verdict_id: z.string(),
  risk_score: z.number().nullable(),
  categories: z.array(z.string()),
  degraded: z.boolean(),
});
export type PublicChatResponse = z.infer<typeof PublicChatResponseSchema>;

/** Subset of the /v1/chat response the route relies on (backend.md B.2.4). */
export const UpstreamChatSchema = z
  .object({
    verdict_id: z.string(),
    action: z.enum(["allow", "flag", "sanitize", "block"]),
    output: z.string().nullable().optional(),
    refusal: z.string().nullable().optional(),
    input_verdict: z
      .object({
        risk_score: z.number().optional(),
        degraded: z.boolean().optional(),
        findings: z.array(z.object({ category: z.string() }).passthrough()).optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    output_verdict: z
      .object({ risk_score: z.number().optional(), findings: z.array(z.object({ category: z.string() }).passthrough()).optional() })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

export function toPublicResponse(u: z.infer<typeof UpstreamChatSchema>): PublicChatResponse {
  const cats = new Set<string>();
  for (const f of u.input_verdict?.findings ?? []) cats.add(f.category);
  for (const f of u.output_verdict?.findings ?? []) cats.add(f.category);
  const risks = [u.input_verdict?.risk_score, u.output_verdict?.risk_score].filter((r): r is number => typeof r === "number");
  return {
    action: u.action,
    output: u.output ?? null,
    refusal: u.refusal ?? null,
    verdict_id: u.verdict_id,
    risk_score: risks.length ? Math.max(...risks) : null,
    categories: [...cats].sort(),
    degraded: Boolean(u.input_verdict?.degraded),
  };
}

/**
 * Conversation history sent upstream: only turns that were answered. A user message the firewall
 * blocked (and its refusal) is never resent, so the model never sees a blocked prompt as context.
 */
export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
  blocked?: boolean;
}
export function historyForUpstream(turns: ChatTurn[]): ChatMessage[] {
  const kept = turns.filter((t) => !t.blocked).map(({ role, content }) => ({ role, content }));
  return kept.slice(-PUBLIC_CHAT_LIMITS.maxMessages);
}

/**
 * Best-effort per-visitor rate limiter (fixed windows, in memory). Each serverless instance keeps
 * its own counters; the firewall's API throttling is the hard limit behind it.
 */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private perMinute: number, private perHour: number, private now: () => number = Date.now) {}

  /** Returns 0 when allowed, otherwise the seconds to wait. */
  check(key: string): number {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((x) => t - x < 3_600_000);
    const lastMinute = recent.filter((x) => t - x < 60_000);
    if (lastMinute.length >= this.perMinute) return Math.ceil((60_000 - (t - (lastMinute[0] ?? t))) / 1000);
    if (recent.length >= this.perHour) return Math.ceil((3_600_000 - (t - (recent[0] ?? t))) / 1000);
    recent.push(t);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) this.hits.delete(this.hits.keys().next().value as string);
    return 0;
  }
}

export function clientKey(headers: Headers): string {
  const fwd = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return fwd || headers.get("x-real-ip") || "unknown";
}
