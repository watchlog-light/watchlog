# Deploying the website (watchlog.io)

The site in `site/` is static: `pnpm --filter @watchlog/site generate` writes plain files
to `site/.output/public`, and nginx serves them. No Node.js runs on the server, and every
page works as plain files on any static host.

| What                  | Where                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Settings              | `site/site.config.ts`: site URL, repository URL, version, `repoPublic`, `cloudWaitlist`, legal operator and contact                  |
| nginx                 | `deploy/site/nginx/watchlog.io.conf`                                                                                                 |
| Deploy, rollback      | `deploy/site/deploy-site.sh` (run from your machine; it never stores the host)                                                       |
| Test the nginx config | `deploy/site/test/nginx-test.sh`: `nginx -t`, the redirect map, pages, headers and gzip in a container                               |
| Layout on the server  | `/var/www/watchlog.io/releases/<UTC time>-<commit>/`, one per deploy, the last 3 kept; `/var/www/watchlog.io/current` → the live one |

nginx's root is `/var/www/watchlog.io/current`, not the folder itself. A deploy uploads
a complete release next to the live one, then renames a new `current` symlink over the
old one, so a failed or half-finished upload is never served. The symlink lives inside a
folder the deploy user owns, so deploys need no sudo.

## First-time server setup

Written for Ubuntu 24.04 with sudo; other distributions differ only in package names.
Cloudflare proxies watchlog.io and www.watchlog.io, with the SSL/TLS mode **Full (strict)**:
Cloudflare connects to this server over HTTPS and checks its certificate.

1. **Packages, deploy user and folder.**

   ```bash
   sudo apt update && sudo apt install -y nginx rsync
   sudo adduser --disabled-password --gecos "" deploy
   sudo install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
   # Paste the public key of the machine you deploy from:
   sudo tee -a /home/deploy/.ssh/authorized_keys
   sudo chown deploy:deploy /home/deploy/.ssh/authorized_keys && sudo chmod 600 /home/deploy/.ssh/authorized_keys
   sudo install -d -o deploy -g deploy /var/www/watchlog.io /var/www/watchlog.io/releases
   ```

2. **Certificate.** Pick one and put it at the paths the nginx config uses.
   - **Cloudflare origin certificate (simplest; only Cloudflare trusts it):** Cloudflare
     dashboard → SSL/TLS → Origin Server → Create Certificate. Use the hostnames
     `watchlog.io` and `*.watchlog.io`, RSA, 15 years. Then:

     ```bash
     sudo install -d -m 755 /etc/ssl/watchlog.io
     sudo nano /etc/ssl/watchlog.io/fullchain.pem   # paste the origin certificate
     sudo nano /etc/ssl/watchlog.io/privkey.pem     # paste the private key
     sudo chmod 600 /etc/ssl/watchlog.io/privkey.pem
     ```

   - **Let's Encrypt** (a certificate browsers trust too, renewed automatically). Use the
     DNS challenge, with a Cloudflare API token limited to Zone → DNS → Edit for
     watchlog.io:

     ```bash
     sudo apt install -y certbot python3-certbot-dns-cloudflare
     sudo install -m 600 /dev/null /etc/letsencrypt/cloudflare.ini
     echo "dns_cloudflare_api_token = <token>" | sudo tee /etc/letsencrypt/cloudflare.ini >/dev/null
     sudo certbot certonly --dns-cloudflare --dns-cloudflare-credentials /etc/letsencrypt/cloudflare.ini \
       -d watchlog.io -d www.watchlog.io --deploy-hook "systemctl reload nginx"
     sudo install -d -m 755 /etc/ssl/watchlog.io
     sudo ln -sf /etc/letsencrypt/live/watchlog.io/fullchain.pem /etc/ssl/watchlog.io/fullchain.pem
     sudo ln -sf /etc/letsencrypt/live/watchlog.io/privkey.pem /etc/ssl/watchlog.io/privkey.pem
     ```

3. **Cloudflare:** DNS records for `watchlog.io` and `www` are proxied (orange cloud), and
   SSL/TLS → Overview → **Full (strict)**.

4. **First deploy**, from your machine (see "Deploy" below), so that `current` exists
   before nginx serves it.

5. **Stop the old site** (next section).

6. **Enable the new site:**

   ```bash
   sudo cp watchlog.io.conf /etc/nginx/sites-available/watchlog.io   # from deploy/site/nginx/
   sudo ln -sf /etc/nginx/sites-available/watchlog.io /etc/nginx/sites-enabled/watchlog.io
   sudo nginx -t && sudo systemctl reload nginx
   ```

   Copy the file to the server first, for example
   `scp deploy/site/nginx/watchlog.io.conf deploy@<server>:` and then run the commands
   from the deploy user's home folder with sudo.

