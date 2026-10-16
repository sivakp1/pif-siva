import { errorResponse, proxy, safeSegment } from "@/lib/bff";
import { RotateKeyResponseSchema } from "@/lib/schemas";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    return proxy({
      req,
      method: "POST",
      path: `/apps/${safeSegment(id, "app_id")}/rotate-key`,
      requireAdmin: true,
      responseSchema: RotateKeyResponseSchema,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
