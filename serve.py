#!/usr/bin/env python3
"""
SHIORI_app Local Static Web Server with Health Check
"""
import os
import sys
import json
import signal
import atexit
from http.server import HTTPServer, SimpleHTTPRequestHandler

ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
PORT_FILE = os.path.join(ROOT_DIR, ".shiori-server.port")
PID_FILE = os.path.join(ROOT_DIR, ".shiori-server.pid")
CONFIG_FILE = os.path.join(ROOT_DIR, "app-port.json")

def load_port_config():
    default_port = 4173
    default_host = "localhost"
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                cfg = json.load(f)
                return int(cfg.get("port", default_port)), cfg.get("host", default_host)
        except Exception:
            pass
    return default_port, default_host

def cleanup_pid_files():
    for f in (PID_FILE, PORT_FILE):
        try:
            if os.path.exists(f):
                os.remove(f)
        except Exception:
            pass

class ShioriRequestHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT_DIR, **kwargs)

    def do_GET(self):
        if self.path == "/api/health" or self.path == "/api/health/":
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            payload = {
                "app": "SHIORI",
                "status": "ok",
                "port": self.server.server_port,
                "version": "2.0.0"
            }
            self.wfile.write(json.dumps(payload).encode("utf-8"))
            return

        return super().do_GET()

    def end_headers(self):
        # Add CORS and modern web headers
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def guess_type(self, path):
        # Ensure correct MIME types for modern ES modules and manifests
        if str(path).endswith(".mjs") or str(path).endswith(".js"):
            return "application/javascript"
        if str(path).endswith(".webmanifest"):
            return "application/manifest+json"
        if str(path).endswith(".json"):
            return "application/json"
        return super().guess_type(path)

    def log_message(self, format, *args):
        # Keep logs clean; suppress standard access logs unless needed
        pass

def main():
    port, host = load_port_config()
    
    # Record PID and bound port
    pid = os.getpid()
    try:
        with open(PID_FILE, "w", encoding="utf-8") as f:
            f.write(str(pid))
        with open(PORT_FILE, "w", encoding="utf-8") as f:
            f.write(str(port))
    except Exception as e:
        print(f"Failed to write PID/port file: {e}", file=sys.stderr)

    atexit.register(cleanup_pid_files)

    def sig_handler(signum, frame):
        cleanup_pid_files()
        sys.exit(0)

    try:
        signal.signal(signal.SIGINT, sig_handler)
        signal.signal(signal.SIGTERM, sig_handler)
    except Exception:
        pass

    bind_address = "127.0.0.1" if host in ("localhost", "127.0.0.1") else host
    server = HTTPServer((bind_address, port), ShioriRequestHandler)
    print(f"SHIORI local server running at http://{host}:{port}/ (PID: {pid})")

    try:
        server.serve_forever()
    except (KeyboardInterrupt, SystemExit):
        pass
    finally:
        server.server_close()
        cleanup_pid_files()

if __name__ == "__main__":
    main()
