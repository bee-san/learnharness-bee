"use client";

import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
	type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Dialog } from "radix-ui";
import { BookmarkPlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { finishDictation } from "@/components/dictation";
import {
	emptyAnkiContent,
	type AnkiCard,
	type AnkiContent,
	type AnkiSource,
} from "@/src/core";
import { ankiApi, notifyAnkiChanged } from "./api";
import { AnkiEditor } from "./editor";
import { AnkiConnectionProvider } from "./connection";

const Context = createContext<{
	openNew: (
		source?: Partial<AnkiSource>,
		content?: AnkiContent,
	) => Promise<void>;
	openCard: (card: AnkiCard) => void;
} | null>(null);
export function useAnki() {
	return useContext(Context);
}

export function AnkiProvider({ children }: { children: ReactNode }) {
	const [card, setCard] = useState<AnkiCard | null>(null);
	const [opening, setOpening] = useState(false);
	const [error, setError] = useState("");
	const openingRef = useRef(false);
	const openNew = useCallback(
		async (source?: Partial<AnkiSource>, content?: AnkiContent) => {
			if (openingRef.current) return;
			openingRef.current = true;
			setOpening(true);
			setError("");
			try {
				await finishDictation();
				const { card: draft } = await ankiApi<{ card: AnkiCard }>(
					"cards",
					content || emptyAnkiContent(source),
				);
				setCard(draft);
				notifyAnkiChanged();
			} catch (e) {
				setError((e as Error).message);
			} finally {
				openingRef.current = false;
				setOpening(false);
			}
		},
		[],
	);
	const openCard = useCallback((value: AnkiCard) => {
		void finishDictation().then(() => setCard(value));
	}, []);
	return (
		<AnkiConnectionProvider>
			<Context.Provider value={{ openNew, openCard }}>
				{children}
				<SelectionKeeper disabled={!!card || opening} open={openNew} />
				{card && (
					<AnkiEditor
						key={card.id}
						initial={card}
						onClose={() => setCard(null)}
						onDuplicate={(content) => {
							void openNew(undefined, content);
						}}
					/>
				)}
				{!card && (opening || error) && (
					<Dialog.Root
						open
						onOpenChange={() => {
							if (!opening) setError("");
						}}
					>
						<Dialog.Portal>
							<Dialog.Overlay className="fixed inset-0 z-[100] bg-black/30" />
							<Dialog.Content className="fixed left-1/2 top-1/2 z-[101] w-[min(90vw,28rem)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-background p-6 shadow-xl">
								<Dialog.Title className="font-title text-xl">
									Keep something worth remembering
								</Dialog.Title>
								<Dialog.Description
									className="mt-3 text-sm"
									role={error ? "alert" : "status"}
								>
									{error || "Saving a place for your new card…"}
								</Dialog.Description>
								{error && (
									<Dialog.Close asChild>
										<Button className="mt-4" variant="outline">
											Close
										</Button>
									</Dialog.Close>
								)}
							</Dialog.Content>
						</Dialog.Portal>
					</Dialog.Root>
				)}
			</Context.Provider>
		</AnkiConnectionProvider>
	);
}

/** A passage action uses the learner's selection when it belongs to this passage. */
export function AnkiPassage({
	text,
	source,
	children,
}: {
	text: string;
	source: Partial<AnkiSource>;
	children: ReactNode;
}) {
	const anki = useAnki();
	const ref = useRef<HTMLDivElement>(null);
	if (!anki) return <>{children}</>;
	return (
		<div
			ref={ref}
			className="group/anki"
			data-anki-source
			data-anki-title={source.title}
			data-anki-chat-id={source.chatId}
			data-anki-message-id={source.messageId}
		>
			{children}
			<div className="mt-1 flex justify-end">
				<button
					type="button"
					disabled={!text.trim()}
					className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground opacity-100 transition-opacity hover:bg-primary/5 hover:text-primary focus-visible:opacity-100 sm:opacity-0 sm:group-hover/anki:opacity-100"
					onPointerDown={(e) => e.preventDefault()}
					onClick={() => {
						const selection = window.getSelection();
						const excerpt =
							selection?.rangeCount &&
							ref.current?.contains(selection.anchorNode) &&
							ref.current?.contains(selection.focusNode) &&
							selection.toString().trim()
								? selection.toString().trim()
								: text;
						void anki.openNew({ ...source, excerpt: excerpt.slice(0, 16000) });
					}}
				>
					<BookmarkPlusIcon className="size-3.5" />
					Keep in Anki
				</button>
			</div>
		</div>
	);
}

function SelectionKeeper({
	disabled,
	open,
}: {
	disabled: boolean;
	open: (source: Partial<AnkiSource>) => Promise<void>;
}) {
	const [selection, setSelection] = useState<{
		x: number;
		y: number;
		source: Partial<AnkiSource>;
	} | null>(null);
	useEffect(() => {
		if (disabled) {
			setSelection(null);
			return;
		}
		const read = () => {
			const s = window.getSelection();
			const text = s?.toString().trim();
			const node =
				s?.anchorNode instanceof Element
					? s.anchorNode
					: s?.anchorNode?.parentElement;
			const passage = node?.closest<HTMLElement>(
				"[data-anki-source], [data-session-find-root]",
			);
			if (
				!s?.rangeCount ||
				!text ||
				text.length < 3 ||
				!passage ||
				!passage.contains(s.focusNode)
			) {
				setSelection(null);
				return;
			}
			const bounds = s.getRangeAt(0).getBoundingClientRect();
			const session = passage.closest<HTMLElement>("[data-session-find-root]");
			const message = node?.closest<HTMLElement>("[data-source-message-id]");
			setSelection({
				x: Math.max(8, Math.min(window.innerWidth - 180, bounds.left)),
				y: Math.max(8, Math.min(window.innerHeight - 50, bounds.bottom + 8)),
				source: {
					excerpt: text.slice(0, 16000),
					title:
						passage.dataset.ankiTitle ||
						session?.dataset.ankiTitle ||
						"Lesson passage",
					chatId: passage.dataset.ankiChatId || session?.dataset.ankiChatId,
					messageId:
						passage.dataset.ankiMessageId || message?.dataset.sourceMessageId,
				},
			});
		};
		const dismiss = () => setSelection(null);
		document.addEventListener("pointerup", read);
		document.addEventListener("keyup", read);
		window.addEventListener("scroll", dismiss, true);
		return () => {
			document.removeEventListener("pointerup", read);
			document.removeEventListener("keyup", read);
			window.removeEventListener("scroll", dismiss, true);
		};
	}, [disabled]);
	if (!selection || disabled) return null;
	return createPortal(
		<Button
			data-testid="anki-keep-selection"
			size="sm"
			className="fixed z-50 shadow-lg"
			style={{ left: selection.x, top: selection.y }}
			onPointerDown={(e) => e.preventDefault()}
			onClick={() => {
				const source = selection.source;
				setSelection(null);
				window.getSelection()?.removeAllRanges();
				void open(source);
			}}
		>
			<BookmarkPlusIcon />
			Keep selection
		</Button>,
		document.body,
	);
}
