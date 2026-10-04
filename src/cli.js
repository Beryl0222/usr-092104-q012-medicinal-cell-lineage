#!/usr/bin/env node
/**
 * 中药细胞株科研谱系 —— 命令行查询入口。
 *
 * 用法：
 *   node src/cli.js status <materialId> [--log data/event-log.json]
 *   node src/cli.js ancestors <materialId>
 *   node src/cli.js claim <claimId>            科学主张 -> 样本/参数/原始观测
 *   node src/cli.js runs [--material ID] [--outcome success|failure|inconclusive] [--no-failures]
 *   node src/cli.js transfer <transferId>      转出前核对四要素/期限/冻结/持有方
 *   node src/cli.js withdraw <claimId>         撤回影响面（持有方、在途、下游研究）
 *   node src/cli.js departure <personId>       离岗放行检查
 *   node src/cli.js report                     管理者跨团队复现与流转报告
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildServiceFromLog } from "./service.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_LOG = resolve(HERE, "..", "data", "event-log.json");

function parseArgs(argv) {
  const [command, positional, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === "--no-failures") flags.includeFailures = false;
    else if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = rest[i + 1];
      if (next === undefined || next.startsWith("--")) flags[key] = true;
      else {
        flags[key] = next;
        i += 1;
      }
    }
  }
  return { command, positional, flags };
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));
  const logPath = resolve(flags.log ?? DEFAULT_LOG);
  const { service, report } = await buildServiceFromLog(logPath);

  if (report.rejected > 0) {
    process.stderr.write(`警告：${report.rejected} 个事件信封被拒收，详见 report 命令的 ingest_rejections。\n`);
  }

  switch (command) {
    case "status": {
      if (!positional) throw new Error("需要 materialId");
      print(service.statusOf(positional));
      break;
    }
    case "ancestors": {
      if (!positional) throw new Error("需要 materialId");
      const lineage = service.materials.lineageOf(positional);
      if (!lineage) print({ found: false, material_id: positional });
      else {
        print({
          material_id: positional,
          strain_designation: lineage.material.strain_designation,
          ancestor_ids: lineage.ancestor_ids,
          ancestry: lineage.ancestor_path.map((s) => ({
            ancestor: s.material_id,
            via_edge: s.edge.kind,
            via_event: s.edge.event_id,
            detail: s.edge.detail,
          })),
          freeze: lineage.freeze,
        });
      }
      break;
    }
    case "claim": {
      if (!positional) throw new Error("需要 claimId");
      print(service.evidenceFor(positional));
      break;
    }
    case "runs": {
      print(
        service.research.searchRuns({
          materialId: flags.material,
          outcome: flags.outcome,
          includeFailures: flags.includeFailures ?? true,
        })
      );
      break;
    }
    case "transfer": {
      if (!positional) throw new Error("需要 transferId");
      print(service.compliance.verifyTransfer(positional, service.materials));
      break;
    }
    case "withdraw": {
      if (!positional) throw new Error("需要 claimId");
      const claim = service.research.claims.get(positional);
      if (!claim) print({ found: false, claim_id: positional });
      else print(service.compliance.withdrawalImpact(claim, service.research, service.materials));
      break;
    }
    case "departure": {
      if (!positional) throw new Error("需要 personId");
      print(service.compliance.departureStatus(positional));
      break;
    }
    case "report": {
      print(service.managementReport());
      break;
    }
    default: {
      process.stderr.write(
        "未知命令。可用：status | ancestors | claim | runs | transfer | withdraw | departure | report\n"
      );
      process.exitCode = 2;
    }
  }
}

main().catch((err) => {
  process.stderr.write(`${err.message}\n`);
  process.exitCode = 1;
});
