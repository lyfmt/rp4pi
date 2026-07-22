export type LoreVisibility = "public" | "gm" | "secret";

export type LoreRelation = {
  type: string;
  target: string;
  note?: string;
};

export type LoreEntry = {
  id: string;
  kind: string;
  subtype?: string;
  name: string;
  aliases: string[];
  summary: string;
  body: string;
  tags: string[];
  visibility: LoreVisibility;
  fields: Record<string, unknown>;
  relations: LoreRelation[];
  sourcePath?: string;
};

export function parseLoreEntries(value: unknown): LoreEntry[] {
  if (!Array.isArray(value)) {
    throw new TypeError("Lore entries must be an array");
  }
  return value.map((entry, index) => parseLoreEntry(entry, `entries[${index}]`));
}

function parseLoreEntry(value: unknown, field: string): LoreEntry {
  const entry = parseRecord(value, field);
  const parsed: LoreEntry = {
    id: parseRequiredString(entry.id, `${field}.id`),
    kind: parseRequiredString(entry.kind, `${field}.kind`),
    name: parseRequiredString(entry.name, `${field}.name`),
    aliases: parseStringArray(entry.aliases, `${field}.aliases`, []),
    summary: parseRequiredString(entry.summary, `${field}.summary`),
    body: parseOptionalString(entry.body, `${field}.body`, ""),
    tags: parseStringArray(entry.tags, `${field}.tags`, []),
    visibility: parseVisibility(entry.visibility, `${field}.visibility`),
    fields: parseFields(entry.fields, `${field}.fields`),
    relations: parseRelations(entry.relations, `${field}.relations`)
  };

  if (entry.subtype !== undefined) {
    parsed.subtype = parseRequiredString(entry.subtype, `${field}.subtype`);
  }
  if (entry.sourcePath !== undefined) {
    parsed.sourcePath = parseRequiredString(entry.sourcePath, `${field}.sourcePath`);
  }

  return parsed;
}

function parseStringArray(value: unknown, field: string, fallback: string[]): string[] {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (!Array.isArray(value)) {
    throw new TypeError(`Lore field ${field} must be an array`);
  }
  return value.map((entry, index) => parseRequiredString(entry, `${field}[${index}]`));
}

function parseRelations(value: unknown, field: string): LoreRelation[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new TypeError(`Lore field ${field} must be an array`);
  }
  return value.map((entry, index) => {
    const relation = parseRecord(entry, `${field}[${index}]`);
    const parsed: LoreRelation = {
      type: parseRequiredString(relation.type, `${field}[${index}].type`),
      target: parseRequiredString(relation.target, `${field}[${index}].target`)
    };
    if (relation.note !== undefined) {
      parsed.note = parseRequiredString(relation.note, `${field}[${index}].note`);
    }
    return parsed;
  });
}

function parseFields(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined || value === null) {
    return {};
  }
  if (!isRecord(value)) {
    throw new TypeError(`Lore field ${field} must be an object`);
  }
  return { ...value };
}

function parseVisibility(value: unknown, field: string): LoreVisibility {
  if (value === undefined || value === null) {
    return "public";
  }
  if (value !== "public" && value !== "gm" && value !== "secret") {
    throw new TypeError(`Lore field ${field} must be public, gm, or secret`);
  }
  return value;
}

function parseOptionalString(value: unknown, field: string, fallback: string): string {
  if (value === undefined || value === null) {
    return fallback;
  }
  return parseString(value, field);
}

function parseRequiredString(value: unknown, field: string): string {
  const text = parseString(value, field).trim();
  if (text.length === 0) {
    throw new TypeError(`Lore field ${field} must not be empty`);
  }
  return text;
}

function parseString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`Lore field ${field} must be a string`);
  }
  return value;
}

function parseRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError(`Lore field ${field} must be an object`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
