#!/usr/bin/env python3
"""Reference native-app login. Credentials stay in memory; --mint-key prints a key once.

Production managers should use an OAuth client library and an OS credential store.
"""
import argparse
import base64
import hashlib
import json
import secrets
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import Request, urlopen


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="https://cpchub.net")
    parser.add_argument("--client-id", required=True)
    parser.add_argument("--mint-key", action="store_true")
    parser.add_argument("--write", action="store_true", help="Request upload/edit permission")
    args = parser.parse_args()
    base = args.base_url.rstrip("/")
    parsed = urlparse(base)
    if parsed.scheme != "https" and not (parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "::1"}):
        parser.error("Use HTTPS, or a loopback HTTP URL for local development.")
    state = secrets.token_urlsafe(32)
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    callback = {}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            path = urlparse(self.path)
            params = parse_qs(path.query)
            received_state = params.get("state", [""])[0]
            if path.path != "/callback" or not secrets.compare_digest(received_state, state):
                self.send_error(400, "Invalid OAuth callback state")
                return
            callback.update(params)
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(b"You can close this tab and return to your mod manager.")

        def log_message(self, *args):
            pass  # Never log authorization codes.

    def post(path, body, bearer=None, as_json=False):
        headers = {"Content-Type": "application/json" if as_json else "application/x-www-form-urlencoded"}
        if bearer:
            headers["Authorization"] = "Bearer " + bearer
        payload = json.dumps(body).encode() if as_json else urlencode(body).encode()
        with urlopen(Request(base + path, data=payload, headers=headers), timeout=30) as result:
            return json.load(result)

    scopes = ["read"] + (["write"] if args.write else []) + (["keys:write"] if args.mint_key else [])
    with HTTPServer(("127.0.0.1", 0), Handler) as server:
        server.timeout = 1
        redirect_uri = f"http://127.0.0.1:{server.server_port}/callback"
        auth_url = base + "/o/authorize/?" + urlencode({"client_id": args.client_id, "redirect_uri": redirect_uri,
            "response_type": "code", "scope": " ".join(scopes), "state": state,
            "code_challenge": challenge, "code_challenge_method": "S256"})
        print("Opening your browser to connect to CPC Hub…")
        if not webbrowser.open(auth_url):
            raise SystemExit("Could not open the system browser. Run this example in a desktop session.")
        deadline = time.monotonic() + 180
        while not callback and time.monotonic() < deadline:
            server.handle_request()
        if not callback:
            raise SystemExit("Login timed out.")
        if "error" in callback:
            raise SystemExit("Authorization was denied or failed.")
        if callback.get("iss", [""])[0] != base:
            raise SystemExit("The authorization response came from an unexpected issuer.")
        if not callback.get("code"):
            raise SystemExit("Callback is missing an authorization code.")
        token = post("/o/token/", {"grant_type": "authorization_code", "client_id": args.client_id,
            "code": callback["code"][0], "redirect_uri": redirect_uri, "code_verifier": verifier})
    with urlopen(Request(base + "/api/v1/me/", headers={"Authorization": "Bearer " + token["access_token"]}), timeout=30) as result:
        profile = json.load(result)
    print(f"Connected as {profile['username']}.")
    if args.mint_key:
        key = post("/api/v1/keys/", {"name": "Reference mod manager", "scopes": [s for s in scopes if s != "keys:write"], "days": 90}, token["access_token"], as_json=True)
        print("Your new manager-specific API key (shown only once):")
        print(key["key"])
        print("Store it in your OS credential store. Revoke it at /account/keys/.")


if __name__ == "__main__":
    main()
