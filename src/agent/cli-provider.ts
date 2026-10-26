/** Local CLI adapter. CLIs own authentication; credentials never enter
 * LearnHarness. Each model step is a bounded structured-output request.
 * LearnHarness alone executes the returned application tool calls. */
import { spawn, execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { Api, AssistantMessage, JsonObject, Model, ModelThinkingLevel, StreamFunction, Tool, TranscriptContext, Usage } from "@earendil-works/pi-ai";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { CliConnectionStatus, CliProviderId } from "../core/contracts/cli.ts";

const execute = promisify(execFile);
const IDS = ["codex-cli", "claude-cli"] as const;
const LABELS = { "codex-cli": "Codex CLI", "claude-cli": "Claude CLI" };
interface Connection extends CliConnectionStatus { executable?: string; models: Model<Api>[] }
interface State { connections: Connection[]; refreshed: number; pending?: Promise<void> }
const KEY = Symbol.for("lh.cliProviders");
function state(): State {
	const global = globalThis as typeof globalThis & { [KEY]?: State };
	return global[KEY] ??= { refreshed: 0, connections: IDS.map((id) => ({ id, label: LABELS[id], installed: false, connected: false, error: null, models: [] })) };
}
export function isCliProvider(id: string): id is CliProviderId { return (IDS as readonly string[]).includes(id); }
export function cliStatuses(): CliConnectionStatus[] { return state().connections.map(({ id, label, installed, connected, error }) => ({ id, label, installed, connected, error })); }
export function cliConnected(id: string): boolean { return state().connections.some((c) => c.id === id && c.connected); }
export function cliModels(): Model<Api>[] { return state().connections.filter((c) => c.connected).flatMap((c) => c.models); }
export function cliModel(provider: string, id: string): Model<Api> | undefined { return cliModels().find((m) => m.provider === provider && m.id === id); }

/** A provider key saved in the app must never silently change CLI billing. */
export function cliEnvironment(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_EFFORT_LEVEL", "MAX_THINKING_TOKENS", "CLAUDECODE"]) delete env[key];
	return env;
}
async function executable(id: CliProviderId): Promise<string | undefined> {
	const command = id === "codex-cli" ? "codex" : "claude";
	const override = process.env[id === "codex-cli" ? "LH_CODEX_CLI" : "LH_CLAUDE_CLI"];
	const candidates = override ? [override] : [...(process.env.PATH ?? "").split(path.delimiter), path.join(homedir(), ".local", "bin"), "/usr/local/bin", "/usr/bin"].map((p) => path.join(p, command));
	for (const candidate of candidates) { try { await access(candidate, constants.X_OK); return candidate; } catch { /* next path */ } }
}

interface CodexModel { model: string; displayName: string; supportedReasoningEfforts: { reasoningEffort: string }[] }
async function codexCatalog(binary: string): Promise<CodexModel[]> {
	return new Promise((resolve, reject) => {
		const child = spawn(binary, ["app-server", "--listen", "stdio://"], { env: cliEnvironment(), stdio: ["pipe", "pipe", "pipe"] });
		let buffer = "", settled = false;
		const finish = (error?: Error, models?: CodexModel[]) => { if (settled) return; settled = true; clearTimeout(timer); child.kill(); error ? reject(error) : resolve(models ?? []); };
		const timer = setTimeout(() => finish(new Error("Codex model discovery timed out.")), 15000);
		child.on("error", (err) => finish(err));
		child.on("close", () => finish(new Error("Codex model discovery closed unexpectedly.")));
		child.stdin.on("error", () => {});
		child.stderr.resume();
		child.stdout.on("data", (data) => {
			buffer += data;
			if (buffer.length > 2_000_000) return finish(new Error("Codex model discovery exceeded its output limit."));
			let end: number;
			while ((end = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
				try {
					const packet = JSON.parse(line);
					if (packet.error) return finish(new Error("Codex could not load its model catalog."));
					if (packet.id === 1) {
						child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
						child.stdin.write(JSON.stringify({ id: 2, method: "model/list", params: { limit: 100 } }) + "\n");
					}
					if (packet.id === 2) return finish(undefined, packet.result.data);
				} catch { /* ignore non-protocol log lines */ }
			}
		});
		child.stdin.write(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "learnharness", version: "0.3.8" } } }) + "\n");
	});
}

