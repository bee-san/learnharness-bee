import { localCliConnections } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json({ connections: await localCliConnections(true) }, { headers: { "Cache-Control": "no-store" } });
}
