import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";

const mod = await import(
  pathToFileURL(new URL("../../src/commands/save-picker-component.ts", import.meta.url).pathname).href
);
const createSavePickerComponent =
  mod.createSavePickerComponent as typeof import("../../src/commands/save-picker-component.js").createSavePickerComponent;
const createSearchablePickerComponent =
  mod.createSearchablePickerComponent as typeof import("../../src/commands/save-picker-component.js").createSearchablePickerComponent;

// Default keybindings matcher mirroring pi's TUI action ids we rely on.
const keybindings = {
  matches(data: string, keybinding: string): boolean {
    const map: Record<string, string[]> = {
      "tui.select.up": ["\x1b[A"],
      "tui.select.down": ["\x1b[B"],
      "tui.editor.cursorRight": ["\x1b[C"],
      "tui.editor.cursorLeft": ["\x1b[D"],
      "tui.select.confirm": ["\r", "\n"],
      "tui.select.cancel": ["\x1b"]
    };
    return (map[keybinding] ?? []).includes(data);
  }
};

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text
};

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const ENTER = "\r";
const ESC = "\x1b";

function makeItems(count: number): Array<{ id: string; label: string }> {
  return Array.from({ length: count }, (_, index) => ({ id: `save-${index}`, label: `label-${index}` }));
}

function setup(items: Array<{ id: string; label: string }>) {
  let renders = 0;
  let result: { value: string | undefined } | undefined;
  const tui = { requestRender: () => { renders += 1; } };
  const component = createSavePickerComponent(items, tui, theme, keybindings, (id) => {
    result = { value: id };
  });
  return {
    component,
    getResult: () => result,
    getRenders: () => renders
  };
}

test("confirm returns the highlighted save on the current page", () => {
  const { component, getResult } = setup(makeItems(3));
  component.handleInput?.(DOWN);
  component.handleInput?.(ENTER);
  assert.deepEqual(getResult(), { value: "save-1" });
});

test("escape cancels with undefined", () => {
  const { component, getResult } = setup(makeItems(3));
  component.handleInput?.(ESC);
  assert.deepEqual(getResult(), { value: undefined });
});

test("up/down wrap within the current page", () => {
  const { component, getResult } = setup(makeItems(3));
  component.handleInput?.(UP); // wraps to last (index 2)
  component.handleInput?.(ENTER);
  assert.deepEqual(getResult(), { value: "save-2" });
});

test("right arrow pages forward, left arrow pages back", () => {
  const { component, getResult } = setup(makeItems(25));
  component.handleInput?.(RIGHT); // page 1 -> items 10..19, selection resets to 0
  component.handleInput?.(ENTER);
  assert.deepEqual(getResult(), { value: "save-10" });

  const second = setup(makeItems(25));
  second.component.handleInput?.(RIGHT);
  second.component.handleInput?.(RIGHT); // page 2 -> items 20..24
  second.component.handleInput?.(LEFT); // back to page 1
  second.component.handleInput?.(ENTER);
  assert.deepEqual(second.getResult(), { value: "save-10" });
});

test("right arrow wraps from last page back to first", () => {
  const { component, getResult } = setup(makeItems(15)); // 2 pages
  component.handleInput?.(RIGHT); // page 1
  component.handleInput?.(RIGHT); // wraps to page 0
  component.handleInput?.(ENTER);
  assert.deepEqual(getResult(), { value: "save-0" });
});

test("typing filters the list and confirm picks from filtered results", () => {
  const { component, getResult } = setup(makeItems(25));
  // "label-1" matches label-1, label-10..label-19 (11 items): first is label-1.
  component.handleInput?.("1");
  component.handleInput?.(ENTER);
  assert.deepEqual(getResult(), { value: "save-1" });
});

test("backspace removes the last filter character", () => {
  const { component, getResult } = setup(makeItems(25));
  component.handleInput?.("9");
  component.handleInput?.("9"); // "99" matches nothing
  component.handleInput?.("\x7f"); // back to "9"
  component.handleInput?.(ENTER); // first match of "9" is label-9
  assert.deepEqual(getResult(), { value: "save-9" });
});

test("render shows page count and filter state and stays within width", () => {
  const { component } = setup(makeItems(25));
  const lines = component.render(40);
  assert.ok(lines.some((line) => line.includes("第 1/3 页")));
  assert.ok(lines.some((line) => line.includes("共 25 条")));
  assert.ok(lines.every((line) => line.length <= 60));
});

test("requestRender is called on navigation but not on no-op keys", () => {
  const { component, getRenders } = setup(makeItems(3));
  component.handleInput?.(DOWN);
  assert.equal(getRenders(), 1);
  component.handleInput?.("\x1b[Z"); // shift-tab: not handled
  assert.equal(getRenders(), 1);
});

test("generic searchable picker renders custom model copy and returns a filtered id", () => {
  let result: string | undefined;
  const component = createSearchablePickerComponent(
    [
      { id: "provider-a/model-a", label: "model-a [provider-a]" },
      { id: "provider-b/model-b", label: "model-b [provider-b]" }
    ],
    { requestRender() {} },
    theme,
    keybindings,
    (id) => {
      result = id;
    },
    {
      title: "选择新模型",
      emptyText: "没有匹配的可用模型"
    }
  );

  const lines = component.render(60);
  assert.equal(lines[0], "选择新模型");
  component.handleInput?.("b");
  component.handleInput?.(ENTER);
  assert.equal(result, "provider-b/model-b");
});
