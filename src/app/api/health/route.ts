import { checkDatabase } from "@/lib/check-database";
import { summarize } from "@/lib/health";

export const dynamic = "force-dynamic";

export async function GET() {
  const health = summarize(await checkDatabase());
  return Response.json(health, { status: health.ok ? 200 : 503 });
}
