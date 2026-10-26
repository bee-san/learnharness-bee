import fs from "node:fs";
import path from "node:path";
import { AnkiError as AnkiStoreError } from "../core/anki.ts";
import { randomUUID } from "node:crypto";
import { PATHS } from "../../config.ts";
import {
	ankiContentSchema,
	type AnkiCard,
	type AnkiContent,
} from "../core/anki.ts";

export { AnkiError as AnkiStoreError } from "../core/anki.ts";

/** Atomic per-note files. Sync read/modify/write has no await gap; revisions protect other tabs. */
export function createAnkiStore(directory = path.join(PATHS.data, "anki")) {
	const file = (id: string) => {
		if (!/^[\w-]{1,100}$/.test(id))
			throw new AnkiStoreError("Invalid card ID.", 400);
		return path.join(directory, `${id}.json`);
	};
	const get = (id: string): AnkiCard | null => {
		let raw: string;
		try {
			raw = fs.readFileSync(file(id), "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
		const card = JSON.parse(raw) as AnkiCard;
		if (
			card.version !== 1 ||
			card.id !== id ||
			!Number.isInteger(card.revision) ||
			!["draft", "ready", "sent"].includes(card.status) ||
			!ankiContentSchema.safeParse(card).success
		)
			throw new AnkiStoreError(
				"This card could not be read. Its saved file has been preserved.",
				500,
			);
		return card;
	};
	const write = (card: AnkiCard) => {
		fs.mkdirSync(directory, { recursive: true });
		const target = file(card.id);
		const tmp = `${target}.${randomUUID()}.tmp`;
		try {
			fs.writeFileSync(tmp, JSON.stringify(card, null, "\t"), { mode: 0o600 });
			fs.renameSync(tmp, target);
		} finally {
			fs.rmSync(tmp, { force: true });
		}
		return card;
	};
	return {
		get,
		list: (): AnkiCard[] => {
			if (!fs.existsSync(directory)) return [];
			return fs
				.readdirSync(directory)
				.filter((f) => f.endsWith(".json"))
				.map((f) => get(f.slice(0, -5))!)
				.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
		},
		create: (content: AnkiContent): AnkiCard => {
			const now = new Date().toISOString();
			return write({
				...content,
				id: `card_${randomUUID()}`,
				version: 1,
				revision: 1,
				status: "draft",
				createdAt: now,
				updatedAt: now,
			});
		},
		update: (
			id: string,
			revision: number,
			patch: Partial<AnkiContent> &
				Partial<
					Pick<
						AnkiCard,
						| "status"
						| "noteId"
						| "sentAt"
						| "destination"
						| "delivery"
						| "sentDeliveryId"
						| "sentVia"
					>
				>,
		): AnkiCard => {
			const current = get(id);
			if (!current) throw new AnkiStoreError("Card not found.", 404);
			if (current.revision !== revision)
				throw new AnkiStoreError(
					"This card changed in another window. Reopen it to load the saved version.",
				);
			return write({
				...current,
				...patch,
				id,
				version: 1,
				revision: revision + 1,
				updatedAt: new Date().toISOString(),
			});
		},
		remove: (id: string, revision: number) => {
			const current = get(id);
			if (!current) return;
			if (current.revision !== revision)
				throw new AnkiStoreError(
					"This card changed in another window. Refresh before removing it.",
				);
			fs.unlinkSync(file(id));
		},
	};
}

export type AnkiStore = ReturnType<typeof createAnkiStore>;
export const ankiStore = createAnkiStore();
