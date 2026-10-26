"use client";

import { useEffect, useState } from "react";
import { CheckCircle2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	ANKI_ROLES,
	type AnkiDestination,
	type AnkiModelInfo,
	type AnkiContent,
	type AnkiRole,
} from "@/src/core";
import { AnkiConnectionPanel, useAnkiConnection } from "./connection";

const selectClass =
	"h-9 w-full rounded-lg border border-input bg-background px-2 text-sm focus-visible:outline-2 focus-visible:outline-ring";
const LABELS: Record<AnkiRole, string> = {
	front: "Question / sentence",
	back: "Answer",
	reading: "Japanese reading",
	extra: "Extra / explanation",
	source: "Source",
};

export function AnkiDestinationPicker({
	kind,
	value,
	onChange,
	onReady,
}: {
	kind: AnkiContent["kind"];
	value: AnkiDestination;
	onChange: (v: AnkiDestination) => void;
	onReady: (ready: boolean) => void;
}) {
	const { connection, modelInfo } = useAnkiConnection();
	const [model, setModel] = useState<AnkiModelInfo | null>(null);
	const [error, setError] = useState("");
	useEffect(() => {
		setModel(null);
		setError("");
		if (!connection?.connected || !value.model) return;
		const controller = new AbortController();
		modelInfo(value.model, controller.signal)
			.then((info) => {
				if (!info.fields) throw new Error("The note type could not be loaded.");
				setModel(info);
			})
			.catch((e) => {
				if (!controller.signal.aborted) setError(e.message);
			});
		return () => controller.abort();
	}, [connection, value.model, modelInfo]);
	const valid =
		!!connection?.connected &&
		!!model &&
		model.cloze === (kind === "cloze") &&
		!!value.deck &&
		connection.decks.includes(value.deck) &&
		!!value.fields.front &&
		(!model.cloze || model.clozeFields.includes(value.fields.front)) &&
		!!(kind === "cloze" ? value.fields.extra : value.fields.back) &&
		Object.values(value.fields).every((f) => model.fields.includes(f)) &&
		new Set(Object.values(value.fields)).size ===
			Object.values(value.fields).length;
	useEffect(() => {
		onReady(valid);
	}, [valid, onReady]);
	const chooseModel = (name: string) =>
		onChange({
			...value,
			model: name,
			fields:
				name === "Basic"
					? { front: "Front", back: "Back" }
					: name === "Cloze"
						? { front: "Text", extra: "Back Extra" }
						: {},
		});
	return (
		<section
			aria-label="Anki destination"
			className="space-y-4 rounded-xl border border-border bg-card/60 p-4"
		>
			<AnkiConnectionPanel />
			{connection?.connected && (
				<>
					<p className="flex items-center gap-1.5 text-xs text-primary">
						<CheckCircle2Icon className="size-3.5" />
						Anki connected
					</p>
					<p className="text-xs leading-relaxed text-muted-foreground">
						Your Anki note type controls the final design and may create
						additional cards, such as a reverse card.
					</p>
					<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
						<label className="space-y-1 text-xs">
							Deck
							<select
								aria-label="Anki deck"
								className={selectClass}
								value={value.deck}
								onChange={(e) => onChange({ ...value, deck: e.target.value })}
							>
								<option value="">Choose a deck</option>
								{connection.decks.map((d) => (
									<option key={d}>{d}</option>
								))}
							</select>
						</label>
						<label className="space-y-1 text-xs">
							Note type
							<select
								aria-label="Anki note type"
								className={selectClass}
								value={value.model}
								onChange={(e) => chooseModel(e.target.value)}
							>
								<option value="">Choose a note type</option>
								{connection.models.map((m) => (
									<option key={m}>{m}</option>
								))}
							</select>
						</label>
					</div>
					{model && model.cloze !== (kind === "cloze") ? (
						<p role="alert" className="text-sm text-destructive">
							This note type is {model.cloze ? "Cloze" : "Basic"}. Choose one
							that matches your card.
						</p>
					) : (
						model && (
							<details open={!valid} className="text-xs">
								<summary className="cursor-pointer py-1 text-muted-foreground">
									Match your note fields
								</summary>
								<div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
									{ANKI_ROLES.filter(
										(role) => kind === "basic" || role !== "back",
									).map((role) => (
										<label key={role} className="space-y-1">
											{LABELS[role]}
											{role === "front" ||
											(kind === "basic" ? role === "back" : role === "extra")
												? " *"
												: ""}
											<select
												aria-label={`Map ${LABELS[role]}`}
												className={selectClass}
												value={value.fields[role] || ""}
												onChange={(e) => {
													const fields = { ...value.fields };
													if (e.target.value) fields[role] = e.target.value;
													else delete fields[role];
													onChange({ ...value, fields });
												}}
											>
												<option value="">
													{role === "front" ||
													(kind === "basic"
														? role === "back"
														: role === "extra")
														? "Choose field"
														: "Include on answer side"}
												</option>
												{model.fields.map((f) => (
													<option key={f}>{f}</option>
												))}
											</select>
										</label>
									))}
								</div>
								<p className="mt-2 text-muted-foreground">
									Unmapped reading, explanation and source are included on the
									answer side. Each selected field must be different.
								</p>
							</details>
						)
					)}
					{error && (
						<p role="alert" className="text-sm text-destructive">
							{error}
						</p>
					)}
				</>
			)}
		</section>
	);
}
