import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import {
	ankiContentProblems,
	ankiContentSchema,
	ankiNoteFields,
	ankiTsv,
	clozeParts,
	emptyAnkiContent,
	type AnkiDestination,
} from "../src/core/anki.ts";
import { createAnkiStore } from "../src/store/anki.ts";
import {
	ankiConnectUrl,
	ankiRequest,
	sendAnkiCard,
} from "../src/server/anki.ts";

const content = () => ({
	...emptyAnkiContent({
		title: "My Japanese notes",
		excerpt: "昨日、珈琲を飲みました。",
		reference: "p. 4",
		chatId: "chat_test",
		messageId: "m_test",
	}),
	front: "In 昨日、珈琲を飲みました。, what does 昨日 mean?",
	back: "Yesterday",
	reading: "きのう",
	extra: "A sentence I met in my reading.",
	tags: ["japanese", "vocab"],
});
const destination: AnkiDestination = {
	deck: "Japanese",
	model: "Basic",
	fields: { front: "Front", back: "Back" },
};
function isolated(t: TestContext) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-anki-test-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return { dir, store: createAnkiStore(dir) };
}
function request(
	body: unknown,
	method = "POST",
	origin = "http://localhost:3100",
) {
	return new Request("http://localhost:3100/api/anki/cards", {
		method,
		headers: { "Content-Type": "application/json", Origin: origin },
		body: JSON.stringify(body),
	});
}

test("card validation accepts Japanese and requires an answer for Basic", () => {
	assert.equal(ankiContentSchema.safeParse(content()).success, true);
	assert.deepEqual(ankiContentProblems(content()), []);
	assert.equal(ankiContentProblems({ ...content(), back: " " }).length, 1);
	assert.equal(
		ankiContentSchema.safeParse({ ...content(), tags: ["<script>"] }).success,
		false,
	);
	assert.equal(
		ankiContentSchema.safeParse({
			...content(),
			source: { chatId: "../../auth" },
		}).success,
		false,
	);
});

test("Cloze previews hide answers and validate one retrieval card with optional hints", () => {
	const card = {
		...content(),
		kind: "cloze" as const,
		front: "毎朝、{{c1::珈琲::飲み物}}を飲みます。",
		back: "",
	};
	assert.deepEqual(ankiContentProblems(card), []);
	assert.deepEqual(clozeParts(card.front), [
		{ text: "毎朝、" },
		{ text: "{{c1::珈琲::飲み物}}", answer: "珈琲", hint: "飲み物" },
		{ text: "を飲みます。" },
	]);
	for (const front of [
		"no deletion",
		"{{c2::answer}}",
		"{{c1:: }}",
		"{{c1::broken",
		"{{c1::a}} and {{c2::b}}",
		"{{c1::{{c1::nested}}}}",
	])
		assert(ankiContentProblems({ ...card, front }).length, front);
});

