import { createHash } from "node:crypto";

export function fingerprintBatch(batch: readonly unknown[]): string {
  return createHash("sha256").update(canonicalJson(batch)).digest("hex");
}

export function canonicalJson(value: unknown): string {
  return serializeJson(value, "$", new WeakSet());
}

function serializeJson(value: unknown, path: string, ancestors: WeakSet<object>): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      incompatible(path, "number must be finite");
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    incompatible(path, `${typeof value} is not a JSON value`);
  }
  if (ancestors.has(value)) {
    incompatible(path, "circular reference");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const entries: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          incompatible(`${path}[${index}]`, "sparse array entry");
        }
        entries.push(serializeJson(value[index], `${path}[${index}]`, ancestors));
      }
      return `[${entries.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      incompatible(path, "object must have a plain or null prototype");
    }
    if (Object.getOwnPropertySymbols(value).some((key) => Object.prototype.propertyIsEnumerable.call(value, key))) {
      incompatible(path, "enumerable symbol key");
    }

    const object = value as Record<string, unknown>;
    const entries = Object.keys(object)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${serializeJson(object[key], `${path}.${key}`, ancestors)}`
      );
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function incompatible(path: string, reason: string): never {
  throw new TypeError(`Value is not canonical JSON at ${path}: ${reason}.`);
}
