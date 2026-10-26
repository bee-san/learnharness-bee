# /// script
# requires-python = ">=3.11,<3.14"
# dependencies = ["faster-whisper==1.2.1"]
# ///
"""Loopback-only, memory-only dictation service for LearnHarness.

Start: uv run --python 3.12 scripts/local-whisper.py
First-time model download: add --download-model (subsequent runs are offline).
"""
import argparse
import io
import json
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_AUDIO_BYTES = 32 * 1024 * 1024
BRITISH_PROMPT = (
    "British English dictation. My favourite colour; organise and analyse; "
    "the centre's programme; travelling and practising."
)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8780)
    parser.add_argument("--model", default="small")
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--download-model", action="store_true")
    args = parser.parse_args()

    from faster_whisper import WhisperModel
    import numpy as np

    model = WhisperModel(
        args.model, device="cpu", compute_type="int8", cpu_threads=args.threads,
        local_files_only=not args.download_model,
    )
    lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass  # Recordings and transcripts never enter request logs.

        def reply(self, status, body):
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            try:
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def do_GET(self):
            if self.path != "/health":
                return self.reply(404, {"message": "Not found"})
            self.reply(200, {"ready": True, "model": args.model, "device": "cpu", "language": "en", "locale": "en-GB"})

        def do_POST(self):
            if self.path != "/transcribe":
                return self.reply(404, {"message": "Not found"})
            # The app's server is the caller. Cross-origin browser pages
            # cannot opt into this private header without a CORS preflight.
            if self.headers.get("Origin") or self.headers.get("X-LearnHarness-Local-Whisper") != "1":
                return self.reply(403, {"message": "Use LearnHarness to send recordings."})
            if self.headers.get("Content-Type", "").split(";")[0] != "audio/wav":
                return self.reply(415, {"message": "A WAV recording is required."})
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                return self.reply(400, {"message": "Invalid recording length."})
            if not 44 <= length <= MAX_AUDIO_BYTES:
                return self.reply(413, {"message": "The recording is empty or too long."})
            if not lock.acquire(blocking=False):
                return self.reply(409, {"message": "Another recording is being transcribed. Please try again shortly."})
            try:
                self.connection.settimeout(30)
                audio = self.rfile.read(length)
                if len(audio) != length:
                    return self.reply(400, {"message": "The recording was incomplete."})
                try:
                    with wave.open(io.BytesIO(audio), "rb") as wav:
                        valid = wav.getnchannels() == 1 and wav.getsampwidth() == 2 and wav.getframerate() == 16000
                        if not valid or wav.getnframes() > 16000 * 15 * 60:
                            return self.reply(422, {"message": "Use mono 16 kHz PCM audio, up to 15 minutes."})
                        pcm = wav.readframes(wav.getnframes())
                        if len(pcm) != wav.getnframes() * 2:
                            return self.reply(422, {"message": "The PCM recording was incomplete."})
                except (wave.Error, EOFError):
                    return self.reply(422, {"message": "The recording is not a valid PCM WAV file."})
                segments, _ = model.transcribe(
                    np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0,
                    language="en", task="transcribe",
                    initial_prompt=BRITISH_PROMPT, beam_size=5,
                    vad_filter=True, condition_on_previous_text=False,
                )
                text = " ".join(segment.text.strip() for segment in segments if segment.text.strip())
                self.reply(200, {"text": text, "language": "en", "locale": "en-GB"})
            except Exception:
                self.reply(500, {"message": "Local Whisper could not transcribe the recording. Please try again."})
            finally:
                lock.release()

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.daemon_threads = True
    print(f"Local Whisper ready on 127.0.0.1:{args.port} (English, British spelling preferred)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
