import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function read(relativePath: string): string {
  return readFileSync(new URL(`../../${relativePath}`, import.meta.url), "utf8");
}

test("project entry documents point to one authoritative control plane", () => {
  const readme = read("README.md");
  const workflow = read("workflow.md");
  const roadmap = read("docs/plans/00-roadmap.md");
  const controlPlane = read("docs/design/project-control-plane.md");
  const systemContract = read(
    "docs/superpowers/specs/2026-07-10-system-extension-contract-design.md"
  );
  const context = read("CONTEXT.md");
  const transactionPlan = read(
    "docs/superpowers/plans/2026-07-10-system-transaction-command-runtime.md"
  );
  const gmBindingPlan = read(
    "docs/superpowers/plans/2026-07-10-gm-commit-turn-tool-binding.md"
  );
  const snapshotPlan = read(
    "docs/superpowers/plans/2026-07-10-system-story-snapshot-roll.md"
  );
  const probePlan = read(
    "docs/superpowers/plans/2026-07-10-first-system-probe-vertical-slice.md"
  );
  const p1Plans = [
    "2026-07-10-system-registry-persistence-migration.md",
    "2026-07-10-system-transaction-command-runtime.md",
    "2026-07-10-gm-commit-turn-tool-binding.md",
    "2026-07-10-system-story-snapshot-roll.md",
    "2026-07-10-first-system-probe-vertical-slice.md"
  ];

  assert.match(
    readme,
    /\[项目控制面\]\(\.\/docs\/design\/project-control-plane\.md\)/
  );
  assert.match(
    workflow,
    /\*\*文档状态：\*\* 目标流程，不代表当前全部由 runtime 强制执行。/
  );
  assert.match(roadmap, /\*\*当前阶段：\*\*[^\n]*P1[^\n]*已完成/);

  assert.match(controlPlane, /## 当前实现/);
  assert.match(controlPlane, /## 目标实现/);
  assert.match(controlPlane, /## 当前缺口/);
  assert.match(controlPlane, /## 文档权威顺序/);
  assert.match(controlPlane, /## 当前里程碑/);
  assert.match(controlPlane, /系统扩展契约[^\n]*\| 规格已批准 \|/);
  assert.match(
    controlPlane,
    /System 扩展[^\n]*registry[^\n]*namespaced state[^\n]*transaction runtime[^\n]*commit_turn/
  );
  assert.match(controlPlane, /System 扩展[^\n]*relay-blueprints[^\n]*生成 probe/);
  assert.match(
    controlPlane,
    /P1[^\n]*全量 snapshot\/roll[^\n]*生成与升级探针[^\n]*\| 已完成 \|/
  );
  assert.match(
    roadmap,
    /P1[^\n]*生成与升级探针[^\n]*\| 已完成 \|/
  );
  assert.match(
    controlPlane,
    /可升级自定义系统[^\n]*activation[^\n]*command[^\n]*snapshot migration[^\n]*restore/
  );
  assert.doesNotMatch(controlPlane, /没有 GM 可调用的新 `commit_turn`/);
  assert.doesNotMatch(controlPlane, /没有 System module runtime 和 state namespace/);
  assert.doesNotMatch(controlPlane, /snapshot 主体仍是核心 `RpState`/);
  assert.match(controlPlane, /RNG 抽卡探针[^\n]*jobs[^\n]*audit[^\n]*visibility[^\n]*尚未实现/);
  assert.match(controlPlane, /NPC 并发委派[^\n]*不是 runtime 编排保证/);
  assert.match(controlPlane, /三回合因果规划[^\n]*没有进入实际 Writer pipeline/);
  assert.match(roadmap, /P2[^\n]*NPC 编排 runtime[^\n]*\| 尚未实现 \|/);
  assert.match(roadmap, /P3[^\n]*RNG 抽卡探针[^\n]*\| 尚未实现 \|/);
  assert.match(systemContract, /P1[^\n]*生成系统[^\n]*可升级自定义系统/);
  assert.match(systemContract, /P3[^\n]*抽卡[^\n]*RNG/);

  assert.match(transactionPlan, /branch_epoch/);
  assert.match(transactionPlan, /PRIMARY KEY \(save_id, branch_epoch, request_id\)/);
  assert.match(gmBindingPlan, /sessionId[^\n]*toolCallId/);
  assert.match(gmBindingPlan, /worlds\/border-station\/prompts\/gm-output\.md/);
  assert.match(snapshotPlan, /revision[^\n]*branchEpoch/);
  assert.match(snapshotPlan, /投递确认/);
  assert.match(snapshotPlan, /升级基线/);
  assert.match(probePlan, /RNG[^\n]*P3/);

  for (const plan of p1Plans) {
    assert.ok(controlPlane.includes(`../superpowers/plans/${plan}`));
    assert.ok(roadmap.includes(`../superpowers/plans/${plan}`));
    assert.ok(systemContract.includes(`../plans/${plan}`));
  }

  assert.match(context, /\*\*故事回合\*\*/);
  assert.match(context, /\*\*Story snapshot\*\*/);
  assert.match(context, /\*\*System module\*\*/);
  assert.match(context, /\*\*System state\*\*/);
  assert.match(context, /\*\*State commit\*\*/);
  assert.match(context, /\*\*Capability\*\*/);
});
