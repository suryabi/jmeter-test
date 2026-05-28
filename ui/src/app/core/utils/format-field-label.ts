function isSnakeCase(name: string): boolean {
  return name.includes('_');
}

function isCamelCase(name: string): boolean {
  return /[a-z\d][A-Z]/.test(name) || /[A-Z][a-z]/.test(name);
}

function toTitleCaseWords(spaced: string): string {
  return spaced
    .split(' ')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

function isSingleLowercaseWord(name: string): boolean {
  return /^[a-z][a-z0-9]*$/.test(name);
}

/**
 * snake_case or camelCase → Title Case with spaces.
 * Single lowercase word → capitalize first letter only (e.g. protocol → Protocol).
 * Anything else is returned unchanged.
 */
export function formatFieldLabel(name: string): string {
  if (!name) return '';

  if (!isSnakeCase(name) && !isCamelCase(name)) {
    if (isSingleLowercaseWord(name)) {
      return name.charAt(0).toUpperCase() + name.slice(1);
    }
    return name;
  }

  const spaced = name
    .replace(/_/g, ' ')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();

  return toTitleCaseWords(spaced);
}
