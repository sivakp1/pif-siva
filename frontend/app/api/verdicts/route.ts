import { errorResponse, proxy, validatedQuery } from "@/lib/bff";
import { VerdictListQuerySchema, VerdictListResponseSchema } from "@/lib/schemas";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const query = validatedQuery(req.url, VerdictListQuerySchema);
    return proxy({ req, method: "GET", path: "/verdicts", query, responseSchema: VerdictListResponseSchema });
  } catch (err) {
    return errorResponse(err);
  }
}
