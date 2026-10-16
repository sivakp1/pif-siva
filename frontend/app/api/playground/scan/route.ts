import { proxy } from "@/lib/bff";
import { PlaygroundScanRequestSchema, ScanResultSchema } from "@/lib/schemas";

export const dynamic = "force-dynamic";

// Analyst+ (backend.md B.2.2). Rate limited by the backend (BE-15); 429 + Retry-After are passed through.
export async function POST(req: Request) {
  return proxy({
    req,
    method: "POST",
    path: "/playground/scan",
    bodySchema: PlaygroundScanRequestSchema,
    responseSchema: ScanResultSchema,
  });
}
