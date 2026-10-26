import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
	browserAnkiInvoke,
	browserAnkiUrl,
	requestBrowserAnkiPermission,
} from "../components/anki/browser-transport.ts";
import { emptyAnkiContent } from "../src/core/anki.ts";
import { createAnkiStore } from "../src/store/anki.ts";
import { ankiRequest, sendAnkiCard } from "../src/server/anki.ts";

const destination = {
	deck: "Japanese",
	model: "Basic",
	fields: { front: "Front", back: "Back" },
};
const content = {
	...emptyAnkiContent(),
	front: "What does 昨日 mean?",
	back: "Yesterday",
};
function fixture(t: TestContext) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-anki-browser-test-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const store = createAnkiStore(root);
	const draft = store.create(content);
	return { store, card: store.update(draft.id, 1, { status: "ready" }) };
}
function request(body: unknown, method = "POST") {
	return new Request("https://learn.example/api/anki/cards/test/browser-send", {
		method,
		headers: {
			"Content-Type": "application/json",
			Origin: "https://learn.example",
		},
		body: JSON.stringify(body),
	});
}

test("browser transport uses simple CORS, loopback targeting and no credentials or redirects", async (t) => {
	const previous = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = previous;
	});
	const calls: Array<{ action: string; key?: string }> = [];
	globalThis.fetch = async (url, init) => {
		assert.equal(String(url), "http://127.0.0.1:8765/");
		assert.equal(
			new Headers(init?.headers).get("Content-Type"),
			"text/plain;charset=UTF-8",
		);
		assert.equal(init?.mode, "cors");
		assert.equal(init?.credentials, "omit");
		assert.equal(init?.redirect, "error");
		assert.equal(
			(init as RequestInit & { targetAddressSpace: string }).targetAddressSpace,
			"loopback",
		);
		const body = JSON.parse(String(init?.body));
		calls.push(body);
		return Response.json({
			result:
				body.action === "requestPermission"
					? { permission: "granted", version: 6, requireApikey: true }
					: ["Japanese"],
			error: null,
		});
	};
	const invoke = browserAnkiInvoke("http://127.0.0.1:8765", "client-only-key");
	await requestBrowserAnkiPermission(invoke);
	await invoke("deckNames");
	assert.equal(
		calls[0]!.key,
		undefined,
		"the unauthenticated permission handshake must not carry a key",
	);
	assert.equal(calls[1]!.key, "client-only-key");
});

test("browser endpoints reject public/LAN hosts and permission denial stays actionable", async (t) => {
	for (const url of [
		"http://example.com",
		"http://192.168.1.2:8765",
		"https://localhost:8765",
		"http://localhost:8765/private",
		"http://user:secret@localhost:8765",
	])
		assert.throws(() => browserAnkiUrl(url), /local AnkiConnect/);
	const previous = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = previous;
	});
	globalThis.fetch = async () =>
		Response.json({ result: { permission: "denied" }, error: null });
	await assert.rejects(
		requestBrowserAnkiPermission(
			browserAnkiInvoke("http://localhost:8765", ""),
		),
		/Anki denied access/,
	);
	globalThis.fetch = async () => {
		throw new Error("blocked by browser");
	};
	await assert.rejects(
		browserAnkiInvoke("http://localhost:8765", "")("version"),
		/Apps on device/,
	);
});

test("browser delivery reserves only approved cards without contacting Anki on the server", async (t) => {
	const { store, card } = fixture(t);
	const previous = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = previous;
	});
	globalThis.fetch = async () => {
		assert.fail("browser delivery must not contact the server's Anki");
	};
	const begin = await ankiRequest(
		request({
			operation: "begin",
			revision: card.revision,
			destination,
			deliveryId: "00000000-0000-4000-8000-000000000001",
		}),
		"browser-send",
		card.id,
		store,
	);
	assert.equal(begin.status, 200);
	const leased = (await begin.json()).card;
	assert.equal(leased.status, "ready");
	assert(leased.delivery.id);
	assert(leased.delivery.expiresAt > Date.now());
	const repeated = await ankiRequest(
		request({
			operation: "begin",
			revision: card.revision,
			destination,
			deliveryId: leased.delivery.id,
		}),
		"browser-send",
		card.id,
		store,
	);
	assert.equal(repeated.status, 200);
	assert.equal(
		(await repeated.json()).card.revision,
		leased.revision,
		"a lost begin reply must not create another reservation",
	);
	const draft = store.create(content);
	assert.equal(
		(
			await ankiRequest(
				request({ operation: "begin", revision: 1, destination }),
				"browser-send",
				draft.id,
				store,
			)
		).status,
		422,
	);
});

