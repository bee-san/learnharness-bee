import { ankiRequest } from "@/src/server";
export function POST(request: Request) {
	return ankiRequest(request, "coach");
}
