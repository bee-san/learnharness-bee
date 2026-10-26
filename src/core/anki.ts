export class AnkiError extends Error {
	constructor(
		message: string,
		public status = 409,
	) {
		super(message);
	}
}

import { z } from "zod";

export const ankiSourceSchema = z.object({
	title: z.string().max(500).default(""),
	excerpt: z.string().max(16000).default(""),
	reference: z.string().max(2000).default(""),
	chatId: z
		.string()
		.regex(/^[\w-]+$/)
		.optional(),
	messageId: z.string().max(200).optional(),
});
export const ankiContentSchema = z.object({
	kind: z.enum(["basic", "cloze"]),
	front: z.string().max(8000),
	back: z.string().max(8000),
	reading: z.string().max(2000),
	extra: z.string().max(8000),
	tags: z
		.array(
			z
				.string()
				.regex(/^[\p{L}\p{N}_:.-]+$/u)
				.max(100),
		)
		.max(30),
	source: ankiSourceSchema,
});
export type AnkiSource = z.infer<typeof ankiSourceSchema>;
export type AnkiContent = z.infer<typeof ankiContentSchema>;
export const ANKI_ROLES = [
	"front",
	"back",
	"reading",
	"extra",
	"source",
] as const;
export type AnkiRole = (typeof ANKI_ROLES)[number];
export type AnkiFieldMap = Partial<Record<AnkiRole, string>>;
export interface AnkiDestination {
	deck: string;
	model: string;
	fields: AnkiFieldMap;
}
export interface AnkiCard extends AnkiContent {
	id: string;
	version: 1;
	revision: number;
	status: "draft" | "ready" | "sent";
	createdAt: string;
	updatedAt: string;
	noteId?: number;
	sentAt?: string;
	destination?: AnkiDestination;
	delivery?: { id: string; expiresAt: number; destination: AnkiDestination };
	sentDeliveryId?: string;
	sentVia?: "browser" | "server";
}
export interface AnkiModelInfo {
	name: string;
	fields: string[];
	cloze: boolean;
	clozeFields: string[];
}
export interface AnkiConnection {
	connected: boolean;
	message?: string;
	decks: string[];
	models: string[];
}
export interface AnkiCoaching {
	feedback: string[];
	suggestions: Array<
		Pick<AnkiContent, "front" | "back" | "reading" | "extra"> & {
			reason: string;
		}
	>;
}

export function emptyAnkiContent(source?: Partial<AnkiSource>): AnkiContent {
	return {
		kind: "basic",
		front: "",
		back: "",
		reading: "",
		extra: "",
		tags: [],
		source: { title: "", excerpt: "", reference: "", ...source },
	};
}

const CLOZE = /\{\{c(\d+)::([^{}]+?)\}\}/g;
/** One deletion number = one Anki card. Hints are optional; nested HTML is never rendered. */
export function clozeParts(
	text: string,
): { text: string; answer?: string; hint?: string }[] {
	const parts: { text: string; answer?: string; hint?: string }[] = [];
	let end = 0;
	for (const match of text.matchAll(CLOZE)) {
		parts.push({ text: text.slice(end, match.index) });
		const [answer, ...hint] = match[2]!.split("::");
		parts.push({ text: match[0], answer, hint: hint.join("::") || undefined });
		end = match.index! + match[0].length;
	}
	parts.push({ text: text.slice(end) });
	return parts;
}

export function ankiContentProblems(card: AnkiContent): string[] {
	const problems: string[] = [];
	if (!card.front.trim())
		problems.push(
			card.kind === "cloze"
				? "Write a sentence with one {{c1::answer}} deletion."
				: "Write the question or sentence you want to recall.",
		);
	if (card.kind === "basic" && !card.back.trim())
		problems.push("Write a short, specific answer.");
	if (card.kind === "cloze") {
		const matches = [...card.front.matchAll(CLOZE)];
		if (
			!matches.length ||
			matches.some((m) => m[1] !== "1" || !m[2]!.split("::")[0]!.trim()) ||
			card.front.replace(CLOZE, "").match(/\{\{|\}\}/)
		)
			problems.push(
				"Use {{c1::answer}} (or {{c1::answer::hint}}), with only c1 so this note creates one card.",
			);
	}
	return problems;
}

