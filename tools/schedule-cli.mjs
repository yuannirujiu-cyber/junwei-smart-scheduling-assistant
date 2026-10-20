#!/usr/bin/env node
/* 无头排产 CLI —— 让排产引擎进 CI / 批处理，不依赖浏览器
   ------------------------------------------------------------------
   用法：
     node tools/schedule-cli.mjs --data <dataset.json> [--out <dir>] [--horizon N] [--setup-weight W] [--json]

   行为：
     - 打印指标摘要（准时率 / 延期 / 占用率 / 换型 / 耗时）与风险分级计数；
     - --out <dir>：用引擎门面的 toRows('plan') 写 plan.csv（不重复实现拼装），并写 metrics.json；
     - --json：stdout 只输出一个 JSON 对象，便于管道与 CI 解析；
     - 拒绝写入 data/ 目录（与 tools/check_xlsx.mjs 同一约定）。

   退出码：
     0 成功（无阻断级风险）
     1 存在阻断级风险（validation.canConfirm === false）
     2 参数错误 / 数据集读取或校验失败 / 排产降级

   示例：
     node tools/schedule-cli.mjs --data data/dataset.json
     node tools/schedule-cli.mjs --data tools/fixtures/minimal-dataset.json --out /tmp/plan-out --json
*/
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { dirname, resolve, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXIT_OK = 0, EXIT_BLOCKED = 1, EXIT_USAGE = 2;

const HELP = `君威智能排产助手 · 无头排产 CLI

用法：
  node tools/schedule-cli.mjs --data <dataset.json> [选项]

选项：
  --data <path>          数据集 JSON（必填；相对路径先按当前目录、再按项目根解析）
  --out <dir>            输出目录：写 plan.csv 与 metrics.json（默认不写文件）
  --horizon <N>          计划窗口天数（整数，1…3650；默认按交期自动推算）
  --setup-weight <W>     换型在前置时间的权重（≥0，越大越倾向少换型；默认 0.5）
  --json                 stdout 只输出 JSON 摘要
  --help, -h             显示本帮助

退出码：
  0 成功 ｜ 1 存在阻断级风险 ｜ 2 参数或数据错误

示例：
  node tools/schedule-cli.mjs --data data/dataset.json
  node tools/schedule-cli.mjs --data tools/fixtures/alt-chain-dataset.json --horizon 60 --json
  node tools/schedule-cli.mjs --data tools/fixtures/minimal-dataset.json --out /tmp/plan-out
`;

/* ---------------- 参数解析 ---------------- */
function fail(msg, code = EXIT_USAGE) {
  console.error(msg);
  process.exit(code);
}
function parseArgs(argv) {
  const out = { data: null, out: null, horizon: null, setupWeight: null, json: false, help: false };
  const need = (name, i) => {
    const v = argv[i + 1];
    if (v == null || v.startsWith('--')) fail('参数 ' + name + ' 缺少取值；用 --help 查看用法');
    return v;
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--json') out.json = true;
    else if (a === '--data') { out.data = need('--data', i); i++; }
    else if (a === '--out') { out.out = need('--out', i); i++; }
    else if (a === '--horizon') { out.horizon = need('--horizon', i); i++; }
    else if (a === '--setup-weight') { out.setupWeight = need('--setup-weight', i); i++; }
    else fail('未知参数「' + a + '」；用 --help 查看用法');
  }
  return out;
}

const args = parseArgs(process.argv);
if (args.help) { console.log(HELP); process.exit(EXIT_OK); }
if (!args.data) fail('缺少必填参数 --data <dataset.json>；用 --help 查看用法');

let horizonDays = null;
if (args.horizon != null) {
  const n = Number(args.horizon);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 3650) {
    fail('--horizon 必须是 1…3650 的整数（实际「' + args.horizon + '」）');
  }
  horizonDays = n;
}
let setupWeight = null;
if (args.setupWeight != null) {
  const w = Number(args.setupWeight);
  if (!Number.isFinite(w) || w < 0) fail('--setup-weight 必须是不小于 0 的数值（实际「' + args.setupWeight + '」）');
  setupWeight = w;
}

