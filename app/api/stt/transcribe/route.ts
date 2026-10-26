import { transcribeLocally } from "@/src/server";

export async function POST(request: Request) { return transcribeLocally(request); }
