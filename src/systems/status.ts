import type { SystemProjection } from "./types.ts";

export function formatSystemProjections(
  projections: readonly SystemProjection[]
): string {
  return [
    "系统状态：",
    ...projections.map(
      (projection) =>
        `- ${projection.system} (revision ${projection.revision}): ${JSON.stringify(projection.value)}`
    )
  ].join("\n");
}
