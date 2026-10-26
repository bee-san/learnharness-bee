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
import {
	CheckCircle2Icon,
	LaptopIcon,
	ServerIcon,
	RefreshCwIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	readAnkiModel,
	type AnkiConnection,
	type AnkiInvoke,
	type AnkiModelInfo,
} from "@/src/core";
import { ankiApi } from "./api";
import {
	browserAnkiInvoke,
	browserAnkiUrl,
	DEFAULT_BROWSER_ANKI_URL,
	requestBrowserAnkiPermission,
} from "./browser-transport";

type Mode = "browser" | "server";
type ConnectionState = {
	mode: Mode;
	setMode: (mode: Mode) => void;
	endpoint: string;
	setEndpoint: (value: string) => void;
	apiKey: string;
	setApiKey: (value: string) => void;
	connection: AnkiConnection | null;
	loading: boolean;
	connect: () => Promise<void>;
	disconnect: () => void;
	invoke: AnkiInvoke;
	modelInfo: (name: string, signal: AbortSignal) => Promise<AnkiModelInfo>;
};
const Context = createContext<ConnectionState | null>(null);
export function useAnkiConnection() {
	const value = useContext(Context);
	if (!value) throw new Error("Anki connection provider is missing.");
	return value;
}
export function AnkiConnectionProvider({ children }: { children: ReactNode }) {
	const [mode, updateMode] = useState<Mode>("browser");
	const [endpoint, updateEndpoint] = useState(DEFAULT_BROWSER_ANKI_URL);
	const [apiKey, updateKey] = useState("");
	const [connection, setConnection] = useState<AnkiConnection | null>(null);
	const [loading, setLoading] = useState(false);
	const generation = useRef(0);
	useEffect(() => {
		try {
			const saved = JSON.parse(
				localStorage.getItem("lh:anki-connection") || "null",
			);
			if (saved?.mode === "server") updateMode("server");
			if (typeof saved?.endpoint === "string")
				updateEndpoint(browserAnkiUrl(saved.endpoint));
		} catch {
			/* keep local defaults */
		}
	}, []);
	const reset = useCallback(() => {
		generation.current++;
		setConnection(null);
		setLoading(false);
	}, []);
	const setMode = useCallback(
		(next: Mode) => {
			reset();
			updateMode(next);
		},
		[reset],
	);
	const setEndpoint = useCallback(
		(next: string) => {
			reset();
			updateEndpoint(next);
		},
		[reset],
	);
	const setApiKey = useCallback(
		(next: string) => {
			reset();
			updateKey(next);
		},
		[reset],
	);
	useEffect(() => {
		try {
			localStorage.setItem(
				"lh:anki-connection",
				JSON.stringify({ mode, endpoint }),
			);
		} catch {
			/* optional non-secret preferences */
		}
	}, [mode, endpoint]);
	const invoke = useCallback<AnkiInvoke>(
		(action, params, signal) =>
			browserAnkiInvoke(endpoint, apiKey)(action, params, signal),
		[endpoint, apiKey],
	);
	const connect = useCallback(async () => {
		const own = ++generation.current;
		setLoading(true);
		try {
			let info: AnkiConnection;
			if (mode === "server") info = await ankiApi<AnkiConnection>("connection");
			else {
				// A deliberate click starts both browser and Anki permissions.
				await requestBrowserAnkiPermission(
					browserAnkiInvoke(endpoint, apiKey, 120000),
				);
				const [decks, models] = await Promise.all([
					invoke<string[]>("deckNames"),
					invoke<string[]>("modelNames"),
				]);
				if (!Array.isArray(decks) || !Array.isArray(models))
					throw new Error(
						"Anki returned invalid deck or note-type information.",
					);
				info = { connected: true, decks, models };
			}
			if (own === generation.current) setConnection(info);
		} catch (e) {
			if (own === generation.current)
				setConnection({
					connected: false,
					decks: [],
					models: [],
					message: (e as Error).message,
				});
		} finally {
			if (own === generation.current) setLoading(false);
		}
	}, [mode, endpoint, apiKey, invoke]);
	const modelInfo = useCallback(
		async (name: string, signal: AbortSignal) => {
			if (!connection?.connected) throw new Error("Connect to Anki first.");
			if (mode === "browser") return readAnkiModel(invoke, name, signal);
			const info = await ankiApi<AnkiModelInfo & { message?: string }>(
				`connection?model=${encodeURIComponent(name)}`,
				undefined,
				"GET",
				signal,
			);
			if (!info.fields)
				throw new Error(info.message || "The note type could not be loaded.");
			return info;
		},
		[mode, connection, invoke],
	);
	return (
		<Context.Provider
			value={{
				mode,
				setMode,
				endpoint,
				setEndpoint,
				apiKey,
				setApiKey,
				connection,
				loading,
				connect,
				disconnect: () => {
					reset();
					updateKey("");
				},
				invoke,
				modelInfo,
			}}
		>
			{children}
		</Context.Provider>
	);
}

