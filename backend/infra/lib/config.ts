export interface PifConfig {
  stage: 'dev' | 'prod';
  /** Where the judge and /v1/chat models run: Amazon Bedrock, the Anthropic API or the Gemini API (keys in Secrets Manager) */
  llmProvider: 'bedrock' | 'anthropic' | 'gemini';
  /** Gemini model used when llmProvider is 'gemini' (app and SSM model IDs name Claude models) */
  geminiModelId: string;
  judgeModelId: string;
  chatModelId: string;
  /** Extra Bedrock model IDs apps may choose for /v1/chat */
  extraChatModelIds: string[];
  classifierTimeoutMs: number;
  classifierProvisioned: number;
  verdictTtlDays: number;
  keyGraceHours: number;
  /** Dashboard origins (Vercel production + previews), from env or context */
  dashboardOrigins: string[];
  alarmEmail?: string;
}

const HAIKU = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

// Bedrock is blocked on the project's AWS account (Error 002), so the Gemini API (a Google AI Studio
// key in pif/<stage>/gemini-api-key) is the default. Set PIF_LLM_PROVIDER=bedrock or =anthropic to
// deploy another provider; the SSM parameter llm_provider can also be changed live.
const PROVIDERS: PifConfig['llmProvider'][] = ['bedrock', 'anthropic', 'gemini'];
const LLM_PROVIDER: PifConfig['llmProvider'] =
  PROVIDERS.find((p) => p === process.env.PIF_LLM_PROVIDER) ?? 'gemini';
// gemini-2.5-flash is closed to new API projects; 3.5 Flash-Lite is fast enough for the 2.5 s judge budget.
const GEMINI_MODEL = process.env.PIF_GEMINI_MODEL_ID || 'gemini-3.5-flash-lite';

function origins(envVar: string): string[] {
  const raw = process.env[envVar] ?? '';
  const list = raw.split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
  return list.length ? list : ['http://localhost:3000'];
}

export const CONFIGS: Record<'dev' | 'prod', PifConfig> = {
  dev: {
    stage: 'dev',
    llmProvider: LLM_PROVIDER,
    geminiModelId: GEMINI_MODEL,
    judgeModelId: HAIKU,
    chatModelId: HAIKU,
    extraChatModelIds: [],
    classifierTimeoutMs: 3000, // no provisioned concurrency in dev, so allow cold starts
    classifierProvisioned: 0,
    verdictTtlDays: 30,
    keyGraceHours: 24,
    dashboardOrigins: origins('PIF_DEV_DASHBOARD_ORIGINS'),
    alarmEmail: process.env.PIF_ALARM_EMAIL,
  },
  prod: {
    stage: 'prod',
    llmProvider: LLM_PROVIDER,
    geminiModelId: GEMINI_MODEL,
    judgeModelId: HAIKU,
    chatModelId: HAIKU,
    extraChatModelIds: [],
    classifierTimeoutMs: 800, // CORE-16 default
    // NFR-03 wants 1. New AWS accounts have a 10-execution concurrency quota, which
    // forbids provisioned concurrency; set PIF_PROD_CLASSIFIER_PROVISIONED=1 after
    // raising the quota (Service Quotas -> Lambda -> Concurrent executions).
    classifierProvisioned: Number(process.env.PIF_PROD_CLASSIFIER_PROVISIONED ?? '0'),
    verdictTtlDays: 30,
    keyGraceHours: 24,
    dashboardOrigins: origins('PIF_PROD_DASHBOARD_ORIGINS'),
    alarmEmail: process.env.PIF_ALARM_EMAIL,
  },
};

/** IAM resource ARNs for Bedrock model or cross-region inference-profile IDs. */
export function bedrockModelArns(modelIds: string[], region: string, account: string): string[] {
  const arns = new Set<string>();
  for (const id of modelIds) {
    const m = /^(us|eu|apac|global)\.(.+)$/.exec(id);
    if (m) {
      arns.add(`arn:aws:bedrock:${region}:${account}:inference-profile/${id}`);
      // profiles route to the foundation model in several regions
      arns.add(`arn:aws:bedrock:*::foundation-model/${m[2]}`);
    } else {
      arns.add(`arn:aws:bedrock:${region}::foundation-model/${id}`);
    }
  }
  return [...arns];
}
