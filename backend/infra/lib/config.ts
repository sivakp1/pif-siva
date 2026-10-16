export interface PifConfig {
  stage: 'dev' | 'prod';
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

function origins(envVar: string): string[] {
  const raw = process.env[envVar] ?? '';
  const list = raw.split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
  return list.length ? list : ['http://localhost:3000'];
}

export const CONFIGS: Record<'dev' | 'prod', PifConfig> = {
  dev: {
    stage: 'dev',
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
    judgeModelId: HAIKU,
    chatModelId: HAIKU,
    extraChatModelIds: [],
    classifierTimeoutMs: 800, // CORE-16 default
    classifierProvisioned: 1, // NFR-03
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
