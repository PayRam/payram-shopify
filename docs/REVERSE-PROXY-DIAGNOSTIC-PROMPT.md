# Reverse-proxy diagnostic prompt

Give this to a merchant whose connector URLs return 404, or who needs to put the connector
behind a hostname on a server that already runs PayRam. They paste the whole thing into
ChatGPT (or any assistant) and follow it.

It is written **discovery-first on purpose**: the assistant is forbidden from proposing any
change until it has run every command and printed an inventory. The 404 this was written
for was misdiagnosed twice by assuming a topology the server did not have.

---

## Short version — for Telegram, WhatsApp or any chat

Plain text, no markdown, split to clear Telegram's 4096-character limit. Send part 1,
then part 2; the handoff line stops the assistant answering before it has the whole
brief. Sending it as a .txt attachment instead works too and avoids the split.

It keeps the discovery-first contract: no advice until a read-only inventory is printed
and confirmed.

### Part 1 of 2

```text
I need to expose a self-hosted PayRam Shopify connector on its own hostname. This is a LIVE crypto payments server - a bad restart loses money.

RULES
1. No fix, config or recommendation until you finish Phase 1 and print Phase 2. Refuse if I try to skip ahead.
2. Phase 1 is read-only: no installs, restarts or writes. Assume nothing exists - if an output is missing or unclear, ask me for that exact thing instead of inferring it.
3. Before anything that restarts the payram container, make me back up its config and confirm I saved it.

MY SETUP (established - do not re-derive)
- Container "payram" publishes 80, 443, 8443: a bundled nginx plus a backend on :8080 and a dashboard on :3000.
- Container "payram-shopify-connector" publishes 2798. This is what needs a public HTTPS hostname.
- PayRam's nginx is a CATCH-ALL (listen default_server, server_name _, no conf.d include), so it answers for EVERY hostname and my new subdomain gets served the dashboard - the 404 I see is the dashboard's, not the connector's. That config is baked into the image and wiped on every PayRam upgrade, so there is nowhere inside it to add a vhost.
- Certs come from SSL_CERT_PATH (usually /etc/letsencrypt/live/DOMAIN) bind-mounted from the host, so certbot runs on the HOST.
- PayRam's apex sends HSTS includeSubDomains, so the connector hostname must be HTTPS on 443. A non-standard port will not work either (Shopify embedded admin).
- A 302 to /app on port 2798 means the connector is HEALTHY. Older builds have no /healthz.

TARGET: one process owns 80/443 and routes by Host; each hostname reaches the right app; certs renew unattended; routing survives a PayRam upgrade; 2798 not public.

PHASE 1 - give me ONE read-only copy-paste block, then STOP and wait. Have me redact secret values, keeping their names. Cover: listening sockets with owning process; docker ps with ports; full docker inspect of BOTH containers (env names, mounts, networks, restart policy); whether nginx, caddy, traefik, haproxy and cloudflared exist as binaries, systemd units AND config dirs, reporting each present or absent and never assuming; curl against 127.0.0.1:2798; docker networks and the docker0 bridge IP; certbot certificates with SANs and renewal timer; connector logs; curl -sI both hostnames from outside.

Also ask me: which hostname I want for the connector, what it resolves to, who runs my DNS (if Cloudflare, proxied or DNS-only), and HOW I got my current certificate - certbot standalone needs port 80, which payram owns, so that decides which renewal method can keep working.

(PART 2 of 2 follows in my next message. Wait for it, then begin Phase 1. Do not reply to this message yet.)
```

### Part 2 of 2

