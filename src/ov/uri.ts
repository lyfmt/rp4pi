export function userSpaceForSave(saveId: string): string {
  return `save-${saveId}`;
}

export function memoryRootForSave(saveId: string): string {
  return `viking://user/${userSpaceForSave(saveId)}/memories`;
}

export function assertUriInCurrentSave(uri: string, saveId: string): void {
  const root = memoryRootForSave(saveId);
  if (uri !== root && !uri.startsWith(`${root}/`)) {
    throw new Error(`OpenViking URI is outside current save memory root: ${uri}`);
  }
}
