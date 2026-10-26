"use client";

export async function ankiApi<T>(
	path: string,
	body?: unknown,
	method = "POST",
	signal?: AbortSignal,
): Promise<T> {
	const response = await fetch(
		`/api/anki/${path}`,
		body === undefined
			? { cache: "no-store", signal }
			: {
					method,
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
					signal,
				},
	);
	const result = await response.json();
	if (!response.ok)
		throw new Error(result.error || "This action could not be completed.");
	return result as T;
}
export function notifyAnkiChanged() {
	window.dispatchEvent(new Event("lh:anki-changed"));
}
