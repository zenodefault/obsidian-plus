#!/usr/bin/env python3
"""End-to-end drive of the real core binary over stdio, replicating the
plugin's wire calls for the generation-only (chat model) link scenario."""
import hashlib, json, subprocess, sys, time, uuid

CORE = "/home/zenodefault/code/obsidian-plus/core/target/release/sovereign-core"
DATA_DIR = "/tmp/sv-e2e/data"
SHIM = "/home/zenodefault/code/obsidian-plus/plugin/.e2e/shim"

NOTES = {
    "Gadgets/iPhone 7.md": "# iPhone 7\n\nI bought the iPhone 7 in 2017. The battery swells and needs replacement every two years. Home button stopped working in 2024.\n",
    "Projects/Decisions.md": "# Decisions\n\nWe decided to use PostgreSQL for the storage layer.\n",
}

class Core:
    def __init__(self):
        self.p = subprocess.Popen(
            [CORE, "--data-dir", DATA_DIR],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=open("/tmp/sv-e2e/core-stderr.log", "w"), text=True)

    def call(self, method, params):
        rid = "req_" + uuid.uuid4().hex[:8]
        line = json.dumps({"id": rid, "method": method, "params": params}) + "\n"
        self.p.stdin.write(line); self.p.stdin.flush()
        deadline = time.time() + 60
        while time.time() < deadline:
            raw = self.p.stdout.readline()
            if not raw:
                raise RuntimeError("core closed stdout")
            env = json.loads(raw)
            if env.get("id") == rid:
                if "error" in env:
                    raise RuntimeError(f"{method} error: {env['error']}")
                return env["result"]
        raise TimeoutError(method)

def main():
    core = Core()
    print("health:", json.dumps(core.call("core.health", {})))

    # 1) sync two notes (the plugin's exact begin/batch/commit/note/finish flow)
    begin = core.call("vault.sync.begin", {"rebuild": True})
    batch = [{"path": p, "hash": hashlib.sha256(c.encode()).hexdigest(),
              "mtime": 1727500000, "size": len(c.encode())} for p, c in NOTES.items()]
    core.call("vault.sync.batch", {"session_id": begin["session_id"], "notes": batch})
    commit = core.call("vault.sync.commit", {"session_id": begin["session_id"]})
    for p, c in NOTES.items():
        core.call("vault.sync.note", {"session_id": begin["session_id"], "path": p,
                                      "hash": hashlib.sha256(c.encode()).hexdigest(),
                                      "mtime": 1727500000, "size": len(c.encode()), "content": c})
    finish = core.call("vault.sync.finish", {"session_id": begin["session_id"]})
    print("sync:", json.dumps({"added": commit["added"], "total": finish["total_notes"]}))

    # 2) the plugin's link call for a qwen3-only server: generation-only
    cfg = core.call("models.configure", {
        "provider": "hash",
        "generation_model_path": "qwen3:4b",
        "generation_binary_path": SHIM,
        "generation_base_url": "http://127.0.0.1:11500",
    })
    print("configure:", json.dumps(cfg))

    # 3) status reflects the generation layer honestly
    print("status:", json.dumps(core.call("models.status", {})))

    # 4) ask two questions — the exact ones that produced the 'gibberish' dump
    for q in ["where have i mentioned iphone 7", "iphone 7 battery", "what did we decide about the database"]:
        r = core.call("brain.ask", {"query": q, "limit": 6})
        print("\n=== ASK:", q)
        print("mode:", r["answer_mode"], "| confidence:", round(r["confidence"], 2))
        print("answer:", r["answer"][:400])
        print("sources:", [s["note_path"] for s in r["sources"]])

    core.p.stdin.close()
    core.p.wait(timeout=10)

if __name__ == "__main__":
    main()
