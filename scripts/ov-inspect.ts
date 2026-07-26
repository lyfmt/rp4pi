import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { createOpenVikingClient } from "../src/ov/client.ts";
import { readOpenVikingConfig } from "../src/ov/config.ts";
import { assertUriInCurrentSave, memoryRootForSave, userSpaceForSave } from "../src/ov/uri.ts";

// 只读 OV 巡检:确认某个存档的长期记忆里真的有(或还没有)某条内容。
// 典型用途:forge_character / forge_role 之后验证 NPC 是否已沉淀。落库是异步
// 提取——commit 只入队并返回 task_id,真正写入常需几分钟——所以刚 forge 完
// 查不到不等于失败:先 --task 看提取任务状态,completed 后再 --query 搜。
//
// 用法(--save 必填,--query / --read / --task 至少给一个,可组合):
//   node scripts/ov-inspect.ts --save <saveId> --query <角色名> [--limit 5]
//   node scripts/ov-inspect.ts --save <saveId> --task <taskId>
//   node scripts/ov-inspect.ts --save <saveId> --read "viking://user/save-<id>/memories/..."
//
// saveId 在游戏内用 /save 查看;taskId 在 forge_character 的返回文本里。
// 连接参数与运行时同源(环境变量 OPENVIKING_URL/... 或 .pi/agent/settings.json,
// 默认 http://127.0.0.1:1933)。本脚本只读,不写任何记忆;作为诊断工具,它
// 有意不理会游戏运行时的 RP_DISABLE_OPENVIKING 开关。
// 退出码:0=完成;1=查询零命中或任务 failed;2=用法错误或 OV 不可达。

function usage(): never {
  console.error(
    "用法: node scripts/ov-inspect.ts --save <saveId> [--query <text>] [--task <taskId>] [--read <uri>] [--limit N]"
  );
  process.exit(2);
}

const { values } = parseArgs({
  options: {
    save: { type: "string" },
    query: { type: "string" },
    task: { type: "string" },
    read: { type: "string" },
    limit: { type: "string" }
  }
});

const saveId = values.save;
if (!saveId || (!values.query && !values.task && !values.read)) {
  usage();
}
const limit = Math.max(1, Math.floor(Number(values.limit ?? "5")) || 5);

const projectRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
const config = readOpenVikingConfig(process.env, projectRoot);
const client = createOpenVikingClient({ ...config, user: userSpaceForSave(saveId) });
const memoryRoot = memoryRootForSave(saveId);

let exitCode = 0;

try {
  if (values.task) {
    const task = await client.getTask(values.task);
    console.log(`task ${values.task}: status=${task.status ?? "unknown"}`);
    if (task.memoriesExtracted !== undefined) {
      console.log(`  memories_extracted=${task.memoriesExtracted}`);
    }
    if (task.error) {
      console.log(`  error=${task.error}`);
    }
    if (task.status === "failed") {
      exitCode = 1;
    } else if (task.status !== "completed") {
      console.log("  提取仍在进行(OV 提取是分钟级后台任务),稍后重查。");
    }
  }

  if (values.query) {
    const results = await client.find(values.query, memoryRoot, limit);
    console.log(`query "${values.query}" in ${memoryRoot}: ${results.length} 命中`);
    for (const row of results) {
      console.log(`  [${row.score.toFixed(3)}] ${row.uri}`);
      if (row.abstract) {
        console.log(`      ${row.abstract.replaceAll("\n", " ").slice(0, 200)}`);
      }
    }
    if (results.length === 0) {
      console.log("  零命中。若刚 forge/commit 完:提取是异步的,先用 --task 确认任务 completed 再查;也可换关键词。");
      exitCode = Math.max(exitCode, 1);
    }
  }

  if (values.read) {
    assertUriInCurrentSave(values.read, saveId);
    const content = await client.read(values.read);
    console.log(`read ${values.read}:`);
    if (content === "") {
      console.log("(正文为空。characters 类记忆的字段存在服务端文件的 MEMORY_FIELDS 元数据里,摘要看 --query 的命中即可。)");
    } else {
      console.log(content);
    }
  }
} catch (error) {
  console.error(`ov-inspect 失败: ${error instanceof Error ? error.message : String(error)}`);
  console.error(`(OV 地址: ${config.baseUrl};确认 openviking-server 已启动、参数拼写正确)`);
  process.exit(2);
}

process.exit(exitCode);
