# Deploying to fly.io

MolView2 has no server component. The Docker image is a Vite build served by
nginx, so a deployment is static files behind Fly's TLS terminator — no secrets,
no environment variables, no volumes, no database.

## Files

| File | Purpose |
| --- | --- |
| `Dockerfile` | Two stages: `node:22-alpine` runs `npm ci && npm run build`, `nginx:1.27-alpine` serves `dist/` |
| `nginx.conf` | Caching, gzip, SPA fallback, `/healthz` |
| `security-headers.conf` | CSP and the other response headers, included per-location |
| `fly.toml` | App name, region, machine size, health check |
| `.dockerignore` | Keeps `node_modules`, `dist` and `.git` out of the build context |

## First deploy

```bash
fly launch --no-deploy
```

Answer no when it offers to overwrite `fly.toml`. It will rename the app if
`molview2` is taken, and it may change `primary_region` — the config here
defaults to `yul` (Montreal).

Then:

```bash
fly deploy
```

Subsequent deploys are the same `fly deploy`. Nothing else needs to be
configured; the app is reachable at `https://<app>.fly.dev`.

## What the configuration assumes

**HTTPS is mandatory, not a preference.** WebGPU requires a secure context, so
the app simply does not start over plain http. `force_https = true` in
`fly.toml` covers this.

**The machine can sleep.** `auto_stop_machines = 'suspend'` with
`min_machines_running = 0` means an idle deployment costs nothing and the first
request after an idle period pays a wake-up of roughly a second. Set
`min_machines_running = 1` if that matters.

**512 MB, one shared CPU.** nginx serving static files needs a fraction of
this. The memory that matters is the *client's* — a 2.9M-atom capsid is decoded
and rendered in the visitor's browser, not here.

**Bandwidth is RCSB's, not yours.** Coordinates are fetched by the browser
directly from `models.rcsb.org`. This deployment serves about 1 MB of
JavaScript and CSS per cold visit and nothing else, whatever the size of the
structures people open.

## Caching

`/assets/*` is fingerprinted by Vite and served `immutable` for a year;
`index.html` is served `no-cache` so a deploy reaches clients that already have
the shell. Getting this backwards is the usual way a static deploy appears to
have not taken effect.

## Content Security Policy

`security-headers.conf` restricts `connect-src` to the hosts the app actually
uses:

- `data.rcsb.org`, `search.rcsb.org`, `models.rcsb.org`, `files.rcsb.org`
- `openrouter.ai` — only reached when the user has entered their own key

`style-src` needs `'unsafe-inline'` because KaTeX writes inline style
attributes. `worker-src`/`img-src` allow `blob:` for the structure loader and
the runtime font atlas.

If a future feature calls a new host, add it here — the failure mode is a
blocked request logged in the browser console, not a visible error in the UI.

## Verified locally

The image was built and smoke-tested before this was written: headers correct on
the shell, on a fallback path and on a hashed asset; gzip active; 404 for a
missing asset; `nginx -t` clean. The container was then driven in a browser —
1UBQ loaded end to end (GraphQL metadata, BinaryCIF through the worker, cartoon
rendered) with no CSP violations, and all five external endpoints returned 200
under the policy.

To repeat it:

```bash
docker build -t molview2:test . && docker run --rm -p 8099:80 molview2:test
```