test("Anki output escapes untrusted HTML, preserves clozes, and puts context on answer side", () => {
	const card = {
		...content(),
		front: '<img src=x onerror="alert(1)">',
		back: "A\nB\tC",
		extra: "<script>bad()</script>",
	};
	const fields = ankiNoteFields(
		card,
		destination.fields,
		"http://localhost:3100",
	);
	assert.equal(fields.Front, "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
	assert.match(fields.Back!, /A<br>B\tC/);
	assert.match(fields.Back!, /Reading: きのう/);
	assert.match(fields.Back!, /My Japanese notes/);
	assert.match(
		fields.Back!,
		/http:\/\/localhost:3100\/chat\/chat_test#message-m_test/,
	);
	assert(!fields.Back!.includes("<script>"));
	const separate = ankiNoteFields(
		card,
		{
			...destination.fields,
			reading: "Reading",
			extra: "Extra",
			source: "Source",
		},
		"http://localhost:3100",
	);
	assert.equal(separate.Back, "A<br>B\tC");
	assert.equal(
		separate.Reading,
		"きのう",
		"a separate reading field should contain just the reading",
	);
	assert.match(separate.Source!, /昨日/);
});

test("atomic queue survives reopening, refuses stale revisions, and preserves unknown versions", (t) => {
	const { dir, store } = isolated(t);
	const card = store.create(content());
	assert.deepEqual(createAnkiStore(dir).get(card.id), card);
	const next = store.update(card.id, card.revision, { back: "My wording" });
	assert.equal(next.revision, 2);
	assert.throws(
		() => store.update(card.id, card.revision, { back: "stale" }),
		/another window/,
	);
	assert.throws(() => store.remove(card.id, card.revision), /another window/);
	assert.throws(() => store.get("../auth"), /Invalid/);
	const future = JSON.stringify({ ...next, version: 99 });
	fs.writeFileSync(path.join(dir, `${card.id}.json`), future);
	assert.throws(
		() => store.update(card.id, 2, { back: "overwrite" }),
		/preserved/,
	);
	assert.equal(
		fs.readFileSync(path.join(dir, `${card.id}.json`), "utf8"),
		future,
	);
});

test("approval requires understanding, hidden-answer preview and a valid card; edits return to draft", async (t) => {
	const { store } = isolated(t);
	const created = await ankiRequest(
		request(content()),
		"cards",
		undefined,
		store,
	);
	assert.equal(created.status, 201);
	const { card } = await created.json();
	const body = { ...content(), revision: card.revision, status: "ready" };
	assert.equal(
		(await ankiRequest(request(body, "PUT"), "card", card.id, store)).status,
		422,
	);
	assert.equal(
		(
			await ankiRequest(
				request({ ...body, understood: true }, "PUT"),
				"card",
				card.id,
				store,
			)
		).status,
		422,
	);
	assert.equal(
		(
			await ankiRequest(
				request({ ...body, understood: true, previewed: true }, "PUT"),
				"card",
				card.id,
				store,
			)
		).status,
		200,
	);
	assert.equal(store.get(card.id)!.status, "ready");
	assert.equal(
		(
			await ankiRequest(
				request(
					{ ...body, revision: 2, back: "Yesterday!", status: "draft" },
					"PUT",
				),
				"card",
				card.id,
				store,
			)
		).status,
		200,
	);
	assert.equal(store.get(card.id)!.status, "draft");
});

test("queue mutations reject cross-site, invalid JSON, oversized data and stale tabs", async (t) => {
	const { store } = isolated(t);
	assert.equal(
		(
			await ankiRequest(
				request(content(), "POST", "https://other.example"),
				"cards",
				undefined,
				store,
			)
		).status,
		403,
	);
	const huge = new Request("http://localhost:3100/api/anki/cards", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ source: "x".repeat(110000) }),
	});
	assert.equal(
		(await ankiRequest(huge, "cards", undefined, store)).status,
		413,
	);
	const card = store.create(content());
	store.update(card.id, 1, { back: "new version" });
	assert.equal(
		(
			await ankiRequest(
				request({ ...content(), revision: 1 }, "PUT"),
				"card",
				card.id,
				store,
			)
		).status,
		409,
	);
	assert.equal(store.get(card.id)!.back, "new version");
});

