"""Review/apply CPC Hub's Pro zone policy through cf; keep Wrangler for Workers.

Default: read current state, save a private rollback snapshot, preview and remotely
validate every ruleset. Use --apply to install the reviewed policy. No subscription
or Worker deployment is performed. Snapshots may contain private rule expressions.
"""
import argparse
import copy
import datetime
import json
import os
import pathlib
import subprocess

from cloudflare import ROOT, ZONE, ACCOUNT, token

APP_HOSTS = '(http.host in {"cpchub.net" "www.cpchub.net"})'
HOSTS = '(http.host in {"cpchub.net" "www.cpchub.net" "screenshots.cpchub.net"})'
PHASES = (
    "http_request_firewall_custom", "http_request_firewall_managed",
    "http_ratelimit", "http_request_cache_settings",
    "http_request_dynamic_redirect",
)
RULE_FIELDS = (
    "id", "ref", "action", "action_parameters", "expression", "description",
    "enabled", "logging", "ratelimit",
)
MANAGED_ID = "efb7b8c949ac4650a09736fc376e9aee"
OWASP_ID = "4814384a9e5d4991b9815dcfc25d2f1f"
MULTIPART_UPLOAD = (
    f'{APP_HOSTS} and http.request.method eq "POST" '
    'and starts_with(lower(http.request.headers["content-type"][0]), "multipart/form-data") '
    'and (http.request.uri.path eq "/upload/" '
    'or (starts_with(http.request.uri.path, "/items/") and ends_with(http.request.uri.path, "/edit/")) '
    'or ((starts_with(http.request.uri.path, "/items/") or starts_with(http.request.uri.path, "/api/v1/items/")) '
    'and (ends_with(http.request.uri.path, "/releases/") or ends_with(http.request.uri.path, "/screenshots/"))))'
)
WORKER_CONFIG = json.loads((ROOT / "wrangler.jsonc").read_text())
RATE_BINDINGS = {binding["name"]: binding for binding in WORKER_CONFIG["ratelimits"]}


def edge_limit(kind):
    # Pro cannot validate opaque session/key/token credentials. Let the Worker
    # enforce each allowance; the edge ceiling permits both on a shared IP.
    bindings = [RATE_BINDINGS[f"{kind}_{auth}_RATE_LIMIT"] for auth in ["ANON", "AUTH"]]
    if any(binding["simple"]["period"] != 60 for binding in bindings):
        raise RuntimeError("Expected 60-second Worker rate limits")
    return sum(binding["simple"]["limit"] for binding in bindings)


def verify_worker_limits():
    def wrangler_json(*args):
        result = subprocess.run(
            ["npx", "--no-install", "wrangler", *args, "--json"], cwd=ROOT,
            env={**os.environ, "CLOUDFLARE_API_TOKEN": token(), "CLOUDFLARE_ACCOUNT_ID": ACCOUNT,
                 "WRANGLER_SEND_METRICS": "false"}, capture_output=True, text=True, check=True,
        )
        return json.loads(result.stdout)
    deployment = max(wrangler_json("deployments", "list"), key=lambda value: value["created_on"])
    for version in deployment["versions"]:
        if version["percentage"] <= 0:
            continue
        live = wrangler_json("versions", "view", version["version_id"])
        actual = {b["name"]: b for b in live["resources"]["bindings"] if b["type"] == "ratelimit"}
        for name, expected in RATE_BINDINGS.items():
            if name not in actual or any(actual[name].get(key) != expected[key] for key in ["namespace_id", "simple"]):
                raise RuntimeError("Deploy the Worker's authenticated rate-limit bindings before raising edge ceilings")


class MissingEntrypoint(RuntimeError):
    pass


def cf(*args):
    env = {**os.environ, "CLOUDFLARE_API_TOKEN": token()}
    # Account scope otherwise wins on APIs that support both accounts and zones.
    env.pop("CLOUDFLARE_ACCOUNT_ID", None)
    result = subprocess.run(
        ["cf", *args, "--zone", ZONE], cwd=ROOT, env=env,
        capture_output=True, text=True, check=False,
    )
    if result.returncode:
        if "404 Not Found" in result.stderr and "could not find entrypoint ruleset" in result.stderr:
            raise MissingEntrypoint("No entrypoint ruleset")
        # Do not echo request bodies or private rule expressions on API failure.
        raise RuntimeError(f"cf {' '.join(args[:3])} failed; inspect permissions/plan and use --dry-run")
    return json.loads(result.stdout) if result.stdout.strip() else None


def read_rules(phase):
    try:
        return cf("rulesets", "entrypoint", "get", phase)
    except MissingEntrypoint:
        return {"rules": [], "version": None}


