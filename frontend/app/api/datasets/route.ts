import { proxy } from "@/lib/bff";
import { DatasetListResponseSchema } from "@/lib/schemas";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return proxy({ req, method: "GET", path: "/datasets", responseSchema: DatasetListResponseSchema });
}
