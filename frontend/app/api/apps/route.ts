import { proxy } from "@/lib/bff";
import { AppListResponseSchema, CreateAppRequestSchema, CreateAppResponseSchema } from "@/lib/schemas";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return proxy({ req, method: "GET", path: "/apps", responseSchema: AppListResponseSchema });
}

// Admin only. The one-time API key in the response is passed through to the browser for the
// show-once modal and is never logged, cached or stored by the BFF.
export async function POST(req: Request) {
  return proxy({
    req,
    method: "POST",
    path: "/apps",
    requireAdmin: true,
    bodySchema: CreateAppRequestSchema,
    responseSchema: CreateAppResponseSchema,
    successStatus: 201,
  });
}