def save(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as output:
        json.dump(value, output, indent=2)
        output.write("\n")


def writable_rules(rules):
    return [{key: copy.deepcopy(rule[key]) for key in RULE_FIELDS if key in rule} for rule in rules]


def upsert(rules, rule):
    for index, existing in enumerate(rules):
        if existing.get("ref") == rule["ref"]:
            rules[index] = {**({"id": existing["id"]} if "id" in existing else {}), **rule}
            return
    rules.append(rule)


def protect_binary_uploads(rules):
    # OWASP's text signatures score native game bytes as injection attempts.
    # Preserve its existing scope/settings elsewhere and the full Cloudflare WAF.
    # The Worker authenticates requests; cookie presence cannot establish identity.
    exclusion = f" and not ({MULTIPART_UPLOAD})"
    for rule in rules:
        if rule.get("action") == "execute" and rule.get("action_parameters", {}).get("id") == OWASP_ID:
            if rule["expression"] == "true":
                rule["expression"] = f"not ({MULTIPART_UPLOAD})"
            elif rule["expression"] not in ("false", f"not ({MULTIPART_UPLOAD})") and not rule["expression"].endswith(exclusion):
                rule["expression"] = f'({rule["expression"]}){exclusion}'


def policy(current):
    desired = {phase: writable_rules(current[phase]["rules"]) for phase in PHASES}
    custom = desired[PHASES[0]]
    for rule in custom:
        if rule.get("ref") == "cpchub_private_test_agent":
            rule.update(
                description="Private test agent: browser challenges only; retain WAF, rate limits and probe blocks",
                action_parameters={"ruleset": "current", "phases": ["http_request_sbfm"],
                                   "products": ["bic", "securityLevel"]},
            )
        elif rule.get("ref") == "cpchub_browser_bot_challenge":
            rule.update(enabled=False, description="Replaced by Pro Super Bot Fight Mode")
        elif rule.get("ref") == "cpchub_admin_challenge":
            rule["description"] = "Browser challenge on admin and login pages"

    machine_paths = ('(http.request.uri.path eq "/api" or starts_with(http.request.uri.path, "/api/") '
                     'or http.request.uri.path in {"/o/token/" "/o/revoke_token/" "/health/" '
                     '"/robots.txt" "/sitemap.xml" "/security.txt" "/.well-known/security.txt"} '
                     'or (starts_with(http.request.uri.path, "/items/") and ends_with(http.request.uri.path, "/download/")) '
                     'or (cf.client.bot and http.request.method in {"GET" "HEAD"}))')
    upsert(custom, {
        "ref": "cpchub_api_browser_exemption", "action": "skip", "enabled": True,
        "description": "API, OAuth token clients, downloads and verified bots: browser checks only",
        "expression": f"{APP_HOSTS} and {machine_paths}",
        "action_parameters": {"phases": ["http_request_sbfm"], "products": ["bic", "securityLevel"]},
        "logging": {"enabled": True},
    })
    upsert(custom, {
        "ref": "cpchub_sbfm_host_scope", "action": "skip", "enabled": True,
        "description": "Apply SBFM to the application hosts; keep R2 images and other hostnames challenge-free",
        "expression": f"not {APP_HOSTS}",
        "action_parameters": {"phases": ["http_request_sbfm"]},
        "logging": {"enabled": True},
    })
    directories = ["/.aws/", "/.config/", "/.codex/", "/.gemini/", "/.junie/", "/.ssh/", "/.vscode/", "/.cursor/"]
    paths = ["/config.json", "/api/v1/config.json", "/google-credentials.json", "/gcp-credentials.json",
             "/application_default_credentials.json", "/claude_desktop_config.json", "/cline_mcp_settings.json",
             "/vertex.json", "/credentials/config.json", "/cloud/config.json", "/s3/config.json"]
    secrets = " or ".join(f'starts_with(lower(http.request.uri.path), "{path}")' for path in directories)
    secrets += " or lower(http.request.uri.path) in {" + " ".join(json.dumps(path) for path in paths) + "}"
    upsert(custom, {
        "ref": "cpchub_secret_file_probes", "action": "block", "enabled": True,
        "description": "Block credential/config scanner paths observed in zone analytics before Worker execution",
        "expression": f"{HOSTS} and ({secrets})",
    })
    upsert(custom, {
        "ref": "cpchub_standard_ports", "action": "block", "enabled": True,
        "description": "Application and R2 hostnames only serve HTTP/HTTPS on standard ports",
        "expression": '(http.host in {"cpchub.net" "www.cpchub.net" "screenshots.cpchub.net"} '
                      'or starts_with(http.host, "cpchub.net:") or starts_with(http.host, "www.cpchub.net:") '
                      'or starts_with(http.host, "screenshots.cpchub.net:")) and not cf.edge.server_port in {80 443}',
    })
    upsert(custom, {
        "ref": "cpchub_screenshot_paths", "action": "block", "enabled": True,
        "description": "Public R2 serves only generated WebP object paths; reject scans before R2 reads",
        "expression": '(http.host eq "screenshots.cpchub.net") and not starts_with(http.request.uri.path, "/cdn-cgi/") '
                      'and not (http.request.method in {"GET" "HEAD" "OPTIONS"} '
                      'and len(http.request.uri.path) eq 59 and ends_with(http.request.uri.path, ".webp"))',
    })
    # No browser-testing exemption may bypass a known probe block. Preserve the
    # relative order and content of unrelated rules rather than recreating them.
    first = {"cpchub_block_probes", "cpchub_secret_file_probes", "cpchub_standard_ports", "cpchub_screenshot_paths"}
    desired[PHASES[0]] = [r for r in custom if r.get("ref") in first] + [r for r in custom if r.get("ref") not in first]

    managed = desired[PHASES[1]]
    protect_binary_uploads(managed)
    # The full ruleset includes the free ruleset's coverage. Deploy it only once.
    managed[:] = [r for r in managed if r.get("ref") != "cpchub_free_managed_waf"]
    existing = next((r for r in managed if r.get("action_parameters", {}).get("id") == MANAGED_ID), None)
    if existing is None or existing.get("ref") == "cpchub_managed_waf":
        upsert(managed, {
            "ref": "cpchub_managed_waf", "action": "execute", "enabled": True,
            "description": "Pro Cloudflare Managed Ruleset with Cloudflare default rule actions",
            "expression": HOSTS, "action_parameters": {"id": MANAGED_ID, "version": "latest"},
        })

    rates = desired[PHASES[2]]
    sensitive = ('(starts_with(http.request.uri.path, "/accounts/") or http.request.uri.path in '
                 '{"/upload/" "/o/token/" "/o/revoke_token/"} or '
                 '((starts_with(http.request.uri.path, "/items/") or starts_with(http.request.uri.path, "/api/v1/items/")) '
                 'and (ends_with(http.request.uri.path, "/releases/") or ends_with(http.request.uri.path, "/screenshots/") '
                 'or ends_with(http.request.uri.path, "/download/"))))')
    for ref, description, expression, limit in [
        ("cpchub_sensitive_rate_limit", "Sensitive routes: combined IP ceiling; Worker enforces anonymous/authenticated budgets", sensitive, edge_limit("SENSITIVE")),
        ("cpchub_api_rate_limit", "API: combined IP ceiling; Worker enforces anonymous/authenticated budgets",
         '(http.request.uri.path eq "/api" or starts_with(http.request.uri.path, "/api/"))', edge_limit("API")),
    ]:
        upsert(rates, {
            "ref": ref, "action": "block", "enabled": True, "description": description,
            "expression": f"{APP_HOSTS} and not cf.client.bot and {expression}",
            "action_parameters": {"response": {"status_code": 429, "content_type": "application/json",
                                               "content": '{"error":"rate_limited","retry_after":60}'}},
            "ratelimit": {"characteristics": ["cf.colo.id", "ip.src"], "period": 60,
                          "requests_per_period": limit, "mitigation_timeout": 60},
        })
    # Put the expensive-route budget first. Pro permits two rate limiting rules.
    rates.sort(key=lambda r: r.get("ref") != "cpchub_sensitive_rate_limit")
    if len(rates) > 2:
        raise RuntimeError("Existing rate rules exceed the Pro budget; refusing to overwrite unrelated rules")

    upsert(desired[PHASES[3]], {
        "ref": "cpchub_public_screenshots", "action": "set_cache_settings", "enabled": True,
        "description": "Public R2 WebP: share query variants; preserve origin freshness and browser TTL",
        "expression": '(http.host eq "screenshots.cpchub.net") and http.request.method in {"GET" "HEAD"} '
                      'and len(http.request.uri.path) eq 59 and ends_with(http.request.uri.path, ".webp")',
        "action_parameters": {"cache": True, "edge_ttl": {"mode": "bypass_by_default"},
                              "browser_ttl": {"mode": "respect_origin"},
                              "cache_key": {"custom_key": {"query_string": {"exclude": "*"}}}},
    })
    upsert(desired[PHASES[4]], {
        "ref": "cpchub_www_redirect", "action": "redirect", "enabled": True,
        "description": "Canonical www redirect at the edge; no legacy origin or Worker execution",
        "expression": '(http.host eq "www.cpchub.net")',
        "action_parameters": {"from_value": {
            "target_url": {"expression": 'concat("https://cpchub.net", http.request.uri.path)'},
            "status_code": 308, "preserve_query_string": True,
        }},
    })
    return desired


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--restore", type=pathlib.Path, help="Snapshot directory to restore (requires --apply)")
    args = parser.parse_args()
    zone = cf("zones", "get")
    if zone["id"] != ZONE or zone["name"] != "cpchub.net" or zone["plan"]["legacy_id"] != "pro":
        raise RuntimeError("Expected the cpchub.net Pro zone")
    directory = ROOT / ".wrangler" / "cloudflare-pro" / datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    directory.mkdir(parents=True, mode=0o700)
    current = {phase: read_rules(phase) for phase in PHASES}
    settings = {key: cf("zones", "settings", "get", key) for key in ["ssl", "http3"]}
    bots = cf("bot-management", "get")
    tiered = cf("cache", "settings", "smart-tiered-cache", "get")
    before = {"zone": ZONE, "rulesets": current, "settings": settings, "bots": bots, "tiered": tiered}
    save(directory / "before.json", before)
    if args.restore:
        saved = json.loads((args.restore / "before.json").read_text())
        if saved["zone"] != ZONE:
            raise RuntimeError("Snapshot belongs to another zone")
        desired = {phase: writable_rules(saved["rulesets"][phase]["rules"]) for phase in PHASES}
        setting_values = {key: value["value"] for key, value in saved["settings"].items()}
        bot_values = {key: saved["bots"][key] for key in ["sbfm_definitely_automated", "sbfm_verified_bots", "sbfm_static_resource_protection", "enable_js"]}
        tiered_value = saved["tiered"]["value"]
    else:
        desired = policy(current)
        setting_values = {"ssl": "strict", "http3": "on"}
        bot_values = {"sbfm_definitely_automated": "managed_challenge", "sbfm_verified_bots": "allow",
                      "sbfm_static_resource_protection": False, "enable_js": False}
        tiered_value = "on"

    actions = []
    for phase in PHASES:
        if writable_rules(current[phase]["rules"]) == desired[phase]:
            continue
        file = directory / f"{phase}.json"
        save(file, desired[phase])
        if current[phase]["version"] is None:
            command = ("rulesets", "create", "--kind", "zone", "--name", "CPC Hub redirects",
                       "--phase", phase, "--rules", "@" + str(file))
        else:
            command = ("rulesets", "entrypoint", "update", phase, "--rules", "@" + str(file))
        preview = cf(*command, "--dry-run")
        save(directory / f"preview-{phase}.json", preview)
        # Server-side validation checks expression syntax AND plan entitlements.
        cf(*command, "--validate-only")
        actions.append((phase, command))
        print(f"Validated {phase}: {len(desired[phase])} rules")
    for key, value in setting_values.items():
        if settings[key]["value"] != value:
            command = ("zones", "settings", "edit", key, "--body", json.dumps({"value": value}))
            cf(*command, "--dry-run")
            actions.append((key, command))
    if tiered["value"] != tiered_value:
        command = ("cache", "settings", "smart-tiered-cache", "edit", "--value", tiered_value)
        cf(*command, "--dry-run")
        actions.append(("smart-tiered-cache", command))
    # Install exceptions and managed rules before enabling zone-wide bot controls.
    if any(bots.get(key) != value for key, value in bot_values.items()):
        command = ("bot-management", "update", "--body", json.dumps(bot_values))
        cf(*command, "--dry-run")
        actions.append(("bots", command))
    save(directory / "plan.json", {"rulesets": desired, "settings": setting_values, "bots": bot_values, "tiered": tiered_value})
    print(f"Snapshot: {directory.relative_to(ROOT)}")
    print("Changes: " + (", ".join(label for label, _ in actions) or "none"))
    if not args.apply:
        print("Preview only. No settings changed.")
        return
    # Check even on a zone no-op: a separate Worker deployment may have removed
    # the application budgets while leaving these larger edge ceilings in place.
    if not args.restore:
        verify_worker_limits()
    # Refuse to replace rules edited since this run's snapshot.
    for phase in PHASES:
        if read_rules(phase)["version"] != current[phase]["version"]:
            raise RuntimeError("Concurrent zone rule change detected; rerun the preview")
    for label, command in actions:
        result = cf(*command)
        save(directory / f"applied-{label}.json", result)
        print("Applied " + label)
    print("Apply complete. Verify application responses and Security Events.")


if __name__ == "__main__":
    main()
