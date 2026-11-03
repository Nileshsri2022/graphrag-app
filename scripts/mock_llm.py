"""Dev-only mock OpenAI-compatible /chat/completions server (SSE).

Run:  python mock_llm.py   (listens on 127.0.0.1:9999)
Used only for local end-to-end tests of the worker's streaming path.
"""

import json
import time
from http.server import BaseHTTPRequestHandler, HTTPServer


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length) or b"{}")
        model = body.get("model", "mock")
        user = body.get("messages", [{}])[-1].get("content", "")[:120]

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()

        words = f"MOCK({model}) answer to: {user} — Top repos: awesome (★530k), awesome-nodejs (★67k), type-fest (★17k).".split(" ")
        for w in words:
            chunk = {"choices": [{"delta": {"content": w + " "}}]}
            self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
            self.wfile.flush()
            time.sleep(0.02)
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    print("mock LLM on http://127.0.0.1:9999/v1")
    HTTPServer(("127.0.0.1", 9999), Handler).serve_forever()
