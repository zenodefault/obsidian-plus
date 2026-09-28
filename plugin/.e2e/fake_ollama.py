import json, re, sys
from http.server import HTTPServer, BaseHTTPRequestHandler

class H(BaseHTTPRequestHandler):
    def _send(self, obj):
        body = json.dumps(obj).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def do_GET(self):
        if self.path == "/api/tags":
            self._send({"models": [{"name": "qwen3:4b", "size": 2600000000, "families": ["qwen3"]}]})
        else:
            self.send_response(404); self.end_headers()
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        req = json.loads(self.rfile.read(n) or b"{}")
        if self.path == "/api/embed":
            texts = req.get("input") or []
            vecs = [[float((len(t) % 17) + 1) / 10.0] * 8 for t in texts]
            self._send({"embeddings": vecs})
        elif self.path == "/api/generate":
            prompt = req.get("prompt", "")
            # Cite the first evidence block exactly as a grounded model should:
            # the first [path] header in the prompt IS the top retrieved source.
            m = re.search(r"Evidence:\s*\n\s*\[([^\]\n]+)\]", prompt)
            cite = m.group(1) if m else "Unknown.md"
            self._send({"response": "Your notes mention the iPhone 7 in [" + cite + "]; you noted buying it and tracking its battery issues there."})
        else:
            self.send_response(404); self.end_headers()
    def log_message(self, *a): pass

HTTPServer(("127.0.0.1", 11500), H).serve_forever()
