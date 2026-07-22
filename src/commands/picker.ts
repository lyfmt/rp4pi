import type { SaveRecord } from "../state/save-repository.ts";

const PAGE_SIZE = 10;

export type PickSaveOptions = {
  page?: number;
  selectNumber?: number;
  nativePickSave?: (items: Array<{ id: string; label: string }>) => string | Promise<string | undefined> | undefined;
};

export function isValidPickSaveOptions(options: PickSaveOptions): boolean {
  return normalizePage(options.page) !== undefined && normalizeSelectNumber(options.selectNumber) !== undefined;
}

export function pickSave(saves: readonly SaveRecord[], options: PickSaveOptions = {}): SaveRecord | Promise<SaveRecord | undefined> | undefined {
  const page = normalizePage(options.page);
  const selectNumber = normalizeSelectNumber(options.selectNumber);
  if (page === undefined || selectNumber === undefined) {
    return undefined;
  }
  const sorted = sortSaves(saves);
  if (options.nativePickSave) {
    // pi's ui.select renders a scrolling list: the user navigates every save
    // with the up/down arrows (and can type to filter), so we hand it the full
    // list instead of paginating ourselves.
    const picked = options.nativePickSave(
      sorted.map((save) => ({ id: save.id, label: `${save.updatedAt} | ${save.id}` }))
    );
    if (picked instanceof Promise) {
      return picked.then((id) => sorted.find((save) => save.id === id));
    }
    return sorted.find((save) => save.id === picked);
  }
  // Plain-text fallback (no native picker) cannot scroll, so it stays paginated.
  return sorted.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE)[selectNumber - 1];
}

export function renderSavePickerPage(saves: readonly SaveRecord[], page = 0): string {
  const pageNumber = normalizePage(page);
  if (pageNumber === undefined) {
    return "";
  }
  const sorted = sortSaves(saves);
  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const current = Math.min(pageNumber, totalPages - 1);
  const lines = sorted
    .slice(current * PAGE_SIZE, current * PAGE_SIZE + PAGE_SIZE)
    .map((save, index) => `${index + 1}. ${save.updatedAt} | ${save.id}`);
  const footer: string[] = [`第 ${current + 1}/${totalPages} 页`];
  if (current < totalPages - 1) {
    footer.push(`下一页：/load {"page":${current + 1}}`);
  }
  if (current > 0) {
    footer.push(`上一页：/load {"page":${current - 1}}`);
  }
  return [...lines, "", footer.join("　")].join("\n");
}

function sortSaves(saves: readonly SaveRecord[]): SaveRecord[] {
  return [...saves].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function normalizePage(page = 0): number | undefined {
  return Number.isInteger(page) && page >= 0 ? page : undefined;
}

function normalizeSelectNumber(selectNumber = 1): number | undefined {
  return Number.isInteger(selectNumber) && selectNumber >= 1 && selectNumber <= PAGE_SIZE ? selectNumber : undefined;
}
