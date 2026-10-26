import { z } from "zod";
import { deliverAnkiNote, readAnkiModel } from "../core/anki-connect.ts";
import {
	ankiContentSchema,
	ankiContentProblems,
	ankiTsv,
	ANKI_ROLES,
	type AnkiCard,
	type AnkiDestination,
	type AnkiModelInfo,
} from "../core/anki.ts";
import { AnkiStoreError, type AnkiStore } from "../store/anki.ts";
import { stores, effectiveSettings } from "./stores.ts";
import { resolveConversationSpec } from "../core/settings-resolution.ts";
import { piEngineForSpec } from "../agent/models.ts";
import { coachAnkiCard } from "../agent/anki-coach.ts";
import { refreshConnectionCatalog } from "./model-catalog.ts";

export function ankiConnectUrl(): URL {
	const url = new URL(
		process.env.LH_ANKICONNECT_URL || "http://127.0.0.1:8765",
	);
	if (
		url.protocol !== "http:" ||
		!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	)
		throw new Error(
			"AnkiConnect must use a local HTTP address on the app server.",
		);
	return url;
}

export async function invokeAnki<T>(
	action: string,
	params: object = {},
	signal?: AbortSignal,
): Promise<T> {
	let response: Response;
	try {
		response = await fetch(ankiConnectUrl(), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				action,
				version: 6,
				params,
				...(process.env.LH_ANKICONNECT_API_KEY
					? { key: process.env.LH_ANKICONNECT_API_KEY }
					: {}),
			}),
			signal: signal
				? AbortSignal.any([signal, AbortSignal.timeout(12000)])
				: AbortSignal.timeout(4000),
			cache: "no-store",
			redirect: "error",
		});
	} catch {
		throw new AnkiStoreError(
			"AnkiConnect is unavailable. Open desktop Anki on this PC and enable AnkiConnect, then retry. Your card stays in the queue.",
			503,
		);
	}
	const body = await response.json().catch(() => null);
	if (!response.ok || !body || !("result" in body))
		throw new AnkiStoreError(
			"The local service did not respond as AnkiConnect. Check its address.",
			503,
		);
	if (body.error)
		throw new AnkiStoreError(`Anki: ${String(body.error).slice(0, 500)}`, 422);
	return body.result as T;
}

export function ankiModelInfo(
	name: string,
	signal?: AbortSignal,
): Promise<AnkiModelInfo> {
	return readAnkiModel(invokeAnki, name, signal);
}

const destinationSchema = z.object({
	deck: z.string().min(1).max(500),
	model: z.string().min(1).max(500),
	fields: z.object(
		Object.fromEntries(
			ANKI_ROLES.map((role) => [role, z.string().min(1).max(500).optional()]),
		) as Record<(typeof ANKI_ROLES)[number], z.ZodOptional<z.ZodString>>,
	),
});

// Shared across Next hot reloads; never issue two adds for the same local note.
const SENDS = Symbol.for("learnharness.anki.sending");
const registry = globalThis as typeof globalThis & { [SENDS]?: Set<string> };
const sending = (registry[SENDS] ??= new Set());

export async function sendAnkiCard(
	store: AnkiStore,
	id: string,
	revision: number,
	destination: AnkiDestination,
	origin: string,
	signal?: AbortSignal,
): Promise<AnkiCard> {
	if (sending.has(id))
		throw new AnkiStoreError(
			"This card is already being sent. Wait a moment, then refresh.",
		);
	sending.add(id);
	try {
		const card = store.get(id);
		if (!card) throw new AnkiStoreError("Card not found.", 404);
		if (card.delivery && card.delivery.expiresAt > Date.now())
			throw new AnkiStoreError(
				"A browser is sending this card. Wait for it to finish.",
			);
		if (card.status === "sent") return card;
		if (card.revision !== revision)
			throw new AnkiStoreError("This card changed. Refresh before sending it.");
		if (card.status !== "ready" || ankiContentProblems(card).length)
			throw new AnkiStoreError(
				"Preview and approve this card before sending it.",
				422,
			);
		const noteId = await deliverAnkiNote(
			card,
			destination,
			origin,
			invokeAnki,
			signal,
		);
		return store.update(id, revision, {
			status: "sent",
			noteId,
			sentAt: new Date().toISOString(),
			destination,
			sentVia: "server",
		});
	} finally {
		sending.delete(id);
	}
}

