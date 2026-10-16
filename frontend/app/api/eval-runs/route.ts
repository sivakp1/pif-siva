import { proxy } from "@/lib/bff";
import { CreateEvalRunRequestSchema, CreateEvalRunResponseSchema, EvalRunListResponseSchema } from "@/lib/schemas";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return proxy({ req, method: "GET", path: "/eval-runs", responseSchema: EvalRunListResponseSchema });
}

export async function POST(req: Request) {
  return proxy({
    req,
    method: "POST",
    path: "/eval-runs",
    requireAdmin: true,
    bodySchema: CreateEvalRunRequestSchema,
    responseSchema: CreateEvalRunResponseSchema,
    successStatus: 201,
  });
}
