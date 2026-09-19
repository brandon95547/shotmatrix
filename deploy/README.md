# Deploying the Shot Matrix service

Prod is the box behind skylanex.com (`ssh root@phansora.com`). The service runs in
Docker, because Playwright's WebKit needs a newer glibc than CentOS 8's 2.28. The
container is managed by the systemd unit in this folder. nginx exposes it at
`https://www.skylanex.com/api/shotmatrix/`.

| Piece | Where |
|---|---|
| Checkout | `/var/www/shotmatrix` (branch `main`) |
| Unit | `/etc/systemd/system/shotmatrix.service`, a copy of `deploy/shotmatrix.service` |
| Container | `shotmatrix`, published on `127.0.0.1:4700` only |
| Runs | a 512m tmpfs at `/data` inside the container — RAM, never the disk. A run is deleted once its zip is downloaded, or 10 minutes after it finishes |
| Accounts | Phansora's app (`127.0.0.1:3000`), through nginx: `auth_request` to `/api/auth/check` in front of every `/api/shotmatrix/` request, which becomes `X-Shotmatrix-User` |
| nginx | the `/api/shotmatrix/`, `/api/auth/` and `/auth/google` locations and the three `limit_req_zone`s in `/etc/nginx/conf.d/skylanex.com.conf`. That file exists only on the server, with no copy in any repo; edit it there |

## Deploy a change

```bash
cd /var/www/shotmatrix && git pull --ff-only && systemctl restart shotmatrix
```

The unit rebuilds the image on every start. Unchanged layers are cached, so this takes
seconds. Restarting drops any run in progress and every finished run waiting to be
downloaded — they live in RAM, and nothing about them outlives the process.

## Check it

```bash
systemctl status shotmatrix
journalctl -u shotmatrix -f                   # one line per run, plus blocked connections
curl -s 127.0.0.1:4700/api/shotmatrix/health
node scripts/smoke.mjs --api http://127.0.0.1:4700/api/shotmatrix --user 1 https://example.com
```

## First install

```bash
git clone git@github.com:brandon95547/shotmatrix.git /var/www/shotmatrix
cd /var/www/shotmatrix && docker compose build          # pulls the ~2GB Playwright image
cp deploy/shotmatrix.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now shotmatrix
```

Then add the nginx rules and reload: `nginx -t && systemctl reload nginx`.