export function AnkiConnectionPanel() {
	const c = useAnkiConnection();
	return (
		<section
			aria-label="Anki connection"
			className="space-y-3 rounded-xl border border-border bg-card/60 p-4"
		>
			<div>
				<h3 className="text-sm font-semibold">Where is Anki running?</h3>
				<p className="mt-1 text-xs leading-relaxed text-muted-foreground">
					Teach on your server. Keep Anki on the device you use.
				</p>
			</div>
			<div className="flex flex-wrap gap-2">
				{(["browser", "server"] as const).map((mode) => (
					<Button
						key={mode}
						size="sm"
						variant={c.mode === mode ? "default" : "outline"}
						aria-pressed={c.mode === mode}
						onClick={() => c.setMode(mode)}
						disabled={c.loading}
					>
						{mode === "browser" ? <LaptopIcon /> : <ServerIcon />}
						{mode === "browser" ? "This device" : "App server"}
					</Button>
				))}
			</div>
			{c.mode === "browser" && (
				<details>
					<summary className="cursor-pointer text-xs text-muted-foreground">
						Local address & optional API key
					</summary>
					<div className="mt-3 space-y-3">
						<label className="block space-y-1 text-xs">
							AnkiConnect address
							<input
								aria-label="Browser AnkiConnect address"
								className="h-9 w-full rounded-lg border border-input bg-background px-2 text-sm"
								value={c.endpoint}
								onChange={(e) => c.setEndpoint(e.target.value)}
								placeholder={DEFAULT_BROWSER_ANKI_URL}
							/>
						</label>
						<label className="block space-y-1 text-xs">
							API key, if set in AnkiConnect
							<input
								aria-label="Browser AnkiConnect API key"
								type="password"
								autoComplete="off"
								className="h-9 w-full rounded-lg border border-input bg-background px-2 text-sm"
								value={c.apiKey}
								onChange={(e) => c.setApiKey(e.target.value)}
							/>
						</label>
						<p className="text-xs leading-relaxed text-muted-foreground">
							The key stays in this page’s memory and goes only to your local
							Anki. It is never sent to the app server.
						</p>
					</div>
				</details>
			)}
			{c.connection?.connected ? (
				<div className="flex flex-wrap items-center justify-between gap-2">
					<p className="flex items-center gap-1.5 text-xs text-primary">
						<CheckCircle2Icon className="size-4" />
						{c.mode === "browser"
							? "Connected to Anki on this device"
							: "Connected to Anki on the app server"}
					</p>
					<Button variant="ghost" size="sm" onClick={() => c.disconnect()}>
						Disconnect
					</Button>
				</div>
			) : (
				<p className="text-xs leading-relaxed text-muted-foreground">
					{c.mode === "browser"
						? "Open desktop Anki on this device with AnkiConnect installed. Use HTTPS for a hosted LearnHarness. Allow Apps on device / local network in the browser and approve this site’s address in Anki when prompted."
						: "Open desktop Anki on the app server with AnkiConnect installed."}
				</p>
			)}
			{c.connection?.message && (
				<p role="alert" className="text-sm leading-relaxed text-destructive">
					{c.connection.message}
				</p>
			)}
			<Button
				size="sm"
				variant="outline"
				className="w-full"
				disabled={c.loading}
				onClick={() => void c.connect()}
			>
				<RefreshCwIcon className={c.loading ? "animate-spin" : ""} />
				{c.loading
					? "Connecting — check browser and Anki prompts…"
					: c.connection?.connected
						? "Refresh Anki connection"
						: c.mode === "browser"
							? "Connect Anki on this device"
							: "Connect Anki on app server"}
			</Button>
			<p className="text-xs text-muted-foreground">
				Need the add-on?{" "}
				<a
					className="underline"
					href="https://ankiweb.net/shared/info/2055492159"
					target="_blank"
					rel="noreferrer"
				>
					Install AnkiConnect
				</a>
				. Anki can keep listening on localhost.
			</p>
		</section>
	);
}
