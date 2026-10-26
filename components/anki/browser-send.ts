"use client";

import {
	deliverAnkiNote,
	type AnkiCard,
	type AnkiDestination,
	type AnkiInvoke,
} from "@/src/core";
import { ankiApi } from "./api";

/** Server owns approval and the delivery lease; the browser alone talks
 * to its local Anki. A lost completion reply is safe to reconcile. */
export async function sendBrowserAnki(
	card: AnkiCard,
	destination: AnkiDestination,
	invoke: AnkiInvoke,
	onUpdate: (card: AnkiCard) => void,
): Promise<AnkiCard> {
	const path = `cards/${card.id}/browser-send`;
	const deliveryId = crypto.randomUUID();
	const { card: leased } = await ankiApi<{ card: AnkiCard }>(path, {
		operation: "begin",
		deliveryId,
		revision: card.revision,
		destination,
	});
	onUpdate(leased);
	if (leased.status === "sent") return leased;
	if (!leased.delivery)
		throw new Error(
			"The server did not reserve this card for delivery. Refresh and retry.",
		);
	if (leased.delivery.id !== deliveryId)
		throw new Error(
			"This card was reserved by another browser. Refresh and retry.",
		);
	try {
		const noteId = await deliverAnkiNote(
			leased,
			destination,
			window.location.origin,
			invoke,
		);
		const { card: sent } = await ankiApi<{ card: AnkiCard }>(path, {
			operation: "complete",
			revision: leased.revision,
			deliveryId,
			noteId,
		});
		onUpdate(sent);
		return sent;
	} catch (error) {
		try {
			const { card: reconciled } = await ankiApi<{ card: AnkiCard }>(path, {
				operation: "cancel",
				revision: leased.revision,
				deliveryId,
			});
			onUpdate(reconciled);
			if (reconciled.status === "sent") return reconciled;
		} catch {
			/* The lease expires; the stable note tag protects a retry. */
		}
		throw error;
	}
}
