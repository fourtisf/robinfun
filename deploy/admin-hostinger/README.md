# Deploy the Robinfun Admin console on `robinfun.tech` (Hostinger)

`robinfun.tech` is a **dedicated admin domain** — separate from the public app
(`robinfun.io`). That separation *is* a security win: the console lives on its
own origin, can carry its own server password, and never ships as part of the
public site.

The admin console is a single self-contained static page. It talks to the chain
directly (read via RPC, write via your wallet) — **no backend, no database, no
private key on the page.**

> **Hosting on your VPS instead of Hostinger?** Point `robinfun.tech`'s DNS at
> your VPS IP, then run the one-command installer — it adds a *separate* nginx
> server block for `robinfun.tech` (robinfun.io is untouched), publishes these
> same files, sets the security headers + optional password, and gets HTTPS:
> ```
> curl -fsSL https://raw.githubusercontent.com/fourtisf/robinfun/claude/new-session-v8c9tt/deploy/bootstrap-admin.sh -o /root/bootstrap-admin.sh
> chmod +x /root/bootstrap-admin.sh
> BASIC_AUTH_USER=admin BASIC_AUTH_PASS='choose-a-strong-pass' /root/bootstrap-admin.sh
> ```
> The rest of this file is the **manual Hostinger** path.

---

## What to upload

Everything you need is in **this folder** (`deploy/admin-hostinger/`). Upload it
into the **document root of `robinfun.tech`** (its `public_html`), preserving the
folder layout:

```
robinfun.tech/  (document root)
├── admin.html                         ← deploy/admin-hostinger/admin.html
├── .htaccess                          ← deploy/admin-hostinger/.htaccess
└── vendor/
    └── ethers-6.15.0.umd.min.js       ← deploy/admin-hostinger/vendor/ethers-6.15.0.umd.min.js
```

Only these 3 files. The `.htaccess` makes `robinfun.tech/` serve `admin.html`
and applies the security headers. **This is completely separate from
`robinfun.io`** — nothing on the public app changes.

---

## Steps (Hostinger hPanel)

1. **Confirm robinfun.tech has hosting** (not just the domain). hPanel →
   *Websites* → the domain should have a document root / `public_html`. If it's
   only a registered domain with no hosting plan, add a (free/starter) hosting
   plan for it so you have somewhere to upload these files.

2. **Open File Manager** → the `robinfun.tech` document root (`public_html`).

3. **Upload the 3 files** above. Create a folder named `vendor` and put
   `ethers-6.15.0.umd.min.js` inside it. Make sure the dotfile is named exactly
   `.htaccess` (enable "show hidden files" in File Manager if needed).

4. **Install free SSL**: hPanel → *Security* → *SSL* → install for
   `robinfun.tech` (automatic). Once it's active, you can uncomment the `HSTS`
   line in `.htaccess`. The `.htaccess` already force-redirects http → https.

5. **(Recommended) Password-protect the domain** — the strongest gate, before
   the page even loads: hPanel → *Advanced* → *Password Protect Directories* →
   protect the `robinfun.tech` root → set a username + password.

6. **Open `https://robinfun.tech`**:
   - set the in-page **passphrase** (or Skip if you used step 5's server
     password),
   - **connect** wallet `0xA49dc277…`,
   - **sign** the login challenge (proves you hold the owner key),
   - the controls unlock.

---

## Security recap (what protects this console)

| Layer | Where | Stops |
|-------|-------|-------|
| On-chain `onlyOwner` | the contracts | **anyone** changing anything — the real guard |
| Server password (Basic Auth) | Hostinger / `.htaccess` | visitors & bots before the page loads |
| Passphrase lock | in-page | shoulder-surfing / casual access |
| Wallet-signature proof | in-page | non-owners unlocking the controls |
| Auto-lock, live owner re-check, chain-id guard | in-page | idle sessions, mid-session key rotation, wrong network |
| CSP / X-Frame-Options / SRI / no-referrer | `.htaccess` + page | XSS exfil, clickjacking, tampered library, referrer leaks |

**Still the #1 action, off-page:** rotate the exposed owner key `0xA49dc277…`
to a multisig/hardware wallet before public launch. Use the console's
*Transfer ownership* card (2-step). The website lock is a screen lock, not a
vault.

---

## Updating later

When `admin.html` changes in the repo, re-upload
`deploy/admin-hostinger/admin.html` (and `vendor/` if the pinned ethers version
changed — then also update the `integrity` hash in `admin.html`). The
`.htaccess` rarely changes.
