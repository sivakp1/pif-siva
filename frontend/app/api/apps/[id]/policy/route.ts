import { errorResponse, proxy, safeSegment } from "@/lib/bff";
import { PolicyResponseSchema, PolicyUpdateRequestSchema } from "@/lib/schemas";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    return proxy({ req, method: "GET", path: `/apps/${safeSegment(id, "app_id")}/policy`, responseSchema: PolicyResponseSchema });
  } catch (err) {
    return errorResponse(err);
  }
}

// Admin only. Sends policy_version for optimistic concurrency; a stale version → 409 CONFLICT (passed through).
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    return proxy({
      req,
      method: "PUT",
      path: `/apps/${safeSegment(id, "app_id")}/policy`,
      requireAdmin: true,
      bodySchema: PolicyUpdateRequestSchema,
      responseSchema: PolicyResponseSchema,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
