import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AnkiPreview } from "../components/anki/preview.tsx";
import { emptyAnkiContent } from "../src/core/anki.ts";

test("recall preview does not put the answer, reading or explanation in hidden markup", () => {
	const card = {
		...emptyAnkiContent(),
		kind: "cloze" as const,
		front: "昨日 means {{c1::yesterday::time}}.",
		back: "A private answer",
		reading: "きのう",
		extra: "Optional explanation",
	};
	const hidden = renderToStaticMarkup(
		<AnkiPreview card={card} revealed={false} onReveal={() => {}} />,
	);
	for (const answer of [
		"yesterday",
		"A private answer",
		"きのう",
		"Optional explanation",
	])
		assert(!hidden.includes(answer), answer);
	assert(hidden.includes("[time]"));
	const shown = renderToStaticMarkup(
		<AnkiPreview card={card} revealed onReveal={() => {}} />,
	);
	for (const answer of [
		"yesterday",
		"A private answer",
		"きのう",
		"Optional explanation",
	])
		assert(shown.includes(answer), answer);
});

test("preview treats pasted HTML as text on both sides", () => {
	const card = {
		...emptyAnkiContent(),
		front: '<img src=x onerror="bad()">',
		back: "<script>bad()</script>",
	};
	const html = renderToStaticMarkup(
		<AnkiPreview card={card} revealed onReveal={() => {}} />,
	);
	assert(!html.includes("<img "));
	assert(!html.includes("<script>"));
	assert(html.includes("&lt;img"));
	assert(html.includes("&lt;script&gt;"));
});
