export type CliProviderId = "codex-cli" | "claude-cli";

export interface CliConnectionStatus {
	id: CliProviderId;
	label: string;
	installed: boolean;
	connected: boolean;
	error: string | null;
}