test("portable TSV includes only approved cards of the right kind and preserves quoting", (t) => {
	const { store } = isolated(t);
	store.create(content());
	const basic = store.create({
		...content(),
		front: 'Meaning of "昨日"?\tOne target',
	});
	store.update(basic.id, 1, { status: "ready" });
	const cloze = store.create({
		...content(),
		kind: "cloze",
		front: "昨日 means {{c1::yesterday}}.",
	});
	store.update(cloze.id, 1, { status: "ready" });
	const basicFile = ankiTsv(store.list(), "basic", "http://localhost:3100");
	assert.match(basicFile, /#notetype:Basic\n#tags column:3/);
	assert.match(basicFile, /&quot;昨日&quot;\?\tOne target/);
	assert.equal(
		basicFile.split("\n").filter((r) => r.startsWith('"')).length,
		1,
	);
	const clozeFile = ankiTsv(store.list(), "cloze", "http://localhost:3100");
	assert.match(clozeFile, /#notetype:Cloze/);
	assert.match(clozeFile, /\{\{c1::yesterday\}\}/);
});

test("exports keep the browser's host and HTTPS source links behind a proxy", async (t) => {
	const { store } = isolated(t);
	const card = store.create(content());
	store.update(card.id, 1, { status: "ready" });
	const response = await ankiRequest(
		new Request("http://localhost:3100/api/anki/export?kind=basic", {
			headers: { host: "learn.example.ts.net", "x-forwarded-proto": "https" },
		}),
		"export",
		undefined,
		store,
	);
	assert.match(
		await response.text(),
		/https:\/\/learn.example.ts.net\/chat\/chat_test/,
	);
});

async function fakeAnki(t: TestContext) {
	const oldUrl = process.env.LH_ANKICONNECT_URL;
	const notes: Array<{
		noteId: number;
		modelName: string;
		fields: Record<string, { value: string }>;
		tags: string[];
	}> = [];
	const calls: string[] = [];
	const state = {
		loseReply: false,
		duplicate: false,
		pause: undefined as Promise<void> | undefined,
	};
	const server = createServer(async (req, res) => {
		let text = "";
		for await (const chunk of req) text += chunk;
		const { action, params } = JSON.parse(text);
		calls.push(action);
		let result: unknown;
		switch (action) {
			case "version":
				result = 6;
				break;
			case "deckNames":
				result = ["Japanese"];
				break;
			case "modelNames":
				result = ["Basic", "Cloze"];
				break;
			case "modelFieldNames":
				result =
					params.modelName === "Cloze"
						? ["Text", "Back Extra"]
						: ["Front", "Back"];
				break;
			case "modelTemplates":
				result = {
					Card: {
						Front:
							params.modelName === "Cloze" ? "{{cloze:Text}}" : "{{Front}}",
						Back: "{{Back}}",
					},
				};
				break;
			case "findNotes":
				result = notes
					.filter((n) => n.tags.includes(params.query.slice(4)))
					.map((n) => n.noteId);
				break;
			case "notesInfo":
				result = notes.filter((n) => params.notes.includes(n.noteId));
				break;
			case "canAddNotes":
				result = [!state.duplicate];
				break;
			case "addNote": {
				const note = params.note;
				assert.equal(note.options.allowDuplicate, false);
				const noteId = notes.length + 100;
				notes.push({
					noteId,
					modelName: note.modelName,
					tags: note.tags,
					fields: Object.fromEntries(
						Object.entries(note.fields).map(([name, value]) => [
							name,
							{ value: String(value) },
						]),
					),
				});
				if (state.pause) await state.pause;
				if (state.loseReply) {
					state.loseReply = false;
					res.destroy();
					return;
				}
				result = noteId;
				break;
			}
			default:
				throw new Error(`Unexpected action ${action}`);
		}
		res.setHeader("Content-Type", "application/json");
		res.end(JSON.stringify({ result, error: null }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	process.env.LH_ANKICONNECT_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	t.after(async () => {
		if (oldUrl) process.env.LH_ANKICONNECT_URL = oldUrl;
		else delete process.env.LH_ANKICONNECT_URL;
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	return { notes, calls, state };
}

test("sends approved cards once, preserves content, and refuses modifying sent notes", async (t) => {
	const { store } = isolated(t);
	const remote = await fakeAnki(t);
	const draft = store.create(content());
	await assert.rejects(
		sendAnkiCard(store, draft.id, 1, destination, "http://localhost:3100"),
		/approve/,
	);
	const ready = store.update(draft.id, 1, { status: "ready" });
	const sent = await sendAnkiCard(
		store,
		ready.id,
		ready.revision,
		destination,
		"http://localhost:3100",
	);
	assert.equal(sent.noteId, 100);
	assert.equal(sent.status, "sent");
	assert.equal(remote.notes.length, 1);
	assert.equal(remote.notes[0]!.fields.Front!.value, ready.front);
	assert.deepEqual(
		await sendAnkiCard(
			store,
			ready.id,
			ready.revision,
			destination,
			"http://localhost:3100",
		),
		sent,
	);
	assert.equal(remote.calls.filter((c) => c === "addNote").length, 1);
	assert.equal(
		(
			await ankiRequest(
				request(
					{ ...content(), revision: sent.revision, back: "overwrite" },
					"PUT",
				),
				"card",
				sent.id,
				store,
			)
		).status,
		409,
	);
});

test("a lost addNote reply is reconciled on retry without creating a duplicate", async (t) => {
	const { store } = isolated(t);
	const remote = await fakeAnki(t);
	const draft = store.create(content());
	const card = store.update(draft.id, 1, { status: "ready" });
	remote.state.loseReply = true;
	await assert.rejects(
		sendAnkiCard(
			store,
			card.id,
			card.revision,
			destination,
			"http://localhost:3100",
		),
		/unavailable/,
	);
	assert.equal(store.get(card.id)!.status, "ready");
	const result = await sendAnkiCard(
		store,
		card.id,
		card.revision,
		destination,
		"http://localhost:3100",
	);
	assert.equal(result.status, "sent");
	assert.equal(remote.notes.length, 1);
});

test("changed content after an uncertain send cannot be silently marked sent", async (t) => {
	const { store } = isolated(t);
	const remote = await fakeAnki(t);
	const draft = store.create(content());
	const card = store.update(draft.id, 1, { status: "ready" });
	remote.state.loseReply = true;
	await assert.rejects(
		sendAnkiCard(
			store,
			card.id,
			card.revision,
			destination,
			"http://localhost:3100",
		),
	);
	const changed = store.update(card.id, card.revision, {
		back: "Changed after a timeout",
	});
	await assert.rejects(
		sendAnkiCard(
			store,
			card.id,
			changed.revision,
			destination,
			"http://localhost:3100",
		),
		/different content/,
	);
	assert.equal(remote.notes.length, 1);
	assert.equal(store.get(card.id)!.status, "ready");
});

test("wrong note types, duplicate fields, duplicate notes and invalid decks stay queued", async (t) => {
	const { store } = isolated(t);
	const remote = await fakeAnki(t);
	const draft = store.create(content());
	const card = store.update(draft.id, 1, { status: "ready" });
	for (const invalid of [
		{ ...destination, deck: "missing" },
		{ ...destination, model: "Cloze" },
		{ ...destination, fields: { front: "Front", back: "Front" } },
	])
		await assert.rejects(
			sendAnkiCard(
				store,
				card.id,
				card.revision,
				invalid,
				"http://localhost:3100",
			),
		);
	remote.state.duplicate = true;
	await assert.rejects(
		sendAnkiCard(
			store,
			card.id,
			card.revision,
			destination,
			"http://localhost:3100",
		),
		/duplicate/,
	);
	assert.equal(remote.notes.length, 0);
	assert.equal(store.get(card.id)!.status, "ready");
	const clozeDraft = store.create({
		...content(),
		kind: "cloze",
		front: "昨日 means {{c1::yesterday}}.",
	});
	const cloze = store.update(clozeDraft.id, 1, { status: "ready" });
	await assert.rejects(
		sendAnkiCard(
			store,
			cloze.id,
			cloze.revision,
			{
				deck: "Japanese",
				model: "Cloze",
				fields: { front: "Back Extra", extra: "Text" },
			},
			"http://localhost:3100",
		),
		/cloze template/,
	);
});

test("concurrent sends and edits cannot race addNote", async (t) => {
	const { store } = isolated(t);
	const remote = await fakeAnki(t);
	const draft = store.create(content());
	const card = store.update(draft.id, 1, { status: "ready" });
	let release!: () => void;
	remote.state.pause = new Promise<void>((resolve) => {
		release = resolve;
	});
	const pending = sendAnkiCard(
		store,
		card.id,
		card.revision,
		destination,
		"http://localhost:3100",
	);
	try {
		await assert.rejects(
			sendAnkiCard(
				store,
				card.id,
				card.revision,
				destination,
				"http://localhost:3100",
			),
			/already being sent/,
		);
		assert.equal(
			(
				await ankiRequest(
					request(
						{ ...content(), revision: card.revision, back: "edit during send" },
						"PUT",
					),
					"card",
					card.id,
					store,
				)
			).status,
			409,
		);
	} finally {
		release();
	}
	await pending;
	assert.equal(remote.notes.length, 1);
});

test("AnkiConnect endpoint cannot send note contents to a public server", () => {
	const old = process.env.LH_ANKICONNECT_URL;
	try {
		for (const url of [
			"https://example.org",
			"http://example.org",
			"http://user:secret@localhost:8765",
		]) {
			process.env.LH_ANKICONNECT_URL = url;
			assert.throws(ankiConnectUrl, /local HTTP/);
		}
	} finally {
		if (old) process.env.LH_ANKICONNECT_URL = old;
		else delete process.env.LH_ANKICONNECT_URL;
	}
});
