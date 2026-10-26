import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { pcmFramesToWav } from "../components/dictation-audio.ts";
import { dictationConfiguration, transcribeLocally, whisperServiceUrl } from "../src/server/local-whisper.ts";

test("WAV encoding preserves typed-array offsets, PCM samples and partial frames", async () => {
	const samples = new Int16Array([100, -200, 300, -400]);
	const wav = new DataView(await pcmFramesToWav([samples.subarray(1, 3), new Int16Array([42]).buffer]).arrayBuffer());
	assert.equal(wav.byteLength, 50);
	assert.equal(wav.getUint32(24, true), 16000);
	assert.equal(wav.getUint16(22, true), 1);
	assert.equal(wav.getUint16(34, true), 16);
	assert.equal(wav.getUint32(40, true), 6);
	assert.deepEqual([44, 46, 48].map((offset) => wav.getInt16(offset, true)), [-200, 300, 42]);
});

test("capture flush delivers the final syllable before acknowledging stop", async () => {
	const messages: { type: string; buffer?: Int16Array }[] = [];
	let Processor: any;
	vm.runInNewContext(await readFile(new URL("../public/worklets/pcm-capture.js", import.meta.url), "utf8"), {
		AudioWorkletProcessor: class { port = { onmessage: null, postMessage: (message: any) => messages.push(message) }; },
		registerProcessor: (_name: string, implementation: any) => { Processor = implementation; },
		Int16Array,
	});
	const capture = new Processor();
	capture.process([[new Float32Array(128).fill(0.25)]]);
	assert(!messages.some((message) => message.type === "audio"), "not yet a full frame");
	capture.port.onmessage({ data: { type: "flush" } });
	assert.deepEqual(messages.slice(-2).map((message) => message.type), ["audio", "flushed"]);
	assert.equal(messages.at(-2)!.buffer!.length, 128);
	assert.equal(messages.at(-2)!.buffer![127], 8191);
});

function isolated(t: { after: (fn: () => void) => void }) {
	const fetch = globalThis.fetch;
	const provider = process.env.LH_DICTATION_PROVIDER, url = process.env.LH_WHISPER_URL;
	delete process.env.LH_DICTATION_PROVIDER; delete process.env.LH_WHISPER_URL;
	t.after(() => {
		globalThis.fetch = fetch;
		if (provider === undefined) delete process.env.LH_DICTATION_PROVIDER; else process.env.LH_DICTATION_PROVIDER = provider;
		if (url === undefined) delete process.env.LH_WHISPER_URL; else process.env.LH_WHISPER_URL = url;
	});
}

test("local dictation is the default and reports English (UK) without minting cloud tokens", async (t) => {
	isolated(t);
	globalThis.fetch = async (url) => { assert.equal(String(url), "http://127.0.0.1:8765/health"); return Response.json({ ready: true }); };
	const response = await dictationConfiguration();
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { provider: "local-whisper", language: "en", locale: "en-GB", ready: true });
	process.env.LH_DICTATION_PROVIDER = "deepgram";
	globalThis.fetch = async () => { throw new Error("no request expected"); };
	assert.deepEqual(await (await dictationConfiguration()).json(), { provider: "deepgram" });
});

test("a missing local engine is actionable and never falls back to a cloud service", async (t) => {
	isolated(t);
	globalThis.fetch = async () => { throw new Error("offline"); };
	const response = await dictationConfiguration();
	assert.equal(response.status, 503);
	assert.equal((await response.json()).provider, "local-whisper");
	for (const url of ["https://example.com", "http://example.com", "http://user:password@localhost:8765"]) {
		process.env.LH_WHISPER_URL = url;
		assert.throws(whisperServiceUrl, /loopback/);
	}
});

test("transcription proxies the WAV only to loopback and preserves British spelling", async (t) => {
	isolated(t);
	const audio = await pcmFramesToWav([new Int16Array([100, -100])]).arrayBuffer();
	let calls = 0;
	globalThis.fetch = async (url, options) => {
		calls++;
		assert.equal(String(url), "http://127.0.0.1:8765/transcribe");
		assert.equal(new Headers(options?.headers).get("X-LearnHarness-Local-Whisper"), "1");
		assert.deepEqual(Buffer.from(options!.body as Buffer), Buffer.from(audio));
		return Response.json({ text: "My favourite colour is blue." });
	};
	const response = await transcribeLocally(new Request("http://localhost:3100/api/stt/transcribe", { method: "POST", headers: { "Content-Type": "audio/wav", Host: "127.0.0.1:3100", Origin: "http://127.0.0.1:3100" }, body: audio }));
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { text: "My favourite colour is blue.", language: "en", locale: "en-GB" });
	assert.equal(calls, 1);
});

test("bad, oversized and cross-origin recordings are rejected before inference", async (t) => {
	isolated(t);
	globalThis.fetch = async () => { assert.fail("invalid audio must never reach inference"); };
	for (const [headers, body, expected] of [
		[{ "Content-Type": "text/plain" }, "not audio", 415],
		[{ "Content-Type": "audio/wav" }, "not audio", 422],
		[{ "Content-Type": "audio/wav", "Content-Length": "999999999" }, "not audio", 413],
		[{ "Content-Type": "audio/wav", Origin: "https://example.com" }, "not audio", 403],
	] as const) {
		assert.equal((await transcribeLocally(new Request("http://127.0.0.1/api/stt/transcribe", { method: "POST", headers, body }))).status, expected);
	}
});

test("cancellation interrupts the local HTTP request and busy errors stay local", async (t) => {
	isolated(t);
	const audio = await pcmFramesToWav([new Int16Array([100])]).arrayBuffer();
	const controller = new AbortController();
	globalThis.fetch = async (_url, options) => new Promise((_resolve, reject) => {
		options!.signal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
		controller.abort();
	});
	const response = await transcribeLocally(new Request("http://127.0.0.1/api/stt/transcribe", { method: "POST", headers: { "Content-Type": "audio/wav" }, body: audio, signal: controller.signal }));
	assert.equal(response.status, 499);
	globalThis.fetch = async () => Response.json({ message: "Another recording is being transcribed." }, { status: 409 });
	const busy = await transcribeLocally(new Request("http://127.0.0.1/api/stt/transcribe", { method: "POST", headers: { "Content-Type": "audio/wav" }, body: audio }));
	assert.equal(busy.status, 409);
});
