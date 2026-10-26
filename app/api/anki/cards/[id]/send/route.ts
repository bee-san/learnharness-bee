import { ankiRequest } from "@/src/server";
export async function POST(
	request: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	return ankiRequest(request, "send", (await params).id);
}
