export type CharacterAction = {
  name: string;
  action: string;
};

export type StoryElements = {
  currentSituation: string;
  playerIntent: string;
  visibleChanges: string[];
  presentCharacters: string[];
  // 本轮各在场 NPC 的行动依据：GM 并发委派 role 子代理扮演后收集、去矛盾的产物
  // （台词/行动/心情/下一步）。writer 据此落笔，而不是自行编造角色行为。空数组表示
  // 本轮无人有戏份（纯独白/环境）。
  characterActions: CharacterAction[];
  tension: string;
};

export type DirectionPacket =
  | {
      storyElements: StoryElements;
      needsRender: true;
      directReply: string;
    }
  | {
      needsRender: false;
      directReply: string;
    };

export function parseDirectionPacket(value: unknown): DirectionPacket {
  if (!isRecord(value)) {
    throw new TypeError("导演包需要对象 { needsRender, storyElements 或 directReply }。");
  }

  // 入口宽：模型常把 needsRender 写成 "true"/"false"，把要素写成数字。归一化后
  // 再校验领域不变量（核心严）。
  const needsRender = coerceBoolean(value, "needsRender");
  const directReply = coerceString(value, "directReply");

  if (!needsRender && directReply.length === 0) {
    throw new TypeError("needsRender=false 时 directReply 必须非空，否则本轮没有任何输出。");
  }

  if (!needsRender) {
    return { needsRender, directReply };
  }

  return {
    storyElements: coerceStoryElements(value["storyElements"]),
    needsRender,
    directReply
  };
}

function coerceStoryElements(value: unknown): StoryElements {
  if (value === undefined || value === null) {
    return emptyStoryElements();
  }
  if (!isRecord(value)) {
    throw new TypeError("storyElements 需要对象。");
  }
  return {
    currentSituation: coerceStoryElementString(value, "currentSituation"),
    playerIntent: coerceStoryElementString(value, "playerIntent"),
    visibleChanges: coerceStoryElementStringList(value, "visibleChanges"),
    presentCharacters: coerceStoryElementStringList(value, "presentCharacters"),
    characterActions: coerceCharacterActions(value["characterActions"]),
    tension: coerceStoryElementString(value, "tension")
  };
}

function emptyStoryElements(): StoryElements {
  return {
    currentSituation: "",
    playerIntent: "",
    visibleChanges: [],
    presentCharacters: [],
    characterActions: [],
    tension: ""
  };
}

// characterActions 入口同样从宽：接受对象数组 { name, action }，也容忍模型退化成
// 纯字符串（视作无名行动）或单个对象。空/缺省归一化为空数组；全空条目被丢弃。
function coerceCharacterActions(value: unknown): CharacterAction[] {
  if (value === undefined || value === null) {
    return [];
  }
  const items = Array.isArray(value) ? value : [value];
  const actions: CharacterAction[] = [];
  items.forEach((item, index) => {
    const action = coerceCharacterAction(item, index);
    if (action.name.length > 0 || action.action.length > 0) {
      actions.push(action);
    }
  });
  return actions;
}

function coerceCharacterAction(value: unknown, index: number): CharacterAction {
  if (typeof value === "string") {
    return { name: "", action: value };
  }
  if (!isRecord(value)) {
    throw new TypeError(`characterActions[${index}] 需要对象 { name, action } 或文本。`);
  }
  return {
    name: coerceStringValue(value["name"], `characterActions[${index}].name`),
    action: coerceStringValue(value["action"], `characterActions[${index}].action`)
  };
}

function coerceStoryElementString(input: Record<string, unknown>, key: keyof StoryElements): string {
  return coerceStringValue(input[key], key);
}

function coerceStoryElementStringList(input: Record<string, unknown>, key: keyof StoryElements): string[] {
  const value = input[key];
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    return [coerceStringValue(value, key)];
  }
  return value.map((item, index) => coerceStringValue(item, `${key}[${index}]`));
}

function coerceString(input: Record<string, unknown>, key: "directReply"): string {
  return coerceStringValue(input[key], key);
}

function coerceStringValue(value: unknown, key: string): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  throw new TypeError(`${key} 需要文本。`);
}

function coerceBoolean(input: Record<string, unknown>, key: keyof DirectionPacket): boolean {
  const value = input[key];
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  throw new TypeError(`${key} 需要布尔值（true / false）。`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
