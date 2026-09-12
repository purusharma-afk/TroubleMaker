# Meant to Break

Meant to Break is a normal-looking commerce website with deliberately realistic API failure paths. The customer sees an ordinary product, account, checkout, and operations experience; the backend records the evidence that an SRE agent can investigate later.

## Run locally

```bash
npm install
npm run dev
```

Open <http://127.0.0.1:5181>.

The local API service loads `MEANT_TO_BREAK_DATABASE_URL` from `.env`, creates the `meant_to_break_events` table from `schema.sql`, serves the website, and writes structured events to PostgreSQL. It does not connect to Vedin, Test Harness, SRE-Bench, or any external database.

## Deliberate failure paths

- Search returns `504` after a catalog/database hop.
- Checkout returns `502` after checkout → payments worker → provider hops.
- Profile save returns `409` after a profile/database hop.
- Export creation returns `500` after export API → queue → worker hops.
- Session refresh returns `401` after identity API → session store hops.

Every request carries a `correlation_id` and `trace_id`. Events include service, endpoint, status, timing, level, error code, scenario, parent span, and metadata. The user-facing website only displays a generic error and a reference ID; it does not expose root-cause analysis.

Failure events also include a `metadata.diagnostics` object with a redacted synthetic stack trace, exception type, repository source file and line, dependency, root-cause signal, suggested fix, and deployment release. These deterministic traces are intentionally tied to the failure scenarios so an SRE agent can correlate the user-facing error with the repository evidence. They are marked `synthetic: true` and do not contain credentials or customer data.

The support page can download recent events through `GET /api/logs` for inspection. The health endpoint is `GET /api/health`.

## Vercel deployment

The `api/` directory contains Vercel-compatible Node.js functions, while `server.js` remains the local development server. Configure `MEANT_TO_BREAK_DATABASE_URL` as a Vercel environment variable for Preview and Production; never upload `.env`.

The committed `public/` directory is the Vercel static output. The build command intentionally does not execute browser or local-server files.

## Availability simulation

The storefront has a top-bar control for testing Vedin's availability detection. Click `Take site down` to enable the simulation, then click `Restore website` to recover. The switch is stored in PostgreSQL, makes `/api/health` return `503` with `SYNTHETIC_OUTAGE`, and rejects application API calls while leaving the static page and control available for recovery.
