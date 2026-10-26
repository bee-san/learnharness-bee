"use client";

import { useEffect, useState } from "react";

export function WhisperConnection() {
	const [status, setStatus] = useState<{ ready: boolean; provider?: string; message?: string } | null>(null);
	async function refresh() {
		try { const response = await fetch("/api/stt/config", { cache: "no-store" }); setStatus(await response.json()); }
		catch { setStatus({ ready: false, message: "Could not check dictation. Please try again." }); }
	}
	useEffect(() => { void refresh(); }, []);
	const cloud = status?.provider === "deepgram";
	return <div className="mb-2 rounded-lg border border-border bg-card p-3" data-testid="whisper-connection">
		<div className="flex items-center justify-between gap-3">
			<span className="font-semibold">{cloud ? "Deepgram dictation" : "Local Whisper"}</span>
			<button type="button" onClick={() => void refresh()} className="text-xs text-primary hover:underline">Refresh</button>
		</div>
		<p className="mt-2 text-xs text-muted-foreground">{cloud ? "Cloud dictation is selected. It uses the Deepgram key below." : "Audio stays on this computer. English, with British spelling preferred. No API key needed."}</p>
		<p className="mt-2 text-xs text-muted-foreground">{status === null ? "Checking…" : cloud ? "Cloud provider selected" : status.ready ? "Ready ♡" : status.message}</p>
	</div>;
}
