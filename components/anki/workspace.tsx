"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
	BookmarkPlusIcon,
	CheckCircle2Icon,
	DownloadIcon,
	ExternalLinkIcon,
	PencilIcon,
	PlusIcon,
	RefreshCwIcon,
	SearchIcon,
	SparklesIcon,
	Trash2Icon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { TopBar } from "@/components/top-bar";
import { ankiSourcePath, type AnkiCard } from "@/src/core";
import { ankiApi } from "./api";
import { useAnki } from "./provider";
import { AnkiConnectionPanel } from "./connection";

const TABS = [
	{ id: "draft", label: "Drafts" },
	{ id: "ready", label: "Ready for Anki" },
	{ id: "sent", label: "In Anki" },
] as const;

export function AnkiWorkspace() {
	const anki = useAnki();
	const [cards, setCards] = useState<AnkiCard[]>([]);
	const [loaded, setLoaded] = useState(false);
	const [error, setError] = useState("");
	const [tab, setTab] = useState<AnkiCard["status"]>("draft");
	const [search, setSearch] = useState("");
	const [removing, setRemoving] = useState<string | null>(null);
	const [confirm, setConfirm] = useState<string | null>(null);
	const refresh = useCallback(async () => {
		try {
			const result = await ankiApi<{ cards: AnkiCard[] }>("cards");
			setCards(result.cards);
			setLoaded(true);
			setError("");
		} catch (e) {
			setError((e as Error).message);
		}
	}, []);
	useEffect(() => {
		void refresh();
		const fn = () => {
			void refresh();
		};
		window.addEventListener("lh:anki-changed", fn);
		window.addEventListener("focus", fn);
		return () => {
			window.removeEventListener("lh:anki-changed", fn);
			window.removeEventListener("focus", fn);
		};
	}, [refresh]);
	const remove = async (card: AnkiCard) => {
		setRemoving(card.id);
		try {
			await ankiApi(`cards/${card.id}`, { revision: card.revision }, "DELETE");
			setConfirm(null);
			await refresh();
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setRemoving(null);
		}
	};
	const filtered = cards.filter(
		(c) =>
			c.status === tab &&
			`${c.front} ${c.back} ${c.reading} ${c.extra} ${c.source.title} ${c.tags.join(" ")}`
				.toLocaleLowerCase()
				.includes(search.toLocaleLowerCase()),
	);
	const ready = cards.filter((c) => c.status === "ready");
	return (
		<div className="flex h-dvh flex-col">
			<TopBar>
				<span className="flex flex-1 items-center gap-2 text-sm font-semibold">
					<BookmarkPlusIcon className="size-4 text-primary" />
					Anki notebook
				</span>
				<Button size="sm" onClick={() => void anki?.openNew()}>
					<PlusIcon />
					New card
				</Button>
			</TopBar>
			<div className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto max-w-5xl space-y-7 px-5 py-8 sm:px-8 sm:py-12">
					<section className="relative overflow-hidden rounded-3xl border border-primary/15 bg-gradient-to-br from-primary/10 via-card to-background p-6 sm:p-8">
						<SparklesIcon className="mb-4 size-7 text-primary" />
						<h1 className="font-title text-4xl leading-tight sm:text-5xl">
							Little cards. Lasting memories.
						</h1>
						<p className="mt-4 max-w-xl font-prose text-lg leading-relaxed text-muted-foreground">
							Keep the things you want to remember. Write them your way, let the
							teacher help, then give them a home in Anki.
						</p>
						<div className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-primary">
							<span>01 · Understand</span>
							<span aria-hidden>→</span>
							<span>02 · Write & refine</span>
							<span aria-hidden>→</span>
							<span>03 · Recall & approve</span>
						</div>
					</section>
					<AnkiConnectionPanel />
					<div className="flex flex-wrap items-center justify-between gap-3">
						<div
							className="flex max-w-full gap-1 rounded-xl bg-muted/50 p-1"
							role="tablist"
							aria-label="Card queue"
						>
							{TABS.map(({ id, label }) => (
								<button
									type="button"
									role="tab"
									aria-selected={tab === id}
									key={id}
									onClick={() => {
										setTab(id);
										setConfirm(null);
									}}
									className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm ${tab === id ? "bg-background font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
								>
									{label}
									<span className="rounded-full bg-primary/10 px-1.5 text-xs text-primary">
										{cards.filter((c) => c.status === id).length}
									</span>
								</button>
							))}
						</div>
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label="Refresh card queue"
							onClick={() => void refresh()}
						>
							<RefreshCwIcon />
						</Button>
					</div>
					<div className="relative">
						<SearchIcon className="pointer-events-none absolute left-3 top-3 size-4 text-muted-foreground" />
						<input
							className="h-10 w-full rounded-xl border border-input bg-background pl-10 pr-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
							aria-label="Search cards"
							placeholder="Find a word, idea, source or tag…"
							value={search}
							onChange={(e) => setSearch(e.target.value)}
						/>
					</div>
					{error && (
						<p
							role="alert"
							className="rounded-xl border border-destructive/20 p-4 text-sm text-destructive"
						>
							{error}
						</p>
					)}
					{!loaded && !error ? (
						<p
							role="status"
							className="py-10 text-center text-muted-foreground"
						>
							Opening your notebook…
						</p>
					) : filtered.length ? (
						<div role="tabpanel" className="grid gap-4 sm:grid-cols-2">
							{filtered.map((card) => {
								const href = ankiSourcePath(card.source);
								return (
									<article
										key={card.id}
										data-testid="anki-queue-card"
										className="flex flex-col rounded-2xl border border-border bg-card/60 p-5 transition-shadow hover:shadow-md"
									>
										<div className="mb-3 flex items-center justify-between gap-2">
											<span className="rounded-full bg-primary/10 px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide text-primary">
												{card.kind === "basic" ? "Question & answer" : "Cloze"}
											</span>
											<span className="text-xs text-muted-foreground">
												{new Date(card.updatedAt).toLocaleDateString("en-GB", {
													day: "numeric",
													month: "short",
												})}
											</span>
										</div>
										<button
											type="button"
											className="flex-1 text-left"
											onClick={() => anki?.openCard(card)}
										>
											<h2 className="line-clamp-3 whitespace-pre-wrap break-words font-prose text-xl leading-relaxed">
												{card.front || "An idea waiting for your words"}
											</h2>
											<p className="mt-2 line-clamp-2 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
												{card.source.title ||
													card.source.excerpt ||
													"Add a question, a sentence, or a source passage."}
											</p>
										</button>
										{card.tags.length > 0 && (
											<div className="mt-4 flex flex-wrap gap-1.5">
												{card.tags.map((tag) => (
													<span
														key={tag}
														className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
													>
														{tag}
													</span>
												))}
											</div>
										)}
										<div className="mt-5 flex items-center gap-2 border-t border-border pt-3">
											<Button
												variant="ghost"
												size="sm"
												onClick={() => anki?.openCard(card)}
											>
												{card.status === "sent" ? (
													<CheckCircle2Icon />
												) : (
													<PencilIcon />
												)}
												{card.status === "sent"
													? "View note"
													: card.status === "ready"
														? "Preview & send"
														: "Keep writing"}
											</Button>
											{href && (
												<Link
													className="ml-auto rounded-md p-2 text-muted-foreground hover:text-primary"
													href={href}
													aria-label="Open source lesson"
												>
													<ExternalLinkIcon className="size-4" />
												</Link>
											)}
											{card.status !== "sent" && (
												<Button
													className={href ? "" : "ml-auto"}
													variant="ghost"
													size="icon-sm"
													aria-label="Remove queued card"
													onClick={() => setConfirm(card.id)}
												>
													<Trash2Icon />
												</Button>
											)}
										</div>
										{confirm === card.id && (
											<div
												role="alert"
												className="mt-3 rounded-xl bg-destructive/5 p-3 text-sm"
											>
												<p>Remove this card from the notebook?</p>
												<div className="mt-2 flex gap-2">
													<Button
														variant="destructive"
														size="sm"
														disabled={removing === card.id}
														onClick={() => void remove(card)}
													>
														{removing === card.id ? "Removing…" : "Remove"}
													</Button>
													<Button
														variant="ghost"
														size="sm"
														onClick={() => setConfirm(null)}
													>
														Keep it
													</Button>
												</div>
											</div>
										)}
									</article>
								);
							})}
						</div>
					) : (
						<section className="rounded-2xl border border-dashed border-primary/25 px-6 py-12 text-center">
							<BookmarkPlusIcon className="mx-auto mb-4 size-8 text-primary/60" />
							<h2 className="font-title text-2xl">
								{search
									? "No matching cards"
									: tab === "draft"
										? "Your next little discovery goes here"
										: tab === "ready"
											? "A good card starts with understanding"
											: "A place for what you’ve kept"}
							</h2>
							<p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-muted-foreground">
								{search
									? "Try a different word or tag."
									: tab === "draft"
										? "Highlight a passage in a lesson and choose Keep selection, or start a card from your own Japanese material."
										: tab === "ready"
											? "Write a draft, test it with the answer hidden, then approve it. Approved cards wait here until you send or export them."
											: "Cards you send through LearnHarness will appear here, linked to their original lessons."}
							</p>
							{tab === "draft" && !search && (
								<Button className="mt-5" onClick={() => void anki?.openNew()}>
									<PlusIcon />
									Write your first card
								</Button>
							)}
						</section>
					)}
					{ready.length > 0 && (
						<section className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-border p-5">
							<div>
								<h2 className="text-sm font-semibold">
									Anki closed? Take your cards with you.
								</h2>
								<p className="mt-1 text-xs text-muted-foreground">
									Export approved cards for Anki’s File → Import. Exporting
									keeps them in the queue.
								</p>
							</div>
							<div className="flex flex-wrap gap-2">
								{(["basic", "cloze"] as const)
									.filter((kind) => ready.some((c) => c.kind === kind))
									.map((kind) => (
										<Button variant="outline" size="sm" asChild key={kind}>
											<a href={`/api/anki/export?kind=${kind}`} download>
												<DownloadIcon />
												{kind === "basic" ? "Basic" : "Cloze"} TSV
											</a>
										</Button>
									))}
							</div>
						</section>
					)}
					<p className="pb-4 text-center text-xs leading-relaxed text-muted-foreground">
						Inspired by{" "}
						<a
							href="https://www.super-memory.org/archive/articles/20rules.htm"
							target="_blank"
							rel="noreferrer"
							className="underline"
						>
							SuperMemo’s 20 principles
						</a>
						. LearnHarness helps you write; Anki handles spaced repetition.
					</p>
				</div>
			</div>
		</div>
	);
}
