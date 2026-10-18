export interface PifConfig {
  stage: 'dev' | 'prod';
  /** Where the judge and /v1/chat models run: Amazon Bedrock or the Anthropic API (key in Secrets Manager) */
  llmProvider: 'bedrock' | 'anthropic';
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

// Bedrock is blocked on the project's AWS account (Error 002), so the Anthropic API is the default.
// Set PIF_LLM_PROVIDER=bedrock to go back; the SSM parameter llm_provider can also be changed live.
const LLM_PROVIDER: PifConfig['llmProvider'] = process.env.PIF_LLM_PROVIDER === 'bedrock' ? 'bedrock' : 'anthropic';

function origins(envVar: string): string[] {
  const raw = process.env[envVar] ?? '';
  const list = raw.split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
  return list.length ? list : ['http://localhost:3000'];
}

export const CONFIGS: Record<'dev' | 'prod', PifConfig> = {
  dev: {
    stage: 'dev',
    llmProvider: LLM_PROVIDER,
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
