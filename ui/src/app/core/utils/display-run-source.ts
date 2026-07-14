/** UI label for who started a run. Empty/missing → Application (console). */
export function displayRunSource(source?: string | null): string {
  const trimmed = source?.trim();
  return trimmed ? trimmed : 'Application';
}