function checkMutation(request: Request) {
	const origin = request.headers.get("origin");
	const host = request.headers.get("host") || new URL(request.url).host;
	if (
		request.headers.get("sec-fetch-site") === "cross-site" ||
		(origin &&
			(new URL(origin).host !== host ||
				!/^https?:$/.test(new URL(origin).protocol)))
	)
		throw new AnkiStoreError("Open this action from LearnHarness.", 403);
	if (!request.headers.get("content-type")?.startsWith("application/json"))
		throw new AnkiStoreError("A JSON request is required.", 415);
}
async function readBody(request: Request): Promise<unknown> {
	checkMutation(request);
	if (Number(request.headers.get("content-length")) > 100000)
		throw new AnkiStoreError("This card is too large.", 413);
	const reader = request.body?.getReader();
	if (!reader) throw new AnkiStoreError("A card is required.", 400);
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			length += value.length;
			if (length > 100000) {
				await reader.cancel();
				throw new AnkiStoreError("This card is too large.", 413);
			}
			chunks.push(value);
		}
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} finally {
		reader.releaseLock();
	}
}
function response(data: unknown, status = 200) {
	return Response.json(data, {
		status,
		headers: { "Cache-Control": "no-store" },
	});
}
function appOrigin(request: Request): string {
	const url = new URL(request.url);
	const forwarded = request.headers.get("x-forwarded-proto");
	const protocol =
		forwarded === "https" || forwarded === "http"
			? `${forwarded}:`
			: url.protocol;
	return `${protocol}//${request.headers.get("host") || url.host}`;
}

