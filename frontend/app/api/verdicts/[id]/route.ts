import { errorResponse, proxy, safeSegment } from "@/lib/bff";
import { VerdictDetailSchema } from "@/lib/schemas";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    return proxy({ req, method: "GET", path: `/verdicts/${safeSegment(id, "verdict_id")}`, responseSchema: VerdictDetailSchema });
  } catch (err) {
    return errorResponse(err);
  }
}
