import {
	AnkiError,
	ankiContentProblems,
	ankiNoteFields,
	type AnkiCard,
	type AnkiDestination,
	type AnkiModelInfo,
} from "./anki.ts";

/** Transport is injected: the same protocol runs in a browser or on the host. */
export type AnkiInvoke = <T>(
	action: string,
	params?: object,
	signal?: AbortSignal,
) => Promise<T>;

export async function readAnkiModel(
	invoke: AnkiInvoke,
	name: string,
	signal?: AbortSignal,
): Promise<AnkiModelInfo> {
	const [fields, templates] = await Promise.all([
		invoke<string[]>("modelFieldNames", { modelName: name }, signal),
		invoke<Record<string, { Front: string; Back: string }>>(
			"modelTemplates",
			{ modelName: name },
			signal,
		),
	]);
	if (
		!Array.isArray(fields) ||
		!fields.every((f) => typeof f === "string") ||
		!templates ||
		typeof templates !== "object"
	)
		throw new AnkiError("Anki returned an invalid note type.", 502);
	const clozeFields = [
		...new Set(
			Object.values(templates).flatMap((template) =>
				[...template.Front.matchAll(/\{\{cloze:([^}]+)\}\}/gi)].flatMap(
					(match) => {
						const field = [...fields]
							.sort((a, b) => b.length - a.length)
							.find((f) => match[1] === f || match[1]!.endsWith(`:${f}`));
						return field ? [field] : [];
					},
				),
			),
		),
	];
	return {
		name,
		fields,
		cloze: Object.values(templates).some((t) => /\{\{cloze:/i.test(t.Front)),
		clozeFields,
	};
}

export async function deliverAnkiNote(
	card: AnkiCard,
	destination: AnkiDestination,
	origin: string,
	invoke: AnkiInvoke,
	signal?: AbortSignal,
): Promise<number> {
	if (card.status !== "ready" || ankiContentProblems(card).length)
		throw new AnkiError(
			"Preview and approve this card before sending it.",
			422,
		);
	const [model, decks] = await Promise.all([
		readAnkiModel(invoke, destination.model, signal),
		invoke<string[]>("deckNames", {}, signal),
	]);
	if (!decks.includes(destination.deck))
		throw new AnkiError("Choose an existing Anki deck.", 422);
	if ((card.kind === "cloze") !== model.cloze)
		throw new AnkiError(
			`Choose a ${card.kind === "cloze" ? "Cloze" : "Basic (non-cloze)"} note type for this card.`,
			422,
		);
	const fields = destination.fields;
	const targets = Object.values(fields).filter(Boolean);
	if (
		!fields.front ||
		!(card.kind === "cloze" ? fields.extra : fields.back) ||
		targets.some((f) => !model.fields.includes(f)) ||
		new Set(targets).size !== targets.length
	)
		throw new AnkiError(
			"Map the question and answer fields, using a different Anki field for each selection.",
			422,
		);
	if (card.kind === "cloze" && !model.clozeFields.includes(fields.front!))
		throw new AnkiError(
			"Map the sentence to the field used by this note type’s cloze template.",
			422,
		);
	const noteFields = {
		...Object.fromEntries(model.fields.map((f) => [f, ""])),
		...ankiNoteFields(card, fields, origin),
	};
	const marker = `learnharness::${card.id}`;
	const previous = await invoke<number[]>(
		"findNotes",
		{ query: `tag:${marker}` },
		signal,
	);
	let noteId: number;
	if (previous.length) {
		// A timeout can happen AFTER Anki accepted the note. Reconcile on
		// retry, and refuse if the local draft has changed in the meantime.
		const notes = await invoke<
			Array<{
				noteId: number;
				modelName: string;
				fields: Record<string, { value: string }>;
			}>
		>("notesInfo", { notes: previous }, signal);
		if (
			notes.length !== 1 ||
			notes[0]!.modelName !== destination.model ||
			Object.entries(noteFields).some(
				([name, value]) => notes[0]!.fields[name]?.value !== value,
			)
		)
			throw new AnkiError(
				"A linked note already exists in Anki with different content. Check it in Anki before sending another copy.",
			);
		noteId = notes[0]!.noteId;
	} else {
		const note = {
			deckName: destination.deck,
			modelName: destination.model,
			fields: noteFields,
			tags: ["learnharness", marker, ...card.tags],
			options: { allowDuplicate: false, duplicateScope: "collection" },
		};
		const allowed = await invoke<boolean[]>(
			"canAddNotes",
			{ notes: [note] },
			signal,
		);
		if (allowed[0] !== true)
			throw new AnkiError(
				"Anki found a duplicate or this note cannot create a card. Check the existing note or choose another note type.",
				409,
			);
		noteId = await invoke<number>("addNote", { note }, signal);
		if (!Number.isSafeInteger(noteId) || noteId <= 0)
			throw new AnkiError(
				"Anki did not confirm the note. Retry to check whether it was created.",
				502,
			);
	}
	return noteId;
}