```text
PART 2 of 2 - continuing the same task.

PHASE 2 - list what you OBSERVED, one line each: fact, value, which command proved it, confirmed or unknown. Never infer. Then the gap against TARGET, the root cause in one sentence, open questions, and the specific risks of restarting payram. Ask me to confirm before continuing.

PHASE 3 - at least 3 options. For each: how it works, whether payram must restart, downtime, how certs renew afterwards, what breaks on a PayRam upgrade, main failure mode. Cover at least (a) a containerised proxy (Caddy/nginx/Traefik) on 80/443 with both apps on a shared Docker network and no published ports; (b) a host proxy, Caddy simplest as it gets certs automatically; (c) a Cloudflare Tunnel for the connector hostname only, to http://localhost:2798 - no host ports and payram untouched, but my DNS must be on Cloudflare. Then recommend ONE: I will not run a second proxy fighting PayRam for ports, and I cannot afford a long gateway outage.

DO NOT recommend editing nginx inside the payram container (wiped on upgrade), or path-prefix routing like /shopify/ - the connector serves absolute paths /app, /pay/..., /auth, /api/payram/... with no base-path setting.

PHASE 4 - runbook: backup and rollback FIRST, with the exact command that captures payram's full config. Then each change as a block with expected output; validate config before reloading, never reload first; say how long PayRam will be down; cert issuance plus a renewal dry-run; verify the two hostnames serve DIFFERENT apps and 2798 is not publicly reachable; confirm SHOPIFY_APP_URL matches the connector hostname and PayRam's webhook points at https://CONNECTOR-HOST/api/payram/webhook.

If it still 404s, the catch-all is still winning. If it 502s, routing is right but the upstream is wrong: inside a container 127.0.0.1 is that container itself, so the proxy must use the docker bridge gateway 172.17.0.1 or the container name on a shared network.

Start with Phase 1 only. No fixes in your first reply.
```

---

## Copy everything below this line

---

You are helping me put a self-hosted **PayRam Shopify connector** behind a public hostname
on my own Linux server. This is a **live crypto payments server**. A wrong restart can take
my payment gateway offline and lose money, so you will work in a strict order.

### Your operating rules — follow these exactly

1. **Discovery before advice.** Do not propose, recommend, or hint at any fix, config file,
   or command that changes anything until you have completed Phase 1 and printed the
   inventory in Phase 2. If I ask you to skip ahead, refuse once and explain why.
2. **One block at a time.** Give me Phase 1 as a single copy-paste block. Wait for my
   output. Do not continue until I paste it.
3. **Read-only in Phase 1.** Every command must be non-destructive — no restarts, no
   installs, no file writes, no `docker stop`, no `certbot` runs.
4. **Never guess my topology.** If an output is missing, truncated, or ambiguous, ask me
   for that specific thing before continuing. Do not infer that a file or service exists
   because it usually does.
5. **State facts with their evidence.** When you conclude something, name the command
   output that proves it. If you cannot prove it, say "unverified" and ask.
6. **Protect the gateway.** Before any step that restarts or re-creates the `payram`
   container, you must first make me capture its full existing configuration and confirm
   I have it saved. A container re-created without its original environment variables and
   volume mounts can break the payments gateway permanently.
7. **No fees, no pricing.** Never discuss PayRam pricing or fees. Not relevant and not
   your information.

---

### Background you may rely on

My server runs **two Docker containers**:

| Container | Ports (host:container) | What it is |
|---|---|---|
| `payram` | `80:80`, `443:443`, `8443:8443` | The PayRam gateway: a bundled **nginx** plus a Go backend on loopback `:8080` and a Next.js dashboard on loopback `:3000`. |
| `payram-shopify-connector` | `2798:2798` | The Shopify connector (a Remix app). Shopify and buyers must reach this over HTTPS. |

Two facts about PayRam's bundled nginx that are **already established** — do not re-derive
them, and do not suggest editing this config as a first resort:

- Its server blocks are all `listen ... default_server;` with `server_name _;` — a
  deliberate **catch-all**. It answers **every** hostname sent to the server, including any
  new subdomain I create.
- It has **no `conf.d/` or `sites-enabled/` include**. There is no supported extension point
  inside that container for an extra virtual host. Its config is baked into the image and is
  **replaced on every PayRam upgrade**.

The consequence, and the reason I am here: because PayRam's nginx is a catch-all on 80/443,
a new subdomain pointed at this server is served **by the PayRam dashboard**, not by the
connector. Every connector URL then returns the *dashboard's* 404. A 404 means the request
never reached the connector; a **502** would mean routing is correct and the connector is
down.

TLS today: PayRam's `startup.sh` enables HTTPS when `SSL_CERT_PATH` is set and
`fullchain.pem` + `privkey.pem` exist there — typically
`/etc/letsencrypt/live/<domain>`, with the host's `/etc/letsencrypt` bind-mounted into the
container. So **certbot runs on the host**, and whatever renewal mechanism exists must keep
working after any change.

---

### The target topology (what "correct" looks like)

