"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog } from "radix-ui";
import Link from "next/link";
import {
	ArrowRightIcon,
	CheckIcon,
	CheckCircle2Icon,
	ExternalLinkIcon,
	SendIcon,
	SparklesIcon,
	XIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	DictationBar,
	joinDictation,
	useDictation,
} from "@/components/dictation";
import {
	ankiContentProblems,
	ankiSourcePath,
	ankiWritingHints,
	type AnkiCard,
	type AnkiContent,
	type AnkiCoaching,
	type AnkiDestination,
} from "@/src/core";
import { ankiApi, notifyAnkiChanged } from "./api";
import { AnkiPreview } from "./preview";
import { AnkiDestinationPicker } from "./destination";
import { useAnkiConnection } from "./connection";
import { sendBrowserAnki } from "./browser-send";

const fieldClass =
	"w-full resize-y rounded-xl border border-input bg-background px-3 py-2.5 font-prose text-base leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60";
function contentOf(card: AnkiContent): AnkiContent {
	return {
		kind: card.kind,
		front: card.front,
		back: card.back,
		reading: card.reading,
		extra: card.extra,
		tags: card.tags,
		source: card.source,
	};
}
function defaultDestination(kind: AnkiContent["kind"]): AnkiDestination {
	return {
		deck: "",
		model: kind === "basic" ? "Basic" : "Cloze",
		fields:
			kind === "basic"
				? { front: "Front", back: "Back" }
				: { front: "Text", extra: "Back Extra" },
	};
}

