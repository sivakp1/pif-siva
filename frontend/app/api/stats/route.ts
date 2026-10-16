import { errorResponse, proxy, validatedQuery } from "@/lib/bff";
import { StatsQuerySchema, StatsResponseSchema } from "@/lib/schemas";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const query = validatedQuery(req.url, StatsQuerySchema);
    return proxy({ req, method: "GET", path: "/stats", query, responseSchema: StatsResponseSchema });
  } catch (err) {
    return errorResponse(err);
  }
}
