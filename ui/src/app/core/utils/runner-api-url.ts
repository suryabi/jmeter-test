import { environment } from '../../../environments/environment';

const DEFAULT_DEV_API_URL = 'http://localhost:5050';

/** Dev: same host as the UI, API port 5050, unless environment.ts overrides runnerApiUrl. Prod: fixed runnerApiUrl from environment. */
export function resolveRunnerApiUrl(): string {
  if (environment.production) {
    return environment.runnerApiUrl;
  }

  if (environment.runnerApiUrl && environment.runnerApiUrl !== DEFAULT_DEV_API_URL) {
    return environment.runnerApiUrl;
  }

  if (typeof window !== 'undefined' && window.location.hostname) {
    return `http://${window.location.hostname}:5050`;
  }

  return environment.runnerApiUrl;
}
