export function isValidDesktopVersion(value: string): boolean {
  return /^[0-9]+[.][0-9]+[.][0-9]+$/.test(value) &&
    value.split('.').every((part) => Number.isSafeInteger(Number(part)));
}

export function compareDesktopVersions(left: string, right: string): number {
  const parse = (value: string): number[] | null =>
    isValidDesktopVersion(value) ? value.split('.').map(Number) : null;
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) throw new Error('Update version must use numeric major.minor.patch format.');
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}