/* 相对路径：先按当前目录，再按项目根（与其它 tools 脚本一致） */
async function existsFile(p) { return stat(p).then(s => s.isFile()).catch(() => false); }
async function resolveDataPath(p) {
  for (const c of [resolve(process.cwd(), p), resolve(ROOT, p)]) {
    if (await existsFile(c)) return c;
  }
  return null;
}
const dataPath = await resolveDataPath(args.data);
if (!dataPath) fail('找不到数据集文件：' + args.data + '（已尝试当前目录与项目根 ' + ROOT + '）');

/* 输出目录：拒绝写入 data/（与 check_xlsx.mjs 同一约定） */
let outDir = null;
if (args.out != null) {
  outDir = resolve(process.cwd(), args.out);
  const dataDir = resolve(ROOT, 'data') + sep;
  if (outDir === resolve(ROOT, 'data') || outDir.startsWith(dataDir)) {
    fail('拒绝写入 data/ 目录：' + outDir + '（请改用 /tmp 或项目外的输出目录）');
  }
  const st = await stat(outDir).catch(() => null);
  if (st && !st.isDirectory()) fail('--out 指向的不是目录：' + outDir);
}

/* ---------------- 载入与校验 ---------------- */
let dataset;
try {
  dataset = JSON.parse(await readFile(dataPath, 'utf8'));
} catch (e) {
  fail('数据集读取/解析失败：' + dataPath + '\n  ' + (e && e.message ? e.message : String(e)));
}

const { createScheduler, SchedulerInputError } = await import(resolve(ROOT, 'web/src/engine/index.js'));
const { toCSV } = await import(resolve(ROOT, 'web/src/core/util.js'));

let scheduler;
try {
  scheduler = createScheduler(dataset);
} catch (e) {
  if (e && e.name === 'SchedulerInputError') {
    console.error(e.code === 'CHAIN_INVALID' ? '工艺链配置无效：' : '数据集校验未通过：');
    for (const x of (e.errors || []).slice(0, 20)) {
      console.error('  - ' + (x.path || '(root)') + '：' + x.message
        + (x.expected != null ? '（期望 ' + x.expected + '，实际 ' + x.actual + '）' : ''));
    }
    if ((e.errors || []).length > 20) console.error('  … 其余 ' + (e.errors.length - 20) + ' 项略');
    process.exit(EXIT_USAGE);
  }
  console.error('引擎初始化失败：' + (e && e.message ? e.message : String(e)));
  process.exit(EXIT_USAGE);
}

const settingsOverride = {};
if (horizonDays != null) settingsOverride.horizonDays = horizonDays;
if (setupWeight != null) settingsOverride.setupWeight = setupWeight;

const result = scheduler.schedule(settingsOverride);
if (result.error) {
  console.error('排产未完成（已降级）：' + result.error);
  process.exit(EXIT_USAGE);
}
const m = result.metrics;
const risks = result.validation;
const st = result.stats;

