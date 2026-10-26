import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { normalizeContext } from "@earendil-works/pi-ai";
import { piEngineForSpec, piModels } from "../src/agent/models.ts";
import { cliEnvironment, cliPrompt, cliStatuses, parseCliResponse, refreshCliConnections } from "../src/agent/cli-provider.ts";
import { subscriptionLabel } from "../src/core/prices.ts";

const tool = { name: "record_answer", description: "Record an answer", parameters: Type.Object({ answer: Type.Number() }) };

test("CLI output cannot invoke undeclared tools or use non-object arguments", () => {
	assert.throws(() => parseCliResponse({ text: "", toolCalls: [{ name: "Bash", arguments: '{}' }] }, [tool]), /unavailable tool/);
	for (const args of ["[]", "null", "bad JSON"]) assert.throws(() => parseCliResponse({ text: "", toolCalls: [{ name: tool.name, arguments: args }] }, [tool]));
	assert.throws(() => parseCliResponse({ text: "", toolCalls: [] }, [tool]), /empty response/);
	assert.deepEqual(parseCliResponse({ text: "", toolCalls: [{ name: tool.name, arguments: '{"answer":4}' }] }, [tool]).calls, [{ name: tool.name, arguments: { answer: 4 } }]);
});

test("CLI transport preserves tool results and image attachments without mutating the transcript", () => {
	const context = normalizeContext({ systemPrompt: "Teacher instructions", tools: [tool], messages: [
		{ role: "user", content: [{ type: "text", text: "Read this" }, { type: "image", mimeType: "image/png", data: "dGVzdA==" }], timestamp: 1 },
		{ role: "toolResult", toolName: tool.name, toolCallId: "call-1", content: [{ type: "text", text: "recorded: 4" }], isError: false, timestamp: 2 },
	] });
	const before = JSON.stringify(context);
	const serialized = cliPrompt(context);
	assert.match(serialized.prompt, /Teacher instructions/);
	assert.match(serialized.prompt, /recorded: 4/);
	assert.match(serialized.prompt, /call-1/);
	assert(!serialized.prompt.includes("dGVzdA=="));
	assert.equal(serialized.images[0]!.data, "dGVzdA==");
	assert.equal(JSON.stringify(context), before);
});

test("CLI connections are subscription usage, not dollar estimates", () => {
	assert.equal(subscriptionLabel("codex-cli:gpt-6.1-sol"), "Codex CLI");
	assert.equal(subscriptionLabel("claude-cli:claude-sonnet-5-5"), "Claude CLI");
});

test("both subprocess protocols preserve tool semantics; failures and aborts never fall back to API keys", async () => {
	const directory = await mkdtemp(path.join(tmpdir(), "lh-cli-test-"));
	const binary = path.join(directory, "fake-cli.cjs");
	const capture = path.join(directory, "capture.json");
	const envKeys = ["LH_CODEX_CLI", "LH_CLAUDE_CLI", "LH_CLI_TEST_CAPTURE", "LH_CLI_TEST_MODE", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"];
	const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
	await writeFile(binary, `#!/usr/bin/env node
const fs=require('node:fs');
const args=process.argv.slice(2);
if(args[0]==='login'){console.log('Logged in using ChatGPT');process.exit();}
if(args[0]==='auth'){console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai'}));process.exit();}
if(args[0]==='app-server'){
 require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const p=JSON.parse(line);if(p.id===1)console.log(JSON.stringify({id:1,result:{}}));if(p.id===2)console.log(JSON.stringify({id:2,result:{data:[{model:'gpt-6.1-sol',displayName:'Test Codex',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'medium'}]}]}}));});
}else{
 let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{
  fs.writeFileSync(process.env.LH_CLI_TEST_CAPTURE,JSON.stringify({args,input,apiKeyPresent:!!(process.env.OPENAI_API_KEY||process.env.ANTHROPIC_API_KEY),cwd:process.cwd()}));
  if(process.env.LH_CLI_TEST_MODE==='hang'){setInterval(()=>{},1000);return;}
  if(process.env.LH_CLI_TEST_MODE==='fail'){console.error('forced failure');process.exit(1);}
  const payload={text:'',toolCalls:[{name:'record_answer',arguments:'{"answer":4}'}]};
  if(args[0]==='exec'){fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify(payload));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:12,output_tokens:5,cached_input_tokens:2}}));}
  else console.log(JSON.stringify({type:'result',is_error:false,structured_output:payload,usage:{input_tokens:10,output_tokens:5}}));
 });
}
`, { mode: 0o700 });
	try {
		process.env.LH_CODEX_CLI = binary; process.env.LH_CLAUDE_CLI = binary; process.env.LH_CLI_TEST_CAPTURE = capture;
		process.env.OPENAI_API_KEY = "scratch-api-must-not-be-used"; process.env.ANTHROPIC_API_KEY = "scratch-api-must-not-be-used";
		assert.equal(cliEnvironment().OPENAI_API_KEY, undefined);
		assert.equal(cliEnvironment().ANTHROPIC_API_KEY, undefined);
		await refreshCliConnections(piModels().getModels("openai"), piModels().getModels("anthropic"), true);
		assert(cliStatuses().every((connection) => connection.connected));
		const context = normalizeContext({ tools: [tool], messages: [{ role: "user", content: "record 4", timestamp: 1 }] });
		for (const spec of [{ provider: "codex-cli", id: "gpt-6.1-sol" }, { provider: "claude-cli", id: "claude-sonnet-5-5" }]) {
			const engine = piEngineForSpec({ ...spec, thinkingLevel: spec.provider === "claude-cli" ? "xhigh" : "low" });
			const events = [];
			const stream = engine.streamFn(engine.model, context);
			for await (const event of stream) events.push(event);
			const message = await stream.result();
			assert.equal(message.stopReason, "toolUse");
			assert.equal(message.provider, spec.provider);
			assert.deepEqual(message.content[0], { type: "toolCall", id: (message.content[0] as { id: string }).id, name: tool.name, arguments: { answer: 4 } });
			assert.equal(message.usage.totalTokens, 17 - (spec.provider === "claude-cli" ? 2 : 0));
			assert(events.some((event) => event.type === "toolcall_end"));
			const captured = JSON.parse(await readFile(capture, "utf8"));
			assert.equal(captured.apiKeyPresent, false);
			if (spec.provider === "claude-cli") assert.equal(captured.args[captured.args.indexOf("--effort") + 1], "xhigh", "the app's thinking level must reach Claude CLI");
			assert.match(captured.input, /record 4/);
			assert(!captured.args.some((arg: string) => arg.includes("record 4")), "prompts must use stdin");
			await assert.rejects(readFile(path.join(captured.cwd, "response-schema.json")), { code: "ENOENT" }, "temporary request material must be removed");
			process.env.LH_CLI_TEST_MODE = "fail";
			assert.equal((await engine.streamFn(engine.model, context).result()).stopReason, "error");
			process.env.LH_CLI_TEST_MODE = "hang";
			const cancelled = await engine.streamFn(engine.model, context, { signal: AbortSignal.timeout(200) }).result();
			assert.equal(cancelled.stopReason, "aborted");
			delete process.env.LH_CLI_TEST_MODE;
		}
	} finally {
		for (const key of envKeys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
		await rm(directory, { recursive: true, force: true });
	}
});