7. **Check**, from the server (the origin) and through Cloudflare:

   ```bash
   curl -skI --resolve watchlog.io:443:127.0.0.1 https://watchlog.io/ | head -5
   curl -sI https://watchlog.io/ | head -5
   curl -sI https://watchlog.io/pricing | grep -i '^location'   # https://watchlog.io/#cloud
   ```

**Logs:** the privacy policy says access logs are deleted after 14 days. Ubuntu's
`/etc/logrotate.d/nginx` rotates daily and keeps 14 files (`rotate 14`); check that it
still says so.

## Stopping the old site

First find what serves watchlog.io today. Nothing is deleted; the old site is only
switched off, so it can come back if needed.

```bash
sudo ss -tlnp | grep -E ':(80|443)\b'                     # which process holds the ports
ls -l /etc/nginx/sites-enabled/                           # nginx sites
sudo grep -rl "watchlog.io" /etc/nginx/ 2>/dev/null       # configs naming the domain
docker ps --format '{{.Names}}\t{{.Ports}}' 2>/dev/null   # containers publishing 80/443
systemctl list-units --type=service --state=running | grep -iE 'watchlog|node|pm2|apache'
```

Then switch off whichever it is:

- **Another nginx site:** `sudo rm /etc/nginx/sites-enabled/<old-site>` (its file stays in
  `sites-available`). Two server blocks for the same `server_name` conflict, so do this
  before enabling the new one.
- **A container:** `docker stop <name> && docker update --restart=no <name>`.
- **A Node or PM2 process:** `pm2 stop <name> && pm2 save`, or `sudo systemctl disable --now <service>`.
- **Apache:** `sudo systemctl disable --now apache2`.

Then `sudo nginx -t && sudo systemctl reload nginx`. To bring the old site back, undo the
step that switched it off and remove `/etc/nginx/sites-enabled/watchlog.io`.

## Deploy

From the repository root on your machine:

```bash
WATCHLOG_SITE_HOST=deploy@<server> deploy/site/deploy-site.sh
```

The script:

1. builds the site (`pnpm --filter @watchlog/site generate`, which also checks it);
2. uploads it to a new release folder, sending only changed files;
3. switches `current` to it;
4. deletes all but the last 3 releases.

`WATCHLOG_SITE_SSH="ssh -p 2222 -i ~/.ssh/key"` sets the ssh command, and
`WATCHLOG_SITE_DIR` changes the folder.

## Rollback

```bash
WATCHLOG_SITE_HOST=deploy@<server> deploy/site/deploy-site.sh list       # * marks the live release
WATCHLOG_SITE_HOST=deploy@<server> deploy/site/deploy-site.sh rollback   # back to the one before it
```

## Purging the Cloudflare cache

- **Hashed files under `/_nuxt/`** get a new name on every change and never need purging.
- **HTML** isn't cached by Cloudflare by default, and nginx gives it 5 minutes.
- **Other files** keep their names: `js/site.js`, `og.png`, favicons, `sitemap.xml` and `robots.txt`. Cloudflare caches the static ones (by file extension) for up to an hour. After a deploy that changes them, or whenever a change must show at once, purge:
  - Dashboard: watchlog.io → Caching → Configuration → **Purge Everything**.
  - API, with a token limited to Zone → Cache Purge:

    ```bash
    curl -X POST "https://api.cloudflare.com/client/v4/zones/<zone-id>/purge_cache" \
      -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
      --data '{"purge_everything":true}'
    ```

## Launch day

In `site/site.config.ts`, set `repoPublic: true`. That brings back:

- the GitHub and star buttons;
- the install commands, on the page and in the docs;
- `/compose.yaml` for the Docker install;
- the repository links.

Commit, deploy and purge the cache. Before that, preview the launch build locally:

```bash
WATCHLOG_SITE_REPO_PUBLIC=true pnpm --filter @watchlog/site generate
npx serve site/.output/public
```

Set `cloudWaitlist: true` and `waitlistAction` only once an endpoint stores the addresses. The privacy policy must say so first, and the CSP's `form-action` must allow that endpoint's origin.

## Optional hardening

- **Real client IPs in the logs:** behind Cloudflare, nginx logs Cloudflare's addresses.
  Add `set_real_ip_from` for each range in https://www.cloudflare.com/ips/, and
  `real_ip_header CF-Connecting-IP;`.
- **Origin only reachable through Cloudflare:** allow 443 from those ranges only, in the
  firewall.
