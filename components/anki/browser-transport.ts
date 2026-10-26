"use client";

import { type AnkiInvoke } from "@/src/core";

export const DEFAULT_BROWSER_ANKI_URL = "http://127.0.0.1:8765";
export function browserAnkiUrl(raw: string): string {
	const url = new URL(raw);
	if (
		url.protocol !== "http:" ||
		!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
		url.username ||
		url.password ||
		url.pathname !== "/" ||
		url.search ||
		url.hash
	)
		throw new Error(
			"Use a local AnkiConnect address, such as http://127.0.0.1:8765.",
		);
	return url.href;
}

/** A simple CORS request can reach requestPermission BEFORE Anki trusts
 * the site's origin. application/json would preflight and block that handshake. */
export function browserAnkiInvoke(
	endpoint: string,
	key: string,
	timeout = 15000,
): AnkiInvoke {
	return async <T>(
		action: string,
		params: object = {},
		signal?: AbortSignal,
	): Promise<T> => {
		const url = browserAnkiUrl(endpoint);
		if (typeof window !== "undefined" && !window.isSecureContext)
			throw new Error(
				"Open LearnHarness over HTTPS to connect to Anki on this device. Localhost also works for local development.",
			);
		let response: Response;
		try {
			response = await fetch(url, {
				method: "POST",
				mode: "cors",
				credentials: "omit",
				redirect: "error",
				referrerPolicy: "no-referrer",
				headers: { "Content-Type": "text/plain;charset=UTF-8" },
				body: JSON.stringify({
					action,
					version: 6,
					params,
					...(key && action !== "requestPermission" ? { key } : {}),
				}),
				signal: signal
					? AbortSignal.any([signal, AbortSignal.timeout(timeout)])
					: AbortSignal.timeout(timeout),
				targetAddressSpace: "loopback",
			} as RequestInit & { targetAddressSpace: "loopback" });
		} catch {
			throw new Error(
				signal?.aborted
					? "Anki connection cancelled."
					: "Could not reach Anki on this device. Open desktop Anki, enable AnkiConnect, and allow this site's Apps on device / local network permission in your browser. If Anki is showing an access prompt, approve this site's exact address there, then reconnect.",
			);
		}
		const reply = await response.json().catch(() => null);
		if (!response.ok || !reply || !("result" in reply))
			throw new Error(
				"AnkiConnect blocked the request. Connect again and approve this site's address in Anki.",
			);
		if (reply.error)
			throw new Error(`Anki: ${String(reply.error).slice(0, 500)}`);
		return reply.result as T;
	};
}

export async function requestBrowserAnkiPermission(
	invoke: AnkiInvoke,
): Promise<void> {
	const permission = await invoke<{
		permission: string;
		version?: number;
		requireApiKey?: boolean;
		requireApikey?: boolean;
	}>("requestPermission");
	if (permission.permission !== "granted")
		throw new Error(
			"Anki denied access. Allow this site's exact address in AnkiConnect, then reconnect. If you ignored the request earlier, remove this site from AnkiConnect's ignoreOriginList.",
		);
	if ((permission.version || 0) < 6)
		throw new Error("Update AnkiConnect to use API version 6.");
}
