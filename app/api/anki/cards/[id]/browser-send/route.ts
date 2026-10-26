import { ankiRequest } from "@/src/server";
export async function POST(
	request: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	return ankiRequest(request, "browser-send", (await params).id);
}