Exactly **one** process owns ports 80 and 443 and routes by hostname:

```
            Internet
                │
        :80 / :443  ──────────────  ONE front door (routes by Host header)
                │                   terminates TLS for BOTH hostnames
       ┌────────┴────────┐
       │                 │
  pay.example.com   shopify.example.com
       │                 │
  PayRam container   Connector container
  (loopback only)    127.0.0.1:2798
```

Requirements the final design must satisfy:

- **R1.** Each hostname reaches the right application. No catch-all answering for a
  hostname it does not own.
- **R2.** The connector is reachable over **HTTPS on port 443** at its own hostname, with a
  valid certificate. It cannot be HTTP-only: PayRam's apex sends
  `Strict-Transport-Security: max-age=31536000; includeSubDomains`, so browsers force HTTPS
  on every subdomain. A non-standard port is also not acceptable — Shopify's embedded admin
  and buyer redirects need a clean `https://host/path`.
- **R3.** Certificate renewal keeps working unattended for both hostnames, and renewed
  certs reach whichever process serves them.
- **R4.** Surviving a PayRam upgrade. Anything written inside the `payram` image is lost
  when it is replaced, so the routing must not live there.
- **R5.** The connector's port 2798 must not be publicly exposed once a front door exists.
- **R6.** No two processes bound to the same port.

---

## Phase 1 — Discovery (run everything, change nothing)

Give me this as one block to paste into my shell, then **stop and wait** for my output.
Tell me to redact nothing except secrets, and warn me that `docker inspect` output contains
environment variables that may include API keys — I should replace values with `REDACTED`
but keep the variable **names**.

Collect at least:

**Host and DNS**
- OS and version; whether this is a VPS and its public IP.
- Which hostnames I intend to use, and what each currently resolves to.
- Whether DNS is managed by Cloudflare (and if so, whether records are proxied or
  DNS-only), or by another provider.

**What owns the ports**
- Every listening socket with the owning process (`ss -tlnp`).
- All containers with their port mappings (`docker ps`).
- Whether anything on the host is bound to 80 or 443 outside Docker.

**Is there any proxy on the host already?**
- Whether nginx, apache2, caddy, traefik, haproxy or cloudflared exist as host packages or
  services — installed, enabled, running, or absent. Check binaries **and** systemd units
  **and** config directories, and report each as present or absent rather than assuming.

**The PayRam container (critical — this is the live gateway)**
- Its full `docker inspect`: image and tag, restart policy, **every** volume mount, **every**
  environment variable name, the network it is on, and its container IP.
- Specifically whether `SSL_CERT_PATH` is set and what it points to.
- Which nginx config it ended up using — the startup log line says either
  `SSL certs found at ... — enabling HTTPS in nginx` or an HTTP-only fallback message.

**The connector container**
- Its full `docker inspect`: image **digest**, env variable names, `SHOPIFY_APP_URL`,
  volumes, network, container IP.
- Proof it is alive from the host. On current builds:
  `curl -s http://127.0.0.1:2798/healthz` returns
  `{"app":"payram-shopify-connector","ok":true}`.
  On older builds that route does not exist, so use
  `curl -i http://127.0.0.1:2798/` and expect **`302` with `Location: /app`** — that is a
  healthy connector, not an error.
- Its recent logs.

**Docker networking**
- The networks each container is attached to, and whether they share one.
- The docker bridge gateway address (usually `172.17.0.1`) — a container reaching a
  **host** port needs this, not `127.0.0.1`, because loopback inside a container is the
  container itself. This is a common cause of a proxy config that looks right and still
  fails.

**Certificates**
- What certificates exist on the host, which hostnames each covers (SANs), and expiry.
- Whether certbot is installed, how it was run (standalone, webroot, DNS, or nginx plugin),
  and whether a renewal timer or cron entry exists and is active.
- **Ask me how I obtained the existing certificate**, since certbot's standalone mode needs
  port 80 and the PayRam container currently owns it. The answer changes which renewal
  method can keep working.

**External reality check**
- What each hostname actually returns from outside, including response headers. A
  `x-powered-by: Next.js` header or a `<title>Payram</title>` means the PayRam dashboard
  answered.
- Whether both hostnames return byte-identical bodies — if they do, one catch-all is
  serving both.