/* ---------------- 输出 ---------------- */
const written = [];
if (outDir) {
  try {
    await mkdir(outDir, { recursive: true });
    const plan = scheduler.toRows(result, { kind: 'plan' });
    const csvRows = [plan.columns.map(c => c.header), ...plan.rows.map(r => plan.columns.map(c => r[c.key]))];
    const planPath = join(outDir, 'plan.csv');
    await writeFile(planPath, toCSV(csvRows), 'utf8');
    written.push(planPath);
    const metricsPath = join(outDir, 'metrics.json');
    const payload = {
      generatedAt: plan.meta.generatedAt,
      dataset: { path: dataPath, id: dataset.meta?.id ?? null, name: dataset.meta?.name ?? null, orderCount: scheduler.dataset.orderCount },
      processes: scheduler.describe().processes.map(p => ({ key: p.key, name: p.name, machineCount: p.machineCount })),
      settings: pickSettings(result.settings),
      stats: st,
      risks: { counts: risks.counts, canConfirm: risks.canConfirm, list: risks.risks },
      metrics: m,
    };
    await writeFile(metricsPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    written.push(metricsPath);
  } catch (e) {
    console.error('写出结果失败：' + (e && e.message ? e.message : String(e)));
    process.exit(EXIT_USAGE);
  }
}

function pickSettings(s) {
  return {
    planStart: s.planStart, horizonDays: s.horizonDays, setupWeight: s.setupWeight,
    changeoverModel: s.changeoverModel, qtyModel: s.qtyModel, calendar: s.calendar,
    demoParams: s.demoParams, duePolicy: s.duePolicy, downtime: s.downtime,
  };
}

const summary = {
  dataset: { path: dataPath, id: dataset.meta?.id ?? null, name: dataset.meta?.name ?? null },
  processes: scheduler.describe().processes.map(p => ({ key: p.key, name: p.name, machines: p.machineCount })),
  settings: { planStart: result.settings.planStart, horizonDays: result.settings.horizonDays, setupWeight: result.settings.setupWeight },
  stats: st,
  metrics: {
    deliveryRate: m.deliveryRate, onTimeOrders: m.onTimeOrders, lateOrders: m.lateOrders, lateHours: m.lateHours,
    unknownOrders: m.unknownOrders, orderCount: m.orderCount, hardRiskCount: m.hardRiskCount, hardViolation: m.hardViolation,
    machineOccRate: m.machineOccRate, machineRunRate: m.machineRunRate, totalSetupHours: m.totalSetupHours,
    taskCount: m.taskCount, makespan: m.makespan, byProcess: m.byProcess,
  },
  risks: { counts: risks.counts, canConfirm: risks.canConfirm, top: risks.risks.slice(0, 8).map(r => ({ level: r.level, type: r.type, rule: r.rule, orderId: r.orderId, title: r.title })) },
  outputs: written,
};

if (args.json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  const dsMeta = dataset.meta || {};
  console.log('数据集        ' + (dsMeta.id || '(未命名)') + ' · ' + (dsMeta.name || '—') + ' · ' + dataPath);
  console.log('工艺链        ' + scheduler.describe().processes.map(p => p.name + '(' + p.machineCount + '台)').join(' → '));
  console.log('订单          纳入 ' + m.orderCount + ' · 阻断 ' + st.blockedOrders + ' · 历史 ' + st.historyOrders + ' · 排除 ' + st.excludedOrders);
  console.log('排产          任务 ' + st.taskCount + ' 条 · 未排 ' + st.unscheduledTasks + ' 条 · R6 修复 ' + st.repairedWaits + ' 处 · 局部优化 ' + st.improvedTasks + ' 处');
  console.log('准时率        ' + fmtPct(m.deliveryRate) + '（准时 ' + m.onTimeOrders + ' / 纳入 ' + m.orderCount + '）');
  console.log('延期          ' + m.lateOrders + ' 单 · 累计 ' + m.lateHours + ' 小时 · 无法验证 ' + m.unknownOrders + ' 单');
  console.log('占用率        计划 ' + fmtPct(m.machineOccRate) + ' · 加工 ' + fmtPct(m.machineRunRate));
  console.log('换型          ' + m.totalSetupHours + ' 小时');
  console.log('耗时          首排 ' + st.firstPassMs + ' ms · 全流程 ' + st.totalMs + ' ms');
  console.log('风险          阻断 ' + risks.counts.block + ' / 警告 ' + risks.counts.warn + ' / 提示 ' + risks.counts.info + ' · canConfirm=' + (risks.canConfirm ? '是' : '否'));
  const blocks = risks.risks.filter(r => r.level === 'block').slice(0, 5);
  for (const b of blocks) console.log('  - [' + b.level + '] ' + (b.type || '') + ' ' + (b.rule || '') + '：' + (b.title || '') + (b.orderId ? '（订单 ' + b.orderId + '）' : ''));
  if (written.length) console.log('输出          ' + written.join(' · '));
  if (result.warnings && result.warnings.length) for (const w of result.warnings) console.log('提示          ' + w);
}

function fmtPct(v) { return v == null ? '—' : v + '%'; }

process.exit(risks.counts.block > 0 || risks.canConfirm === false ? EXIT_BLOCKED : EXIT_OK);
