/** Audio stays on the host: only a loopback Whisper service is accepted. */
const MAX_AUDIO_BYTES = 32 * 1024 * 1024;

export function whisperServiceUrl(): URL {
	const url = new URL(process.env.LH_WHISPER_URL || "http://127.0.0.1:8780");
	if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password) throw new Error("Local Whisper must use a loopback HTTP address.");
	return url;
}

export async function dictationConfiguration(): Promise<Response> {
	if (process.env.LH_DICTATION_PROVIDER === "deepgram") return Response.json({ provider: "deepgram" }, { headers: { "Cache-Control": "no-store" } });
	try {
		const response = await fetch(new URL("/health", whisperServiceUrl()), { signal: AbortSignal.timeout(3000), cache: "no-store" });
		const health = await response.json();
		if (!response.ok || health.ready !== true) throw new Error("not ready");
		return Response.json({ provider: "local-whisper", language: "en", locale: "en-GB", ready: true }, { headers: { "Cache-Control": "no-store" } });
	} catch {
		return Response.json({ provider: "local-whisper", ready: false, message: "Local Whisper is not running. Start it and try again." }, { status: 503, headers: { "Cache-Control": "no-store" } });
	}
}

export async function transcribeLocally(request: Request): Promise<Response> {
	const origin = request.headers.get("origin");
	const appUrl = new URL(request.url);
	// Next may normalise request.url to localhost while the browser uses
	// 127.0.0.1. Host retains the actual app origin in that case.
	const appOrigin = `${appUrl.protocol}//${request.headers.get("host") || appUrl.host}`;
	if (origin && origin !== appOrigin) return Response.json({ message: "Use dictation from this app." }, { status: 403 });
	if (request.headers.get("content-type")?.split(";")[0] !== "audio/wav") return Response.json({ message: "A WAV recording is required." }, { status: 415 });
	if (Number(request.headers.get("content-length")) > MAX_AUDIO_BYTES) return Response.json({ message: "The recording is too long." }, { status: 413 });
	const reader = request.body?.getReader();
	if (!reader) return Response.json({ message: "The recording is empty." }, { status: 400 });
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			length += value.byteLength;
			if (length > MAX_AUDIO_BYTES) { await reader.cancel(); return Response.json({ message: "The recording is too long." }, { status: 413 }); }
			chunks.push(value);
		}
		const audio = Buffer.concat(chunks);
		if (length < 44 || audio.toString("ascii", 0, 4) !== "RIFF" || audio.toString("ascii", 8, 12) !== "WAVE") return Response.json({ message: "The recording is not a WAV file." }, { status: 422 });
		const response = await fetch(new URL("/transcribe", whisperServiceUrl()), {
			method: "POST", headers: { "Content-Type": "audio/wav", "X-LearnHarness-Local-Whisper": "1" },
			body: audio, signal: AbortSignal.any([request.signal, AbortSignal.timeout(300_000)]),
		});
		const result = await response.json();
		if (!response.ok) return Response.json({ message: typeof result.message === "string" ? result.message : "Local transcription failed." }, { status: response.status });
		if (typeof result.text !== "string") throw new Error("Invalid transcription result");
		return Response.json({ text: result.text, language: "en", locale: "en-GB" }, { headers: { "Cache-Control": "no-store" } });
	} catch {
		return Response.json({ message: request.signal.aborted ? "Dictation cancelled." : "Local Whisper is unavailable. Check that it is running and try again." }, { status: request.signal.aborted ? 499 : 503 });
	} finally { reader.releaseLock(); }
}
