"use client";

import { useEffect, useState } from "react";
import type { CliConnectionStatus } from "@/src/core";

export function CliConnections() {
	const [connections, setConnections] = useState<CliConnectionStatus[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	async function refresh() {
		setBusy(true);
		try {
			const response = await fetch("/api/cli", { cache: "no-store" });
			if (!response.ok) throw new Error("Could not check local CLIs.");
			setConnections((await response.json()).connections); setError(null);
		} catch { setError("Could not check local CLIs. Try again."); }
		finally { setBusy(false); }
	}
	useEffect(() => { void refresh(); }, []);
	return <section className="space-y-3" data-testid="cli-connections">
		<div className="flex items-center justify-between gap-4">
			<h3 className="font-ui text-xs uppercase tracking-widest text-muted-foreground">Local CLIs</h3>
			<button type="button" disabled={busy} onClick={() => void refresh()} className="text-xs text-primary hover:underline disabled:opacity-50">{busy ? "Checking…" : "Refresh"}</button>
		</div>
		<p className="text-xs text-muted-foreground">Use your existing CLI sign-ins. Requests count toward your plans; no API key is needed. Choose CLI models in Settings → Agent, or in a session’s model picker. Background agents use the same model slots.</p>
		{connections.map((connection) => <div key={connection.id} className="rounded-lg border border-border bg-card p-3" data-testid={`connection-${connection.id}`}>
			<div className="flex items-center justify-between gap-3"><span className="font-semibold">{connection.label}</span><span className="text-xs text-muted-foreground">{connection.connected ? "Connected ♡" : connection.installed ? "Sign in required" : "Not installed"}</span></div>
			{connection.error && <p className="mt-2 text-xs text-muted-foreground">{connection.error}</p>}
		</div>)}
		{error && <p role="alert" className="text-xs text-destructive">{error}</p>}
	</section>;
}