Prefix each command's output clearly so nothing is ambiguous when I paste it back.

---

## Phase 2 — Inventory (print this before any advice)

Once I paste the output, print a table of **what you actually observed**, one row per item,
each marked `confirmed` or `unknown` — never inferred:

| # | Fact | Value observed | Evidence (which command) | Status |
|---|---|---|---|---|

Then list, explicitly:

- **Open questions** — anything you still need from me, as direct questions.
- **Risks specific to my setup** — in particular anything that makes restarting the
  `payram` container dangerous (undocumented env vars, bind mounts, no restart policy).

Ask me to confirm the inventory is correct before you continue. If I have no corrections,
say so and move to Phase 3.

---

## Phase 3 — Gap analysis against the target

Compare my observed setup to **R1–R6** above. For each requirement: met, or not met and why,
citing the evidence. Make the root cause explicit in one sentence.

---

## Phase 4 — Options, with honest trade-offs

Present **at least three** viable designs that satisfy R1–R6. For each give: how it works,
what must change, whether the `payram` container must be restarted, downtime, how certs and
renewal work afterwards, what breaks on a PayRam upgrade, and the main failure mode.

Cover at minimum:

- **A front door on the host** (nginx or Caddy on 80/443), with the PayRam container
  remapped to loopback-only high ports and the connector likewise. Note that Caddy
  automates certificates for both hostnames, and that this requires re-creating the
  `payram` container with changed port mappings.
- **A containerised front door** (nginx, Caddy or Traefik as a container on 80/443, with
  both app containers on a shared Docker network and no published ports). Routing lives in
  my own config, so it survives PayRam upgrades.
- **A tunnel for the connector hostname only** (for example Cloudflare Tunnel to
  `http://localhost:2798`), which needs no host ports and leaves the PayRam container
  completely untouched — but requires my DNS to be on that provider, so check what Phase 1
  found before recommending it.

Then **recommend one**, with your reasoning tied to my constraints: I do not want a second
proxy fighting PayRam for ports, and I cannot afford an extended gateway outage.

Do **not** recommend editing nginx config inside the `payram` container as the primary fix —
it is overwritten on every upgrade (R4). You may mention it only as an explicitly temporary
measure, clearly labelled.

Do **not** recommend path-prefix routing (serving the connector under something like
`/shopify/` on the PayRam hostname). The connector serves absolute paths (`/app`, `/pay/...`,
`/auth`, `/api/payram/...`) and has no base-path setting, so it would break.

---

## Phase 5 — Implementation plan

For the option I choose, give me a numbered runbook with:

1. **A rollback plan first**, including the exact command that captures the current `payram`
   container's full configuration so it can be re-created identically. Have me save it and
   confirm, before anything is changed.
2. Each change as a copy-paste block, with the expected output after each step.
3. A config validation step before any reload (for example `nginx -t`), never reload-first.
4. The order of operations that minimises gateway downtime, and an explicit statement of how
   long PayRam will be unreachable.
5. Certificate issuance and the renewal mechanism, including a dry-run renewal test.
6. **Verification** — the exact commands and expected responses:
   - `curl -i https://<payram-host>/` → the PayRam dashboard
   - `curl -i https://<connector-host>/healthz` →
     `{"app":"payram-shopify-connector","ok":true}` on current builds, or `302` to `/app` on
     older ones
   - Confirmation that port 2798 is no longer reachable from the internet
   - Both hostnames returning **different** bodies
7. What to re-check in Shopify afterwards: that `SHOPIFY_APP_URL` matches the connector
   hostname exactly, and that the PayRam webhook points at
   `https://<connector-host>/api/payram/webhook`.

---

## Phase 6 — If it still fails

Give me a symptom table for what I might see after the change:

| Symptom | What it means | Next command to run |
|---|---|---|

Include at least: a 404 at the connector hostname (still being served by the catch-all); a
502 (routing correct, upstream unreachable — check whether the proxy is using
`127.0.0.1:2798` from inside a container, where it must instead use the bridge gateway or the
container name on a shared network); a TLS name mismatch; a redirect loop from
`X-Forwarded-Proto` not being passed; and Shopify refusing to load the embedded app because
`SHOPIFY_APP_URL` does not match the hostname.

**Begin with Phase 1 only.** Do not include any fix, config snippet, or recommendation in
your first reply.
