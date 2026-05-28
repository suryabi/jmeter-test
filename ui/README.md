# BIQ JMeter Runner UI

Angular dashboard for the Node JMeter Runner API. For the full architecture, deployment, and team workflow docs see the repo root `README.md`.

## Prerequisites

- Node 18+
- API running and reachable (default `http://localhost:5050`, see root README)

## Local development

```bash
cd ui
npm install   # first time only
npm start
```

Open `http://localhost:4200`.

The dev server expects the API at the URL configured in `src/environments/environment.ts`.

## Environment configuration

Two env files exist:

- `src/environments/environment.ts` — used for `npm start` (dev)
- `src/environments/environment.prod.ts` — used for `npm run build` (production)

### Dev

```ts
export const environment = {
  production: false,
  runnerApiUrl: 'http://localhost:5050'
};
```

### Production

Edit only this for production:

```ts
export const environment = {
  production: true,
  runnerApiUrl: 'https://runner.yourcompany.com/api'
};
```

The Angular build replaces `environment.ts` with `environment.prod.ts` automatically via `angular.json` `fileReplacements`.

## Build for production

```bash
cd ui
npm run build
# Output: ui/dist/biq-runner-ui/browser/
```

Deploy that folder as static files (nginx, S3+CloudFront, etc.).

## What UI devs typically edit

- Components and pages: `src/app/...`
- Models: `src/app/core/models/`
- API client: `src/app/core/services/runner.service.ts`
- Styles: `src/styles.scss` or per-component `.scss`

## Features summary

- Configure JMX parameters by group (Global / Configuration / Environment, dynamic)
- Launch a population run with a label
- Live log streaming (SSE)
- Steps panel alongside the terminal
- Passed/Failed sample table with API + error details
- HTML report — open in tab or embed inline
- Delete past runs to free disk

For deployment options (same-domain proxy vs. subdomain), see the root README.