/** Coaching cues, never a score or a claim that a fact is correct. */
export function ankiWritingHints(card: AnkiContent): string[] {
	const hints: string[] = [];
	if (
		card.back.length > 300 ||
		card.back.split(/\n/).filter((s) => s.trim()).length > 3
	)
		hints.push(
			"Could this answer become two smaller cards? Keep explanations in Extra.",
		);
	if (/\b(list|all the|everything|enumerate)\b/i.test(card.front))
		hints.push(
			"A list can be hard to grade. Try asking for one distinction or example.",
		);
	if (!card.source.excerpt && !card.source.reference)
		hints.push(
			"Keep a source or example so you can revisit the original context.",
		);
	if (!hints.length)
		hints.push(
			"One clear target. Enough context to know exactly what counts as correct.",
		);
	return hints;
}

export function ankiSourcePath(source: AnkiSource): string | undefined {
	return source.chatId
		? `/chat/${encodeURIComponent(source.chatId)}${source.messageId ? `#${encodeURIComponent(`message-${source.messageId}`)}` : ""}`
		: undefined;
}
export function escapeAnkiHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;")
		.replace(/\r?\n/g, "<br>");
}
export function ankiSourceText(source: AnkiSource): string {
	return [source.title, source.reference, source.excerpt]
		.filter(Boolean)
		.join("\n\n");
}
export function ankiNoteFields(
	card: AnkiContent,
	mapping: AnkiFieldMap,
	origin: string,
): Record<string, string> {
	const fields: Record<string, string> = {};
	const path = ankiSourcePath(card.source);
	const source =
		escapeAnkiHtml(ankiSourceText(card.source)) +
		(path
			? `<br><a href="${escapeAnkiHtml(new URL(path, origin).href)}">Open lesson</a>`
			: "");
	fields[mapping.front!] = escapeAnkiHtml(card.front);
	const answerField = card.kind === "cloze" ? mapping.extra : mapping.back;
	if (answerField) fields[answerField] = escapeAnkiHtml(card.back);
	const append = (target: string | undefined, html: string) => {
		if (target && html)
			fields[target] = [fields[target], html].filter(Boolean).join("<br><br>");
	};
	append(
		mapping.reading ?? answerField,
		card.reading
			? `${mapping.reading ? "" : "Reading: "}${escapeAnkiHtml(card.reading)}`
			: "",
	);
	append(mapping.extra ?? answerField, escapeAnkiHtml(card.extra));
	append(mapping.source ?? answerField, source);
	return fields;
}

/** Standard Basic/Cloze files, portable even when Anki is closed. Export never marks a note sent. */
export function ankiTsv(
	cards: AnkiCard[],
	kind: AnkiContent["kind"],
	origin: string,
): string {
	const rows = cards
		.filter((c) => c.status === "ready" && c.kind === kind)
		.map((c) => {
			const fields = ankiNoteFields(
				c,
				kind === "basic"
					? { front: "Front", back: "Back" }
					: { front: "Text", extra: "Back Extra" },
				origin,
			);
			return [
				kind === "basic" ? fields.Front : fields.Text,
				kind === "basic" ? fields.Back : fields["Back Extra"],
				["learnharness", `learnharness::${c.id}`, ...c.tags].join(" "),
			]
				.map((s) => `"${(s || "").replace(/"/g, '""')}"`)
				.join("\t");
		});
	return `#separator:tab\n#html:true\n#notetype:${kind === "basic" ? "Basic" : "Cloze"}\n#tags column:3\n${rows.join("\n")}\n`;
}
