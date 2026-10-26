export type PcmFrame = ArrayBuffer | Int16Array<ArrayBuffer>;
export const MAX_DICTATION_PCM_BYTES = 16000 * 2 * 60 * 15;

/** Preserve typed-array offsets and the final partial frame. */
export function pcmFramesToWav(frames: readonly PcmFrame[]): Blob {
	const length = frames.reduce((bytes, frame) => bytes + frame.byteLength, 0);
	const buffer = new ArrayBuffer(44 + length);
	const header = new DataView(buffer);
	const bytes = new Uint8Array(buffer);
	const tag = (offset: number, text: string) => { for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i); };
	tag(0, "RIFF"); header.setUint32(4, 36 + length, true); tag(8, "WAVE"); tag(12, "fmt ");
	header.setUint32(16, 16, true); header.setUint16(20, 1, true); header.setUint16(22, 1, true);
	header.setUint32(24, 16000, true); header.setUint32(28, 32000, true); header.setUint16(32, 2, true); header.setUint16(34, 16, true);
	tag(36, "data"); header.setUint32(40, length, true);
	let offset = 44;
	for (const frame of frames) {
		const data = ArrayBuffer.isView(frame) ? new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength) : new Uint8Array(frame);
		bytes.set(data, offset); offset += data.byteLength;
	}
	return new Blob([buffer], { type: "audio/wav" });
}