/** Thin route surface; injectable store and model make IO tests completely isolated. */
export async function ankiRequest(
	request: Request,
	action:
		| "cards"
		| "card"
		| "connection"
		| "send"
		| "browser-send"
		| "coach"
		| "export",
	id?: string,
	store = stores.ankiStore,
): Promise<Response> {
	try {
		const url = new URL(request.url);
		if (action === "connection") {
			try {
				const model = url.searchParams.get("model");
				if (model) return response(await ankiModelInfo(model, request.signal));
				const version = await invokeAnki<number>("version", {}, request.signal);
				if (version < 6)
					throw new AnkiStoreError(
						"Update AnkiConnect to use API version 6.",
						503,
					);
				const [decks, models] = await Promise.all([
					invokeAnki<string[]>("deckNames", {}, request.signal),
					invokeAnki<string[]>("modelNames", {}, request.signal),
				]);
				return response({ connected: true, decks, models });
			} catch (error) {
				return response({
					connected: false,
					decks: [],
					models: [],
					message:
						error instanceof Error
							? error.message
							: "AnkiConnect is unavailable.",
				});
			}
		}
		if (action === "export") {
			const kind = url.searchParams.get("kind");
			if (kind !== "basic" && kind !== "cloze")
				throw new AnkiStoreError("Choose Basic or Cloze to export.", 400);
			return new Response(ankiTsv(store.list(), kind, appOrigin(request)), {
				headers: {
					"Content-Type": "text/tab-separated-values; charset=utf-8",
					"Content-Disposition": `attachment; filename="learnharness-${kind}.tsv"`,
					"Cache-Control": "no-store",
				},
			});
		}
		if (action === "cards" && request.method === "GET")
			return response({ cards: store.list() });
		if (action === "card" && request.method === "GET") {
			const card = store.get(id!);
			return card
				? response({ card })
				: response({ error: "Card not found." }, 404);
		}
		const raw = await readBody(request);
		if (action === "cards") {
			const content = ankiContentSchema.parse(raw);
			return response({ card: store.create(content) }, 201);
		}
		if (action === "coach") {
			const content = ankiContentSchema.parse(raw);
			if (!content.front.trim() && !content.source.excerpt.trim())
				throw new AnkiStoreError(
					"Write a draft or add a source passage first.",
					422,
				);
			const chat = content.source.chatId
				? stores.chatStore.getChat(content.source.chatId)
				: null;
			const spec = resolveConversationSpec(
				chat?.settings,
				effectiveSettings().models.strong,
			);
			if (!spec)
				throw new AnkiStoreError(
					"Choose a teacher model in Settings to get feedback. You can still write and save cards yourself.",
					503,
				);
			await refreshConnectionCatalog(spec.provider);
			const result = await coachAnkiCard(
				content,
				piEngineForSpec(spec, false),
				AbortSignal.any([request.signal, AbortSignal.timeout(180000)]),
			);
			return response(result);
		}
		const body = z
			.object({ revision: z.number().int().positive() })
			.passthrough()
			.parse(raw);
		if (action === "browser-send") {
			if (sending.has(id!))
				throw new AnkiStoreError(
					"This card is already being sent by the app server.",
				);
			const current = store.get(id!);
			if (!current) throw new AnkiStoreError("Card not found.", 404);
			if (body.operation === "begin") {
				if (current.status === "sent") return response({ card: current });
				const requestedId =
					body.deliveryId === undefined
						? crypto.randomUUID()
						: z.string().uuid().parse(body.deliveryId);
				if (
					current.delivery?.id === requestedId &&
					current.delivery.expiresAt > Date.now()
				)
					return response({ card: current });
				if (current.status !== "ready" || ankiContentProblems(current).length)
					throw new AnkiStoreError(
						"Preview and approve this card before sending it.",
						422,
					);
				if (current.delivery && current.delivery.expiresAt > Date.now())
					throw new AnkiStoreError(
						"Another browser is sending this card. Wait for it to finish, then refresh.",
					);
				const destination = destinationSchema.parse(body.destination);
				const delivery = {
					id: requestedId,
					expiresAt: Date.now() + 180000,
					destination,
				};
				return response({
					card: store.update(id!, body.revision, { delivery }),
				});
			}
			const deliveryId = z.string().uuid().parse(body.deliveryId);
			if (current.status === "sent" && current.sentDeliveryId === deliveryId)
				return response({ card: current });
			if (!current.delivery || current.delivery.id !== deliveryId)
				throw new AnkiStoreError(
					"This delivery changed. Refresh the queue before trying again.",
				);
			if (body.operation === "cancel")
				return response({
					card: store.update(id!, body.revision, { delivery: undefined }),
				});
			if (body.operation !== "complete")
				throw new AnkiStoreError("Unknown delivery action.", 400);
			const noteId = z
				.number()
				.int()
				.positive()
				.max(Number.MAX_SAFE_INTEGER)
				.parse(body.noteId);
			return response({
				card: store.update(id!, body.revision, {
					status: "sent",
					sentVia: "browser",
					noteId,
					sentAt: new Date().toISOString(),
					destination: current.delivery.destination,
					sentDeliveryId: deliveryId,
					delivery: undefined,
				}),
			});
		}
		if (sending.has(id!))
			throw new AnkiStoreError(
				"Wait for this card to finish sending before changing it.",
			);
		const delivery = store.get(id!)?.delivery;
		if (delivery && delivery.expiresAt > Date.now())
			throw new AnkiStoreError(
				"A browser is sending this card. Wait for it to finish before changing it.",
			);
		if (action === "send") {
			const destination = destinationSchema.parse(body.destination);
			return response({
				card: await sendAnkiCard(
					store,
					id!,
					body.revision,
					destination,
					request.headers.get("origin") || appOrigin(request),
					request.signal,
				),
			});
		}
		if (request.method === "DELETE") {
			store.remove(id!, body.revision);
			return response({ ok: true });
		}
		const current = store.get(id!);
		if (!current) throw new AnkiStoreError("Card not found.", 404);
		if (current.status === "sent")
			throw new AnkiStoreError(
				"This note is already in Anki. Edit it there, or make a new draft.",
			);
		const content = ankiContentSchema.parse(body);
		const ready = body.status === "ready";
		if (
			ready &&
			(body.understood !== true ||
				body.previewed !== true ||
				ankiContentProblems(content).length)
		)
			throw new AnkiStoreError(
				"Understand the idea, preview the answer, and fix the highlighted fields before approving.",
				422,
			);
		return response({
			card: store.update(id!, body.revision, {
				...content,
				status: ready ? "ready" : "draft",
			}),
		});
	} catch (error) {
		if (error instanceof AnkiStoreError)
			return response({ error: error.message }, error.status);
		if (error instanceof z.ZodError || error instanceof SyntaxError)
			return response(
				{
					error: "The card could not be read. Check the fields and try again.",
				},
				400,
			);
		return response(
			{
				error: request.signal.aborted
					? "Cancelled. Your saved draft is unchanged."
					: error instanceof Error
						? error.message.slice(0, 700)
						: "The action failed. Your saved cards are preserved.",
			},
			request.signal.aborted ? 499 : 502,
		);
	}
}
