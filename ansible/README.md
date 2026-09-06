# Deploying trade-bot with Ansible

First-deployment playbook for `apps/ui` + `apps/engine`, running exactly as
configured today — **paper/testnet, no real capital** — on a single Ubuntu/
Debian server, entirely as native system services. No containers: Node.js,
MongoDB, and Redis are all installed directly via `apt`, and the app itself
runs under `systemd`. `apps/chatops` is not deployed by this playbook.

## Before you start

**Read `strategies/btc-high-risk.md`'s "Engine port" section first** if
you're at all tempted to point this at a real Binance account. The
TypeScript port of that strategy has a known, still-not-fully-closed gap
against its own backtest (91.9% match rate as of the last check, one
unresolved edge case, inherent feed-noise divergence still being
validated live) — understand that before ever setting
`btc_high_risk_allow_live: true` in your own `all.yml`. Leave it false
(the default) unless you've made that call deliberately, with capital
you can afford to lose.

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

There's no `ssh_private_key_file` variable — Ansible's "omit this argument
if unset" mechanism doesn't work for connection variables like
`ansible_ssh_private_key_file` (only for a module's own arguments), so an
earlier version of this that tried to make it conditional in
`inventory.yml` ended up passing a literal placeholder string as the key
path, and SSH failed with "no such identity." Pick one instead:

- Use your default SSH agent/key (`ssh-add ~/.ssh/id_ed25519` etc.) — no
  configuration needed here.
- Add an `IdentityFile` entry for this host in `~/.ssh/config`.
- Pass it on the command line: `ansible-playbook -i inventory.yml playbook.yml --private-key=/path/to/key`.

If the server has never seen your key before, add it the normal way
(`ssh-copy-id`, or your provider's cloud-init/dashboard) — this playbook
doesn't provision your own access to the box, only what happens once
Ansible is already able to log in.

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

**This only works if this playbook's own nginx is the one actually
listening on port 80.** If something else on the server already owns that
port (see the next section), TLS needs to happen at whichever nginx *is*
on port 80 instead — leave `enable_https: false` here and handle the
certificate on that other nginx's side.

### Coexisting with another nginx on the same server

Hit live on a real deployment: the target server already ran another
service (GitLab CE) with its own bundled nginx already bound to port 80.
Only one process can own that port, so this playbook's own nginx vhost
listens on `127.0.0.1:{{ nginx_internal_port }}` (default 8081) instead
of the public port — basic auth still happens here, this is just not the
first hop from the internet anymore.

This means whichever nginx (or other reverse proxy) *does* own port 80/443
on the box needs one small, additional piece of config to forward
`domain_name` requests to that internal port. **This playbook doesn't do
that step for you** — it's a one-time change to a *different* service's
configuration, which isn't something to apply unattended to infrastructure
this playbook doesn't own. Apply it manually once, matching whatever
that other nginx's own config convention is. For a plain nginx, a new
server block is enough:

```nginx
server {
    listen 80;
    server_name trade.toskas.gr;
    location / {
        proxy_pass http://127.0.0.1:8081;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

For GitLab's omnibus-managed nginx specifically (the case this was found
on): GitLab's own `/etc/gitlab/gitlab.rb` has a documented hook for
exactly this,
[`nginx['custom_nginx_config']`](https://docs.gitlab.com/omnibus/settings/nginx/)
— set it to `include` a separate file (so `gitlab-ctl reconfigure` never
needs to touch, or risk clobbering, this project's own config), put the
server block above in that included file, then run `gitlab-ctl
reconfigure` and confirm GitLab's own site still loads afterward before
considering it done.

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
- `btc_high_risk_allow_live` defaults to `false` — see the top of this
  file and `group_vars/all.yml.example`'s comment before ever setting it
  true.

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