export function AnkiEditor({
	initial,
	onClose,
	onDuplicate,
}: {
	initial: AnkiCard;
	onClose: () => void;
	onDuplicate: (card: AnkiContent) => void;
}) {
	const [card, setCard] = useState(initial);
	const ankiConnection = useAnkiConnection();
	const savedRef = useRef(initial);
	const [content, setContent] = useState<AnkiContent>(() => contentOf(initial));
	const [tagsText, setTagsText] = useState(initial.tags.join(" "));
	const latest = useRef(content);
	latest.current = content;
	const chain = useRef<Promise<AnkiCard>>(Promise.resolve(initial));
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");
	const [revealed, setRevealed] = useState(false);
	const [previewed, setPreviewed] = useState(false);
	const [understood, setUnderstood] = useState(false);
	const [feedback, setFeedback] = useState<AnkiCoaching | null>(null);
	const [coaching, setCoaching] = useState(false);
	const coachAbort = useRef<AbortController | null>(null);
	const [sending, setSending] = useState(false);
	const [closing, setClosing] = useState(false);
	const [destination, setDestination] = useState<AnkiDestination>(
		() => initial.destination || defaultDestination(initial.kind),
	);
	const [destinationReady, setDestinationReady] = useState(false);
	const [dictationField, setDictationField] = useState<
		"front" | "back" | "reading" | "extra"
	>("front");
	const target = useRef(dictationField);
	target.current = dictationField;
	const frozen = card.status === "sent";
	const busy = saving || sending || closing;
	const dirty = JSON.stringify(content) !== JSON.stringify(contentOf(card));
	const status = frozen ? "sent" : dirty ? "draft" : card.status;
	const change = useCallback((patch: Partial<AnkiContent>) => {
		setContent((c) => {
			const next = { ...c, ...patch };
			latest.current = next;
			return next;
		});
		setPreviewed(false);
		setRevealed(false);
		setUnderstood(false);
		setError("");
	}, []);
	const append = useCallback(
		(text: string) =>
			change({
				[target.current]: joinDictation(latest.current[target.current], text),
			}),
		[change],
	);
	const dictation = useDictation({ append, ownTarget: true, shortcuts: false });
	const problems = ankiContentProblems(content);

	// Serialise autosave and explicit approval. A stale browser must never
	// overwrite another tab's edits, or regress an approval after a slow save.
	const save = useCallback(
		(status: "draft" | "ready" = "draft", approval = false) => {
			const snapshot = structuredClone(latest.current);
			const task = chain.current
				.catch(() => savedRef.current)
				.then(async () => {
					if (savedRef.current.status === "sent") return savedRef.current;
					if (
						status === "draft" &&
						JSON.stringify(snapshot) ===
							JSON.stringify(contentOf(savedRef.current))
					)
						return savedRef.current;
					setSaving(true);
					try {
						const { card: next } = await ankiApi<{ card: AnkiCard }>(
							`cards/${initial.id}`,
							{
								...snapshot,
								revision: savedRef.current.revision,
								status,
								understood: approval,
								previewed: approval,
							},
							"PUT",
						);
						savedRef.current = next;
						setCard(next);
						setError("");
						notifyAnkiChanged();
						return next;
					} catch (e) {
						setError((e as Error).message);
						throw e;
					} finally {
						setSaving(false);
					}
				});
			chain.current = task;
			return task;
		},
		[initial.id],
	);
	useEffect(() => {
		if (
			frozen ||
			JSON.stringify(content) === JSON.stringify(contentOf(savedRef.current))
		)
			return;
		const timer = setTimeout(() => {
			void save().catch(() => {});
		}, 700);
		return () => clearTimeout(timer);
	}, [content, frozen, save]);
	useEffect(() => {
		try {
			const previous = localStorage.getItem(
				`lh:anki-destination:${content.kind}`,
			);
			if (previous) {
				const value = JSON.parse(previous);
				if (
					value &&
					typeof value.deck === "string" &&
					typeof value.model === "string" &&
					value.fields &&
					typeof value.fields === "object"
				)
					setDestination(value);
			} else setDestination(defaultDestination(content.kind));
		} catch {
			setDestination(defaultDestination(content.kind));
		}
	}, [content.kind]);
	useEffect(() => () => coachAbort.current?.abort(), []);
	useEffect(() => {
		const prevent = (e: BeforeUnloadEvent) => {
			if (
				JSON.stringify(latest.current) !==
				JSON.stringify(contentOf(savedRef.current))
			)
				e.preventDefault();
		};
		window.addEventListener("beforeunload", prevent);
		return () => window.removeEventListener("beforeunload", prevent);
	}, []);

	const close = async () => {
		if (sending || closing) return;
		setClosing(true);
		try {
			await dictation.finish();
			await save();
			coachAbort.current?.abort();
			onClose();
		} catch {
			setClosing(false);
		}
	};
	const coach = async () => {
		setCoaching(true);
		setError("");
		const controller = new AbortController();
		coachAbort.current = controller;
		try {
			await dictation.finish();
			await save();
			const snapshot = structuredClone(latest.current);
			const result = await ankiApi<AnkiCoaching>(
				"coach",
				snapshot,
				"POST",
				controller.signal,
			);
			if (!controller.signal.aborted) setFeedback(result);
		} catch (e) {
			if (!controller.signal.aborted) setError((e as Error).message);
		} finally {
			setCoaching(false);
		}
	};
	const approve = async () => {
		try {
			await dictation.finish();
			if (
				previewed &&
				understood &&
				!ankiContentProblems(latest.current).length
			)
				await save("ready", true);
		} catch {
			/* save shows the error; the draft remains editable */
		}
	};
	const send = async () => {
		setSending(true);
		setError("");
		try {
			await chain.current;
			const update = (next: AnkiCard) => {
				savedRef.current = next;
				setCard(next);
				notifyAnkiChanged();
			};
			const next =
				ankiConnection.mode === "browser"
					? await sendBrowserAnki(
							savedRef.current,
							destination,
							ankiConnection.invoke,
							update,
						)
					: (
							await ankiApi<{ card: AnkiCard }>(`cards/${card.id}/send`, {
								revision: savedRef.current.revision,
								destination,
							})
						).card;
			savedRef.current = next;
			setCard(next);
			notifyAnkiChanged();
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setSending(false);
		}
	};
	const rememberDestination = (value: AnkiDestination) => {
		setDestination(value);
		try {
			localStorage.setItem(
				`lh:anki-destination:${content.kind}`,
				JSON.stringify(value),
			);
		} catch {
			/* optional preference only */
		}
	};
	const sourcePath = ankiSourcePath(content.source);

	return (
		<Dialog.Root
			open
			onOpenChange={(open) => {
				if (!open) void close();
			}}
		>
			<Dialog.Portal>
				<Dialog.Overlay className="fixed inset-0 z-[100] bg-black/35 backdrop-blur-sm" />
				<Dialog.Content
					aria-describedby="anki-description"
					className="fixed inset-x-2 bottom-2 top-2 z-[101] mx-auto flex max-w-5xl flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-2xl sm:inset-x-6 sm:bottom-[4vh] sm:top-[4vh]"
					onEscapeKeyDown={(e) => {
						e.preventDefault();
						e.stopPropagation();
						if (dictation.active) dictation.cancel();
						else void close();
					}}
					onPointerDownOutside={(e) => {
						e.preventDefault();
					}}
					onKeyDown={(e) => {
						if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") {
							e.preventDefault();
							e.stopPropagation();
							if (!frozen) dictation.toggle();
						}
					}}
				>
					<header className="flex shrink-0 items-center gap-3 border-b border-border px-5 py-4">
						<div className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
							<SparklesIcon className="size-5" />
						</div>
						<div className="min-w-0 flex-1">
							<Dialog.Title className="font-title text-2xl">
								Make it memorable
							</Dialog.Title>
							<Dialog.Description
								id="anki-description"
								className="text-xs text-muted-foreground"
							>
								Your words. One useful thing to remember.
							</Dialog.Description>
						</div>
						<span
							role="status"
							className="hidden text-xs text-muted-foreground sm:inline"
						>
							{saving
								? "Saving…"
								: error && dirty
									? "Changes not saved"
									: status === "sent"
										? "In Anki"
										: status === "ready"
											? "Ready for Anki"
											: dirty
												? "Unsaved changes"
												: "Draft saved"}
						</span>
						<Button
							aria-label="Save and close card editor"
							variant="ghost"
							size="icon-sm"
							disabled={busy || dictation.phase === "stopping"}
							onClick={() => void close()}
						>
							<XIcon />
						</Button>
					</header>
					<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 sm:p-6">
						<div className="grid items-start gap-6 lg:grid-cols-[1.1fr_1fr]">
							<div className="space-y-5">
								{frozen ? (
									<div className="rounded-xl border border-primary/20 bg-primary/5 p-4">
										<p className="flex items-center gap-2 font-medium">
											<CheckCircle2Icon className="size-4 text-primary" />
											Saved in Anki
										</p>
										<p className="mt-2 text-sm text-muted-foreground">
											{card.destination?.deck} · {card.destination?.model}
											<br />
											Edit this note in Anki to preserve its review history.
										</p>
										<Button
											variant="outline"
											className="mt-3"
											onClick={() => {
												void save()
													.then(() => onDuplicate(latest.current))
													.catch(() => {});
											}}
										>
											Make a new draft from this
										</Button>
									</div>
								) : (
									<div className="rounded-xl bg-primary/5 p-4 text-sm leading-relaxed">
										Start with something you understand and want to keep. Write
										the prompt in your own words; the teacher can help refine
										it.
									</div>
								)}
								<fieldset disabled={frozen || sending} className="space-y-4">
									<legend className="sr-only">Write your card</legend>
									<div
										className="flex rounded-xl border border-border bg-card p-1"
										aria-label="Card format"
									>
										{(["basic", "cloze"] as const).map((kind) => (
											<button
												type="button"
												key={kind}
												aria-pressed={content.kind === kind}
												onClick={() => {
													change({ kind });
													setFeedback(null);
												}}
												className={`flex-1 rounded-lg px-3 py-2 text-sm transition-colors ${content.kind === kind ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:bg-accent"}`}
											>
												{kind === "basic"
													? "Question & answer"
													: "Cloze deletion"}
											</button>
										))}
									</div>
									<label className="block space-y-2 text-sm font-medium">
										{content.kind === "basic"
											? "What do you want to recall?"
											: "Sentence with one hidden target"}
										<textarea
											autoFocus
											rows={3}
											aria-label="Card front"
											maxLength={8000}
											className={fieldClass}
											value={content.front}
											onFocus={() => setDictationField("front")}
											onChange={(e) => change({ front: e.target.value })}
											placeholder={
												content.kind === "basic"
													? "Write a clear question, or a Japanese sentence with one target…"
													: "毎朝、{{c1::珈琲::飲み物}}を飲みます。"
											}
										/>
									</label>
									{content.kind === "cloze" && (
										<p className="-mt-2 text-xs text-muted-foreground">
											Select a word in the sentence, then{" "}
											<button
												type="button"
												className="font-medium text-primary underline"
												onClick={() => {
													const area =
														document.querySelector<HTMLTextAreaElement>(
															'[aria-label="Card front"]',
														);
													if (area && area.selectionEnd > area.selectionStart) {
														const start = area.selectionStart,
															end = area.selectionEnd;
														change({
															front:
																content.front.slice(0, start) +
																"{{c1::" +
																content.front.slice(start, end) +
																"}}" +
																content.front.slice(end),
														});
													}
												}}
											>
												hide it with c1
											</button>
											. One deletion number creates one card.
										</p>
									)}
									<label className="block space-y-2 text-sm font-medium">
										{content.kind === "basic"
											? "The smallest complete answer"
											: "Answer note (optional)"}
										<textarea
											rows={2}
											aria-label="Card answer"
											maxLength={8000}
											className={fieldClass}
											value={content.back}
											onFocus={() => setDictationField("back")}
											onChange={(e) => change({ back: e.target.value })}
											placeholder="Keep the essential answer short."
										/>
									</label>
									<label className="block space-y-2 text-sm font-medium">
										Reading{" "}
										<span className="font-normal text-muted-foreground">
											· optional, shown with the answer
										</span>
										<input
											aria-label="Japanese reading"
											maxLength={2000}
											className={fieldClass}
											value={content.reading}
											onFocus={() => setDictationField("reading")}
											onChange={(e) => change({ reading: e.target.value })}
											placeholder="かな reading, if useful"
											lang="ja"
										/>
									</label>
									<label className="block space-y-2 text-sm font-medium">
										Extra{" "}
										<span className="font-normal text-muted-foreground">
											· an explanation, example or mnemonic
										</span>
										<textarea
											rows={3}
											aria-label="Card extra"
											maxLength={8000}
											className={fieldClass}
											value={content.extra}
											onFocus={() => setDictationField("extra")}
											onChange={(e) => change({ extra: e.target.value })}
											placeholder="A personal example can make this easier to remember."
										/>
									</label>
									<label className="block space-y-2 text-sm font-medium">
										Tags
										<input
											aria-label="Card tags"
											className={fieldClass}
											value={tagsText}
											onChange={(e) => {
												setTagsText(e.target.value);
												change({
													tags: [
														...new Set(
															e.target.value.split(/\s+/).filter(Boolean),
														),
													].slice(0, 30),
												});
											}}
											placeholder="japanese grammar daily-life"
										/>
										<span className="block text-xs font-normal text-muted-foreground">
											Separate tags with spaces. Letters, numbers, _, :, . and -
											are supported.
										</span>
									</label>
								</fieldset>
								{!frozen && (
									<div className="rounded-xl border border-border p-3">
										<p className="mb-2 text-xs text-muted-foreground">
											Dictate into:{" "}
											{dictationField === "front"
												? "question / sentence"
												: dictationField === "back"
													? "answer"
													: dictationField}
											. Select a field to change the target.
										</p>
										<DictationBar dictation={dictation} />
									</div>
								)}
								<details
									open={!content.front}
									className="rounded-xl border border-border p-4"
								>
									<summary className="cursor-pointer text-sm font-medium">
										Original source & context {sourcePath && "· lesson linked"}
									</summary>
									<div className="mt-3 space-y-3">
										<label className="block space-y-1 text-xs">
											Source title
											<input
												aria-label="Source title"
												className={fieldClass}
												value={content.source.title}
												maxLength={500}
												disabled={frozen || sending}
												onChange={(e) =>
													change({
														source: {
															...content.source,
															title: e.target.value,
														},
													})
												}
											/>
										</label>
										<label className="block space-y-1 text-xs">
											Page, URL or reference
											<input
												aria-label="Source reference"
												className={fieldClass}
												value={content.source.reference}
												maxLength={2000}
												disabled={frozen || sending}
												onChange={(e) =>
													change({
														source: {
															...content.source,
															reference: e.target.value,
														},
													})
												}
												placeholder="Book title, p. 42, or a link"
											/>
										</label>
										<label className="block space-y-1 text-xs">
											Source passage
											<textarea
												aria-label="Source passage"
												rows={4}
												className={fieldClass}
												value={content.source.excerpt}
												maxLength={16000}
												disabled={frozen || sending}
												onChange={(e) =>
													change({
														source: {
															...content.source,
															excerpt: e.target.value,
														},
													})
												}
												placeholder="Paste a passage from your Japanese material…"
											/>
										</label>
										{sourcePath && (
											<Link
												href={sourcePath}
												target="_blank"
												rel="noreferrer"
												className="inline-flex items-center gap-1 text-xs text-primary underline"
											>
												<ExternalLinkIcon className="size-3" />
												Back to the lesson
											</Link>
										)}
									</div>
								</details>
							</div>
							<div className="space-y-5 lg:sticky lg:top-0">
								<AnkiPreview
									card={content}
									revealed={revealed}
									onReveal={() => {
										setRevealed((v) => !v);
										setPreviewed(true);
									}}
								/>
								{!frozen && (
									<>
										<section className="space-y-3 rounded-xl border border-border p-4">
											<h3 className="text-sm font-semibold">
												A little help with wording
											</h3>
											{ankiWritingHints(content).map((hint) => (
												<p
													key={hint}
													className="text-xs leading-relaxed text-muted-foreground"
												>
													{hint}
												</p>
											))}
											<Button
												className="w-full"
												variant="outline"
												disabled={
													coaching ||
													busy ||
													(!content.front.trim() &&
														!content.source.excerpt.trim())
												}
												onClick={() => void coach()}
											>
												<SparklesIcon />
												{coaching
													? "Teacher is reading your draft…"
													: content.front
														? "Get teacher feedback"
														: "Help me find a starting card"}
											</Button>
											<p className="text-xs text-muted-foreground">
												Uses your teacher model. Suggestions stay editable.
											</p>
											{coaching && (
												<Button
													variant="ghost"
													size="sm"
													onClick={() => {
														coachAbort.current?.abort();
														setCoaching(false);
													}}
												>
													Cancel feedback
												</Button>
											)}
											{feedback && (
												<div
													data-testid="anki-coaching"
													className="space-y-3 border-t border-border pt-3"
												>
													{feedback.feedback.map((f, i) => (
														<p key={i} className="text-sm leading-relaxed">
															{f}
														</p>
													))}
													{feedback.suggestions.map((s, i) => (
														<div
															key={i}
															className="space-y-2 rounded-xl bg-primary/5 p-3"
														>
															<p className="whitespace-pre-wrap text-sm font-medium">
																{s.front}
															</p>
															{s.back && (
																<p className="whitespace-pre-wrap text-sm">
																	{s.back}
																</p>
															)}
															<p className="text-xs leading-relaxed text-muted-foreground">
																{s.reason}
															</p>
															<div className="flex flex-wrap gap-2">
																<Button
																	size="sm"
																	variant="outline"
																	disabled={busy}
																	onClick={() => {
																		change({
																			front: s.front,
																			back: s.back,
																			reading: s.reading,
																			extra: s.extra,
																		});
																	}}
																>
																	Use this wording
																</Button>
																<Button
																	size="sm"
																	variant="ghost"
																	disabled={busy}
																	onClick={() => {
																		void save()
																			.then(() =>
																				onDuplicate({
																					...latest.current,
																					front: s.front,
																					back: s.back,
																					reading: s.reading,
																					extra: s.extra,
																				}),
																			)
																			.catch(() => {});
																	}}
																>
																	Keep as another draft
																</Button>
															</div>
														</div>
													))}
												</div>
											)}
										</section>
										{status !== "ready" ? (
											<section className="space-y-3 rounded-xl border border-primary/20 bg-primary/5 p-4">
												<label className="flex cursor-pointer items-start gap-3 text-sm leading-relaxed">
													<input
														type="checkbox"
														className="mt-1 size-4 accent-primary"
														checked={understood}
														onChange={(e) => setUnderstood(e.target.checked)}
													/>
													I understand this idea and want to remember it.
												</label>
												{content.front &&
													problems.map((problem) => (
														<p
															key={problem}
															className="text-xs text-muted-foreground"
														>
															{problem}
														</p>
													))}
												<Button
													className="w-full"
													disabled={
														busy ||
														!understood ||
														!previewed ||
														problems.length > 0 ||
														dictation.active
													}
													onClick={() => void approve()}
												>
													<CheckIcon />
													Approve for Anki
												</Button>
												{!previewed && (
													<p className="text-xs text-muted-foreground">
														Preview and reveal the answer before approving.
													</p>
												)}
											</section>
										) : (
											<p
												role="status"
												className="flex items-center gap-2 rounded-xl bg-primary/10 p-4 text-sm text-primary"
											>
												<CheckCircle2Icon className="size-4" />
												Approved. Ready when you are.
											</p>
										)}
										<AnkiDestinationPicker
											kind={content.kind}
											value={destination}
											onChange={rememberDestination}
											onReady={setDestinationReady}
										/>
										<Button
											className="w-full"
											disabled={
												status !== "ready" || !destinationReady || busy || dirty
											}
											onClick={() => void send()}
										>
											<SendIcon />
											{sending ? "Sending to Anki…" : "Send this card to Anki"}
										</Button>
									</>
								)}
							</div>
						</div>
					</div>
					{error && (
						<div
							role="alert"
							className="shrink-0 border-t border-destructive/20 bg-destructive/5 px-5 py-3 text-sm text-destructive"
						>
							{error}
							<Button
								variant="ghost"
								size="sm"
								onClick={() => void save().catch(() => {})}
							>
								Retry save
							</Button>
							{dirty && (
								<Button
									variant="ghost"
									size="sm"
									onClick={() => onDuplicate(latest.current)}
								>
									Keep my changes as a new draft
								</Button>
							)}
						</div>
					)}
					<footer className="flex shrink-0 items-center justify-between gap-3 border-t border-border px-5 py-3">
						<p className="text-xs text-muted-foreground">
							{frozen
								? `Note ${card.noteId}`
								: "Drafts save as you write. You choose what reaches Anki."}
						</p>
						<Button
							variant="outline"
							disabled={busy}
							onClick={() => void close()}
						>
							{closing ? "Saving…" : "Save & close"}
							<ArrowRightIcon />
						</Button>
					</footer>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
