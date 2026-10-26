"use client";

import { EyeIcon, RotateCcwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { clozeParts, type AnkiContent } from "@/src/core";

export function AnkiPreview({
	card,
	revealed,
	onReveal,
}: {
	card: AnkiContent;
	revealed: boolean;
	onReveal: () => void;
}) {
	return (
		<section
			aria-label="Card preview"
			className="overflow-hidden rounded-2xl border border-primary/20 bg-background shadow-sm"
		>
			<div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-3 text-xs text-muted-foreground">
				<span>
					RECALL PREVIEW · {card.kind === "basic" ? "BASIC" : "CLOZE"}
				</span>
				<span>Try recalling before revealing</span>
			</div>
			<div className="flex min-h-36 flex-col items-center justify-center gap-5 p-6 text-center">
				<div
					data-testid="anki-preview-front"
					className="whitespace-pre-wrap break-words font-prose text-xl leading-relaxed"
					lang={/[\u3000-\u9fff]/.test(card.front) ? "ja" : undefined}
				>
					{card.kind === "basic"
						? card.front || "Your question goes here"
						: clozeParts(card.front).map((part, i) =>
								part.answer !== undefined ? (
									<span
										key={i}
										className="rounded bg-primary/10 px-1 font-semibold text-primary"
									>
										{revealed ? part.answer : `[${part.hint || "…"}]`}
									</span>
								) : (
									part.text
								),
							)}
				</div>
				{!revealed ? (
					<Button
						variant="outline"
						onClick={onReveal}
						data-testid="anki-reveal"
					>
						<EyeIcon />
						Show answer
					</Button>
				) : (
					<>
						<div className="w-full border-t border-dashed border-primary/20 pt-4">
							{card.reading && (
								<p
									className="mb-2 whitespace-pre-wrap text-sm text-primary"
									lang="ja"
								>
									{card.reading}
								</p>
							)}
							{card.back && (
								<p
									data-testid="anki-preview-back"
									className="whitespace-pre-wrap break-words font-prose text-xl"
								>
									{card.back}
								</p>
							)}
							{card.extra && (
								<p className="mt-4 whitespace-pre-wrap break-words text-sm leading-relaxed text-muted-foreground">
									{card.extra}
								</p>
							)}
						</div>
						<Button variant="ghost" size="sm" onClick={onReveal}>
							<RotateCcwIcon />
							Hide answer
						</Button>
					</>
				)}
			</div>
		</section>
	);
}
