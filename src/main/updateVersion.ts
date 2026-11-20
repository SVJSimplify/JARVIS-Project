export function compareDesktopVersions(left: string, right: string): number {
  const parse = (value: string): number[] | null => {
    if (!/^\d+\.\d+\.\d+$/.test(value)) return null;
    return value.split('.').map(Number);
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) throw new Error('Update version must use numeric major.minor.patch format.');
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}