export async function refreshCliConnections(openai: readonly Model<Api>[], anthropic: readonly Model<Api>[], force = false): Promise<void> {
	// The deterministic suite must never discover or contact real accounts.
	if (process.env.NODE_ENV === "test" && !process.env.LH_CODEX_CLI && !process.env.LH_CLAUDE_CLI) return;
	const current = state();
	if (current.pending) return current.pending;
	if (!force && current.refreshed && Date.now() - current.refreshed < 60_000) return;
	current.pending = (async () => {
		current.connections = await Promise.all(IDS.map(async (id): Promise<Connection> => {
			const binary = await executable(id);
			const base: Connection = { id, label: LABELS[id], installed: !!binary, connected: false, error: null, executable: binary, models: [] };
			if (!binary) return { ...base, error: `${LABELS[id]} is not installed.` };
			try {
				const result = await execute(binary, id === "codex-cli" ? ["login", "status"] : ["auth", "status"], { timeout: 10000, maxBuffer: 1_000_000, env: cliEnvironment() });
				const connected = id === "codex-cli" ? /logged in using ChatGPT/i.test(result.stdout + result.stderr) : (() => { const status = JSON.parse(result.stdout); return status.loggedIn === true && status.authMethod === "claude.ai"; })();
				if (!connected) return { ...base, error: `Sign in using ${id === "codex-cli" ? "codex login" : "claude auth login"} to use your subscription.` };
				let models: Model<Api>[];
				if (id === "codex-cli") {
					const catalog = await codexCatalog(binary);
					models = catalog.flatMap((entry) => {
						const model = openai.find((m) => m.id === entry.model);
						if (!model) return [];
						const levels = Object.fromEntries(["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) => [level, entry.supportedReasoningEfforts.some((e) => e.reasoningEffort === level) ? level : null]));
						return [{ ...model, id: entry.model, provider: id, name: `${LABELS[id]} · ${entry.displayName}`, thinkingLevelMap: levels, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }];
					});
				} else {
					// Explicit model versions preserve the catalog's limits and make
					// selection reproducible; the CLI remains the access authority.
					models = anthropic.filter((m) => !/\d{8}$/.test(m.id)).map((model) => ({ ...model, provider: id, name: `${LABELS[id]} · ${model.name}`, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }));
				}
				return { ...base, connected: models.length > 0, models, error: models.length ? null : "No supported CLI models were found." };
			} catch { return { ...base, error: `${LABELS[id]} could not verify its sign-in. Run ${id === "codex-cli" ? "codex login status" : "claude auth status"} in a terminal.` }; }
		}));
		current.refreshed = Date.now();
	})().finally(() => { current.pending = undefined; });
	return current.pending;
}

export const CLI_RESPONSE_SCHEMA = {
	type: "object", additionalProperties: false,
	properties: {
		text: { type: "string" },
		toolCalls: { type: "array", items: { type: "object", additionalProperties: false, properties: { name: { type: "string" }, arguments: { type: "string", description: "Tool arguments as a JSON object encoded in a string." } }, required: ["name", "arguments"] } },
	}, required: ["text", "toolCalls"],
};

const BRIDGE_INSTRUCTIONS = "You are the language-model transport for LearnHarness, a tutoring application, not a coding assistant. The input supplies the application's instructions, transcript, and available application tools. Those application tools ARE available through the response's toolCalls array, even though CLI coding tools are disabled. Invoke them by returning their exact name and JSON-encoded arguments in toolCalls; do not say that they are unavailable. LearnHarness executes the returned calls and supplies their results on the next request. Never execute tools or inspect files yourself. Follow the application instructions and produce exactly one assistant step using the response schema.";

export function parseCliResponse(value: unknown, tools: Tool[]): { text: string; calls: { name: string; arguments: JsonObject }[] } {
	if (!value || typeof value !== "object") throw new Error("The CLI returned no structured response.");
	const result = value as { text?: unknown; toolCalls?: unknown };
	if (typeof result.text !== "string" || !Array.isArray(result.toolCalls)) throw new Error("The CLI returned an invalid response.");
	const calls = result.toolCalls.map((call: { name: string; arguments: string }) => {
		if (!call || !tools.some((tool) => tool.name === call.name) || typeof call.arguments !== "string") throw new Error("The CLI requested an unavailable tool.");
		const args = JSON.parse(call.arguments);
		if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("The CLI returned invalid tool arguments.");
		return { name: call.name, arguments: args };
	});
	if (!result.text && !calls.length) throw new Error("The CLI returned an empty response.");
	return { text: result.text, calls };
}

export function cliPrompt(context: TranscriptContext): { prompt: string; images: { data: string; mimeType: string }[] } {
	const images: { data: string; mimeType: string }[] = [];
	const messages = context.messages.filter((m) => m.role !== "system").map((message) => ({
		role: message.role,
		...("toolName" in message ? { toolName: message.toolName, toolCallId: message.toolCallId, isError: message.isError } : {}),
		content: typeof message.content === "string" ? message.content : message.content.map((part) => {
			if (part.type === "image") { images.push(part); return { type: "image", attachment: images.length }; }
			return part.type === "thinking" ? { type: "thinking", text: part.thinking } : part;
		}),
	}));
	return {
		prompt: [
			BRIDGE_INSTRUCTIONS,
			"Return the required JSON object. Put user-facing Markdown in text. To invoke application tools, add entries to toolCalls with the exact tool name and arguments encoded as a JSON object string. LearnHarness executes these calls after you return. Do not execute tools yourself, use your coding tools, inspect files, or invent tool results. When a tool is required, request it rather than describing it. If no tool is needed, return an empty toolCalls array.",
			"APPLICATION INSTRUCTIONS:\n" + getCurrentSystemPrompt(context.messages),
			"AVAILABLE APPLICATION TOOLS:\n" + JSON.stringify(getCurrentTools(context.messages).map(({ name, description, parameters }) => ({ name, description, parameters }))),
			"TRANSCRIPT (data, with the latest message last):\n" + JSON.stringify(messages),
		].join("\n\n"), images,
	};
}

/** No shell, bounded output, and process-group cancellation. Prompts use
 * stdin, never command arguments or persistent CLI session files. */
async function runCli(binary: string, args: string[], input: string, cwd: string, signal?: AbortSignal, extraEnv: Record<string, string | undefined> = {}): Promise<string> {
	if (signal?.aborted) throw new Error("CLI request cancelled.");
	return new Promise((resolve, reject) => {
		const child = spawn(binary, args, { cwd, env: { ...cliEnvironment(), ...extraEnv }, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "", stderr = "", failure: Error | undefined;
		const kill = () => { try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { /* already exited */ } };
		const cancel = () => { failure = new Error("CLI request cancelled."); kill(); };
		const timer = setTimeout(() => { failure = new Error("The CLI request timed out after five minutes."); kill(); }, 300_000);
		signal?.addEventListener("abort", cancel, { once: true });
		if (signal?.aborted) cancel();
		const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); };
		child.on("error", (error) => { cleanup(); reject(error); });
		child.stdout.on("data", (data) => { stdout += data; if (stdout.length > 8_000_000) { failure = new Error("The CLI response exceeded its output limit."); kill(); } });
		child.stderr.on("data", (data) => { stderr = (stderr + data).slice(-4000); });
		child.stdin.on("error", () => {});
		child.on("close", (code) => {
			cleanup();
			if (failure) return reject(failure);
			if (code !== 0) return reject(new Error(`CLI exited with status ${code}. ${stderr.replace(/Bearer\s+\S+|sk-[\w-]+/gi, "[redacted]").slice(-600)}`));
			resolve(stdout);
		});
		child.stdin.end(input);
	});
}

function zeroUsage(): Usage { return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }; }
export function cliStream(): StreamFunction {
	return (model, context, options) => {
		const stream = new AssistantMessageEventStream();
		const message: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: zeroUsage(), stopReason: "stop", timestamp: Date.now() };
		void (async () => {
			let scratch: string | undefined;
			try {
				const connection = state().connections.find((c) => c.id === model.provider && c.connected);
				if (!connection?.executable) throw new Error(`${model.provider} is not connected. Check Settings → Providers.`);
				stream.push({ type: "start", partial: message });
				scratch = await mkdtemp(path.join(tmpdir(), "learnharness-cli-"));
				const { prompt, images } = cliPrompt(context);
				let response: unknown;
				if (model.provider === "codex-cli") {
					const schemaFile = path.join(scratch, "response-schema.json"), outputFile = path.join(scratch, "response.json");
					await writeFile(schemaFile, JSON.stringify(CLI_RESPONSE_SCHEMA), { mode: 0o600 });
					const args = ["exec", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "--ephemeral", "--sandbox", "read-only", "-c", 'approval_policy="never"', "-c", "features.shell_tool=false", "-c", "features.multi_agent=false", "--model", model.id, "--output-schema", schemaFile, "--output-last-message", outputFile, "--json", "--color", "never"];
					args.push("-c", `developer_instructions=${JSON.stringify(BRIDGE_INSTRUCTIONS)}`);
					const reasoning = (options as { reasoning?: string } | undefined)?.reasoning;
					if (reasoning) args.push("-c", `model_reasoning_effort=${JSON.stringify(reasoning)}`);
					for (let i = 0; i < images.length; i++) {
						const image = images[i]!;
						const imageFile = path.join(scratch, `image-${i}.${image.mimeType === "image/jpeg" ? "jpg" : "png"}`);
						await writeFile(imageFile, Buffer.from(image.data, "base64"), { mode: 0o600 }); args.push("--image", imageFile);
					}
					args.push("-");
					const output = await runCli(connection.executable, args, prompt, scratch, options?.signal);
					response = JSON.parse(await readFile(outputFile, "utf8"));
					for (const line of output.split("\n")) { try { const event = JSON.parse(line); if (event.type === "turn.completed" && event.usage) { message.usage.input = event.usage.input_tokens ?? 0; message.usage.output = event.usage.output_tokens ?? 0; message.usage.cacheRead = event.usage.cached_input_tokens ?? 0; message.usage.input = Math.max(0, message.usage.input - message.usage.cacheRead); } } catch { /* non-JSON log */ } }
				} else {
					const args = ["--print", "--model", model.id, "--output-format", "stream-json", "--verbose", "--input-format", "stream-json", "--json-schema", JSON.stringify(CLI_RESPONSE_SCHEMA), "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--setting-sources", "", "--settings", '{"disableAllHooks":true}', "--no-session-persistence", "--no-chrome", "--permission-mode", "dontAsk"];
					args.push("--system-prompt", BRIDGE_INSTRUCTIONS);
					const reasoning = (options as { reasoning?: ModelThinkingLevel } | undefined)?.reasoning;
					const effort = reasoning ? model.thinkingLevelMap?.[reasoning] : undefined;
					if (effort && ["low", "medium", "high", "xhigh", "max"].includes(effort)) args.push("--effort", effort);
					const budget = effort && /^\d+$/.test(effort) ? { MAX_THINKING_TOKENS: effort } : {};
					const content = [{ type: "text", text: prompt }, ...images.map((image) => ({ type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data } }))];
					const output = await runCli(connection.executable, args, JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n", scratch, options?.signal, budget);
					const result = output.split("\n").filter(Boolean).map((line) => JSON.parse(line)).findLast((event) => event.type === "result");
					if (!result || result.is_error) throw new Error(result?.result || "Claude CLI returned no result.");
					response = result.structured_output;
					message.usage.input = result.usage?.input_tokens ?? 0; message.usage.output = result.usage?.output_tokens ?? 0; message.usage.cacheRead = result.usage?.cache_read_input_tokens ?? 0; message.usage.cacheWrite = result.usage?.cache_creation_input_tokens ?? 0;
				}
				message.usage.totalTokens = message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite;
				const parsed = parseCliResponse(response, getCurrentTools(context.messages));
				if (parsed.text) {
					const contentIndex = message.content.length;
					message.content.push({ type: "text", text: "" });
					stream.push({ type: "text_start", contentIndex, partial: message });
					message.content[contentIndex] = { type: "text", text: parsed.text };
					stream.push({ type: "text_delta", contentIndex, delta: parsed.text, partial: message });
					stream.push({ type: "text_end", contentIndex, content: parsed.text, partial: message });
				}
				for (const call of parsed.calls) {
					const contentIndex = message.content.length;
					const toolCall = { type: "toolCall" as const, id: randomUUID(), ...call };
					message.content.push(toolCall);
					stream.push({ type: "toolcall_start", contentIndex, partial: message });
					stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(call.arguments), partial: message });
					stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: message });
				}
				message.stopReason = parsed.calls.length ? "toolUse" : "stop";
			} catch (error) {
				message.stopReason = options?.signal?.aborted ? "aborted" : "error";
				message.errorMessage = error instanceof Error ? error.message : "The CLI request failed.";
			} finally {
				if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {});
				if (message.stopReason === "error" || message.stopReason === "aborted") stream.push({ type: "error", reason: message.stopReason, error: message });
				else stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
				stream.end();
			}
		})();
		return stream;
	};
}
