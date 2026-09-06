# Deploying trade-bot with Ansible

First-deployment playbook for `apps/ui` + `apps/engine`, running exactly as
configured today — **paper/testnet, no real capital** — on a single Ubuntu/
Debian server, entirely as native system services. No containers: Node.js,
MongoDB, and Redis are all installed directly via `apt`, and the app itself
runs under `systemd`. `apps/chatops` is not deployed by this playbook.

## Before you start

**Read `strategies/btc-high-risk.md`'s "Engine port" section first** if
you're at all tempted to point this at a real Binance account. The
TypeScript port of that strategy has a known, unresolved gap against its
own backtest (63.8% match rate as of the last check) and isn't considered
safe even for aggressive testnet use yet, let alone real money. This
playbook deliberately has no variable for `BTC_HIGH_RISK_ALLOW_LIVE` —
that gate stays off on purpose.

**Ansible's control node (the machine you run `ansible-playbook` from)
must be Linux, macOS, or WSL — not native Windows.** Ansible doesn't
support running as a controller from native Windows Python (it needs
POSIX-style blocking I/O that isn't available there). If you're on
Windows, run everything below from WSL.

You'll need, on the control node:

- Ansible (`pip install ansible` — the full package, not the minimal
  `ansible-core`, since it bundles `community.general`)
- If you installed `ansible-core` only:
  `ansible-galaxy collection install community.general`
- SSH access to the target server (a key is strongly preferred over a
  password — see "SSH access" below)

And on the target server:

- Ubuntu or Debian (this playbook uses `apt`; a different distro needs
  the package-manager tasks adapted)
- nginx already installed (per the deployment request this assumes) —
  the playbook double-checks it's present regardless
- A user Ansible can SSH in as and `sudo` to root with (or root itself)
- DNS for your domain already pointing at the server, **before** you set
  `enable_https: true`

## 1. Fill in the variables

```bash
cd ansible
cp group_vars/all.yml.example group_vars/all.yml
```

Edit `group_vars/all.yml` (never commit this file — it's gitignored, and
will hold real secrets once filled in). Every field has a comment
explaining what it's for; the ones you cannot skip:

| Variable | What it is |
|---|---|
| `server_host` | The server's IP or hostname |
| `ssh_username` | The SSH user Ansible connects as |
| `domain_name` | Already set to `trade.toskas.gr` |
| `basic_auth_username` / `basic_auth_password` | The browser login prompt gating the whole dashboard |
| `engine_control_api_token` | A real random secret — generate with `openssl rand -hex 32` |

Everything Binance/Telegram-related is optional and should stay blank for
this first deployment — the engine runs correctly with none of it set.

### SSH access

Leave `ssh_private_key_file: ""` to use your default SSH agent/key. If you
need a specific key, set its path there. If the server has never seen your
key before, add it the normal way (`ssh-copy-id`, or your provider's
cloud-init/dashboard) — this playbook doesn't provision your own access to
the box, only what happens once Ansible is already able to log in.

If you truly must authenticate with an SSH **password** (not recommended —
this is separate from the web dashboard's password, which the playbook
does handle), don't put it in `all.yml`. Run with `--ask-pass` instead:

```bash
ansible-playbook -i inventory.yml playbook.yml --ask-pass --ask-become-pass
```

## 2. Run it

```bash
cd ansible
ansible-playbook -i inventory.yml playbook.yml
```

First run will take a few minutes (installing Node.js, MongoDB, Redis,
`npm install`, building the UI). Re-running is safe and idempotent —
packages already installed are skipped, config files are only rewritten
if they've actually changed, and services only restart when something
they depend on changed.

### Getting HTTPS working

Start with `enable_https: false`, run the playbook, and confirm
`http://trade.toskas.gr` loads (behind the basic-auth prompt) — this
proves DNS and the nginx vhost are correct before adding Let's Encrypt to
the mix. Then set `enable_https: true`, fill in `letsencrypt_email`, and
re-run. Certbot's nginx plugin extends the vhost with the HTTPS server
block and a redirect automatically; you don't need to touch the nginx
template yourself.

## What this deploys

- **MongoDB 7.0** and **Redis**, installed natively via `apt`, each bound
  to `127.0.0.1` only — never reachable from outside the server, with or
  without a firewall.
- **`apps/engine`**, running via `npm run start --workspace=@trade-bot/engine`
  under `systemd` (`trade-bot-engine.service`), exactly as configured
  today: `ma-cross-demo`/`ma-cross-demo-eth` on `PaperBroker`, and
  `btc-high-risk` on futures **testnet** (or `PaperBroker` if you leave
  the Binance futures keys blank — see `strategies/btc-high-risk.md`).
  Its control API stays bound to `127.0.0.1:4001`, matching how it already
  runs locally — nginx never proxies to it directly, only the UI does,
  server-side.
- **`apps/ui`**, built for production (`next build`) and run via
  `npm run start --workspace=@trade-bot/ui` under `systemd`
  (`trade-bot-ui.service`), listening on `127.0.0.1:3000`.
- **nginx**, reverse-proxying `https://trade.toskas.gr` (or `http://` until
  you enable HTTPS) to the UI, gated by HTTP basic auth on every path
  except the ACME challenge nginx needs for Let's Encrypt.
- A dedicated, unprivileged system user (`tradebot` by default) that both
  app services run as — never root.

Application code is packaged from your local working tree (excluding
`node_modules`, `.git`, build output, and this `ansible/` directory
itself) and pushed to the server on every run — there's no dependency on
a git remote existing anywhere.

## What this does NOT do

- Doesn't deploy `apps/chatops` (Telegram bot) — out of scope for this
  first deployment.
- Doesn't set up a firewall (e.g. `ufw`) — Mongo/Redis binding to
  `127.0.0.1` protects them regardless, but consider one for defense in
  depth, especially to restrict SSH.
- Doesn't rotate or manage the `engine_control_api_token`/Binance/Telegram
  secrets beyond writing them into `{{ app_dir }}/.env` (mode `0600`,
  owned by the dedicated deploy user) — treat `group_vars/all.yml` on your
  own machine as sensitive for the same reason `.env` already is.
- Doesn't touch `BTC_HIGH_RISK_ALLOW_LIVE` — deliberately not exposed as a
  variable here.

## Checking it worked

```bash
# From the server (or via SSH):
sudo systemctl status trade-bot-engine trade-bot-ui mongod redis-server
sudo journalctl -u trade-bot-engine -f     # tail engine logs
sudo journalctl -u trade-bot-ui -f         # tail UI logs
```

From a browser: `https://trade.toskas.gr` (or `http://` pre-HTTPS) should
prompt for the basic-auth username/password, then show the dashboard.

## A note on local dev, found while building this

`apps/ui` currently reads `MONGODB_URI`/`ENGINE_CONTROL_API_URL`/
`ENGINE_CONTROL_API_TOKEN` via `process.env` directly, but nothing loads
a `.env` file for it locally (unlike `apps/engine`/`apps/chatops`, which
got `--env-file-if-exists` added earlier this session) — it's only ever
worked because the hardcoded fallback defaults happen to match local dev's
actual Mongo URI and the engine's own dev-placeholder token. This
deployment isn't affected (systemd's `EnvironmentFile=` injects real
environment variables before the process starts, independent of
Next.js's own env-loading), but it's the same root cause as the bug fixed
in `apps/engine`/`apps/chatops`'s `package.json` scripts, just not yet
fixed for local UI dev. Worth doing at some point, not required for this
deployment to work correctly.
