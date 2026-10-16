import { errorResponse, proxy, safeSegment } from "@/lib/bff";
import { UpdateAppStatusRequestSchema, UpdateAppStatusResponseSchema } from "@/lib/schemas";

export const dynamic = "force-dynamic";

// Admin only: disable (or re-enable) an app → PATCH /v1/admin/apps/{app_id} {status}.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    return proxy({
      req,
      method: "PATCH",
      path: `/apps/${safeSegment(id, "app_id")}`,
      requireAdmin: true,
      bodySchema: UpdateAppStatusRequestSchema,
      responseSchema: UpdateAppStatusResponseSchema,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
