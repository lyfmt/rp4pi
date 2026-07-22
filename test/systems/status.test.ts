import assert from "node:assert/strict";
import test from "node:test";

import { formatSystemProjections } from "../../src/systems/status.ts";

test("formatSystemProjections renders only public projection values", () => {
  assert.equal(
    formatSystemProjections([
      { system: "progression", revision: 3, value: { level: 2, xp: 75 } }
    ]),
    [
      "系统状态：",
      "- progression (revision 3): {\"level\":2,\"xp\":75}"
    ].join("\n")
  );
});
