import { environment } from '../../../environments/environment';

/** Dev: same host as the UI, API port 5050. Prod: fixed runnerApiUrl from environment. */
export function resolveRunnerApiUrl(): string {
  if (environment.production) {
    return environment.runnerApiUrl;
  }

  if (typeof window !== 'undefined' && window.location.hostname) {
    return `http://${window.location.hostname}:5050`;
  }

  return environment.runnerApiUrl;
}