test("a browser lease blocks other tabs, edits, deletion and server sends", async (t) => {
	const { store, card } = fixture(t);
	const leased = (
		await (
			await ankiRequest(
				request({ operation: "begin", revision: card.revision, destination }),
				"browser-send",
				card.id,
				store,
			)
		).json()
	).card;
	assert.equal(
		(
			await ankiRequest(
				request({ operation: "begin", revision: leased.revision, destination }),
				"browser-send",
				card.id,
				store,
			)
		).status,
		409,
	);
	assert.equal(
		(
			await ankiRequest(
				request({ ...content, revision: leased.revision }, "PUT"),
				"card",
				card.id,
				store,
			)
		).status,
		409,
	);
	assert.equal(
		(
			await ankiRequest(
				request({ revision: leased.revision }, "DELETE"),
				"card",
				card.id,
				store,
			)
		).status,
		409,
	);
	await assert.rejects(
		sendAnkiCard(
			store,
			card.id,
			leased.revision,
			destination,
			"https://learn.example",
		),
		/browser is sending/,
	);
});

test("browser completion records the local note ID and is idempotent after a lost response", async (t) => {
	const { store, card } = fixture(t);
	const leased = (
		await (
			await ankiRequest(
				request({ operation: "begin", revision: card.revision, destination }),
				"browser-send",
				card.id,
				store,
			)
		).json()
	).card;
	const body = {
		operation: "complete",
		revision: leased.revision,
		deliveryId: leased.delivery.id,
		noteId: 1700000000000,
	};
	const completed = await ankiRequest(
		request(body),
		"browser-send",
		card.id,
		store,
	);
	assert.equal(completed.status, 200);
	const saved = store.get(card.id)!;
	assert.equal(saved.status, "sent");
	assert.equal(saved.sentVia, "browser");
	assert.equal(saved.noteId, body.noteId);
	assert.equal(saved.delivery, undefined);
	assert.equal(
		(await ankiRequest(request(body), "browser-send", card.id, store)).status,
		200,
	);
	assert.equal(
		(
			await ankiRequest(
				request({ ...body, operation: "cancel" }),
				"browser-send",
				card.id,
				store,
			)
		).status,
		200,
	);
	assert.equal(store.get(card.id)!.revision, saved.revision);
});

test("failed browser sends release the queue and expired leases cannot acknowledge a newer delivery", async (t) => {
	const { store, card } = fixture(t);
	const begin = async (revision: number) =>
		(
			await (
				await ankiRequest(
					request({ operation: "begin", revision, destination }),
					"browser-send",
					card.id,
					store,
				)
			).json()
		).card;
	const first = await begin(card.revision);
	const cancelled = await ankiRequest(
		request({
			operation: "cancel",
			revision: first.revision,
			deliveryId: first.delivery.id,
		}),
		"browser-send",
		card.id,
		store,
	);
	assert.equal(cancelled.status, 200);
	assert.equal(store.get(card.id)!.status, "ready");
	assert.equal(store.get(card.id)!.delivery, undefined);
	const next = await begin(store.get(card.id)!.revision);
	const expired = store.update(card.id, next.revision, {
		delivery: { ...next.delivery, expiresAt: Date.now() - 1 },
	});
	const replacement = await begin(expired.revision);
	assert.notEqual(replacement.delivery.id, next.delivery.id);
	assert.equal(
		(
			await ankiRequest(
				request({
					operation: "complete",
					revision: replacement.revision,
					deliveryId: next.delivery.id,
					noteId: 123,
				}),
				"browser-send",
				card.id,
				store,
			)
		).status,
		409,
	);
	assert.equal(store.get(card.id)!.status, "ready");
});
