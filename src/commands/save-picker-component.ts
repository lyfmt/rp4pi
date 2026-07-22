import type {
  PiComponentLike,
  PiKeybindingsLike,
  PiThemeLike,
  PiTuiHostLike
} from "../types/pi.ts";

export type SavePickerItem = { id: string; label: string };

const PAGE_SIZE = 10;

/**
 * A focus-grabbing selector rendered through `ui.custom`. Unlike pi's built-in
 * extension selector (which renders every option at once with no scrolling or
 * filtering), this component:
 *   - moves the highlight with ↑/↓ (wrapping at the ends),
 *   - pages the list with ←/→ (PAGE_SIZE rows per page),
 *   - filters as the user types (printable chars; Backspace deletes).
 *
 * It implements pi's `Component` contract structurally and never imports
 * `@earendil-works/pi-tui`, which is not installed in this project's
 * node_modules (only the global pi process resolves it).
 */
export function createSavePickerComponent(
  items: readonly SavePickerItem[],
  tui: PiTuiHostLike,
  theme: PiThemeLike,
  keybindings: PiKeybindingsLike,
  done: (id: string | undefined) => void
): PiComponentLike {
  let filter = "";
  let page = 0;
  let selected = 0;

  function filtered(): SavePickerItem[] {
    if (filter.length === 0) {
      return [...items];
    }
    const needle = filter.toLowerCase();
    return items.filter((item) => item.label.toLowerCase().includes(needle));
  }

  function pageCount(matches: SavePickerItem[]): number {
    return Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
  }

  function clampPosition(matches: SavePickerItem[]): void {
    const pages = pageCount(matches);
    page = Math.min(Math.max(page, 0), pages - 1);
    const onPage = matches.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
    selected = Math.min(Math.max(selected, 0), Math.max(0, onPage.length - 1));
  }

  return {
    render(width: number): string[] {
      const matches = filtered();
      clampPosition(matches);
      const pages = pageCount(matches);
      const onPage = matches.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

      const lines: string[] = [];
      lines.push(theme.fg("accent", theme.bold("选择存档")));
      lines.push(theme.fg("muted", `过滤：${filter.length > 0 ? filter : "（输入以过滤）"}`));
      lines.push("");

      if (onPage.length === 0) {
        lines.push(theme.fg("muted", "  没有匹配的存档"));
      } else {
        onPage.forEach((item, index) => {
          const isSelected = index === selected;
          const text = truncate(item.label, Math.max(1, width - 4));
          lines.push(isSelected ? theme.fg("accent", `→ ${text}`) : `  ${theme.fg("text", text)}`);
        });
      }

      lines.push("");
      lines.push(
        theme.fg(
          "muted",
          `第 ${pages === 0 ? 0 : page + 1}/${pages} 页（共 ${matches.length} 条）  ↑↓ 移动  ←→ 翻页  Enter 选择  Esc 取消`
        )
      );
      return lines;
    },

    handleInput(data: string): void {
      const matches = filtered();
      clampPosition(matches);
      const pages = pageCount(matches);
      const onPage = matches.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

      if (keybindings.matches(data, "tui.select.cancel")) {
        done(undefined);
        return;
      }
      if (keybindings.matches(data, "tui.select.confirm")) {
        done(onPage[selected]?.id);
        return;
      }
      if (keybindings.matches(data, "tui.select.up")) {
        selected = onPage.length === 0 ? 0 : (selected - 1 + onPage.length) % onPage.length;
      } else if (keybindings.matches(data, "tui.select.down")) {
        selected = onPage.length === 0 ? 0 : (selected + 1) % onPage.length;
      } else if (keybindings.matches(data, "tui.editor.cursorLeft")) {
        page = (page - 1 + pages) % pages;
        selected = 0;
      } else if (keybindings.matches(data, "tui.editor.cursorRight")) {
        page = (page + 1) % pages;
        selected = 0;
      } else if (isBackspace(data)) {
        if (filter.length > 0) {
          filter = filter.slice(0, -1);
          page = 0;
          selected = 0;
        }
      } else if (isPrintable(data)) {
        filter += data;
        page = 0;
        selected = 0;
      } else {
        return;
      }
      tui.requestRender();
    },

    invalidate(): void {
      // No cached render state to clear.
    }
  };
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

function isBackspace(data: string): boolean {
  return data === "\x7f" || data === "\b";
}

function isPrintable(data: string): boolean {
  // Single visible character, excluding control bytes and escape sequences.
  return data.length === 1 && data >= " " && data !== "\x7f";
}
