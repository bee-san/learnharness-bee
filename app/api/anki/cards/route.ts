import { ankiRequest } from "@/src/server";
export const dynamic = "force-dynamic";
export function GET(request: Request) {
	return ankiRequest(request, "cards");
}
export function POST(request: Request) {
	return ankiRequest(request, "cards");
}
