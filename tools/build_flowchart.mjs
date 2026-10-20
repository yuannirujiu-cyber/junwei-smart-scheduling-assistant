#!/usr/bin/env node
/* 生成《排产决策流程图》SVG 与自包含 HTML 查看页。
 * ---------------------------------------------------------------------------
 * 为什么用生成器而不是手写 SVG：图里有 30 多个节点与 40 多条连线，手写坐标必然对不齐，
 * 改一处文案就要重排全图。这里用一个极小的布局层（band / box / diamond / arrow）把坐标算出来，
 * 文案集中在数据区，改字不动版式。产出的 SVG 是纯静态矢量图：零依赖、可离线打开、可打印。
 *
 * 用法：node tools/build_flowchart.mjs
 * 产出：算法说明/01-排产决策流程图.svg
 *       算法说明/排产决策流程图.html（内联 SVG，双击即可打开）
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, "算法说明");
mkdirSync(OUT, { recursive: true });

const C = {
  bg: "#ffffff", ink: "#0f172a", ink2: "#334155", muted: "#64748b", line: "#94a3b8",
  band: "#f8fafc", bandLine: "#e2e8f0",
  step: "#eef2ff", stepLine: "#6366f1", stepInk: "#312e81",
  decide: "#fff7ed", decideLine: "#f59e0b", decideInk: "#78350f",
  stop: "#fef2f2", stopLine: "#ef4444", stopInk: "#7f1d1d",
  core: "#ecfdf5", coreLine: "#10b981", coreInk: "#064e3b",
  note: "#f1f5f9", noteLine: "#cbd5e1",
};
const FONT = "PingFang SC, Microsoft YaHei, Helvetica Neue, system-ui, sans-serif";
const FONT_ATTR = JSON.stringify(FONT);
const ENT = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => (c === String.fromCharCode(34) ? "&quot;" : ENT[c])); }

const parts = [];
const W = 1240;
let H = 0;

function band(y, h, title, sub) {
  parts.push(`<rect x="24" y="${y}" width="${W - 48}" height="${h}" rx="14" fill="${C.band}" stroke="${C.bandLine}"/>`);
  parts.push(`<text x="44" y="${y + 30}" font-family=${FONT_ATTR} font-size="19" font-weight="700" fill="${C.ink}">${esc(title)}</text>`);
  if (sub) parts.push(`<text x="44" y="${y + 52}" font-family=${FONT_ATTR} font-size="13.5" fill="${C.muted}">${esc(sub)}</text>`);
}

function box(id, cx, y, w, lines, kind) {
  const lh = 21, padY = 18;
  const h = lines.length * lh + padY * 2 - 4;
  const pal = { step: [C.step, C.stepLine, C.stepInk], decide: [C.decide, C.decideLine, C.decideInk],
    stop: [C.stop, C.stopLine, C.stopInk], core: [C.core, C.coreLine, C.coreInk], note: [C.note, C.noteLine, C.ink2] };
  const st = pal[kind] || pal.step;
  const x = cx - w / 2;
  parts.push(`<rect id="${id}" x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${st[0]}" stroke="${st[1]}" stroke-width="1.6"/>`);
  lines.forEach((t, i) => {
    const yy = y + padY + 15 + i * lh;
    const bold = i === 0;
    parts.push(`<text x="${cx}" y="${yy}" text-anchor="middle" font-family=${FONT_ATTR} font-size="${bold ? 15 : 13.5}" font-weight="${bold ? 600 : 400}" fill="${bold ? st[2] : C.ink2}">${esc(t)}</text>`);
  });
  return { cx, y, w, h, top: y, bottom: y + h, id, x };
}

function diamond(id, cx, y, w, text) {
  const h = 74, x = cx - w / 2, cy = y + h / 2;
  parts.push(`<path id="${id}" d="M ${cx} ${y} L ${cx + w / 2} ${cy} L ${cx} ${y + h} L ${cx - w / 2} ${cy} Z" fill="${C.decide}" stroke="${C.decideLine}" stroke-width="1.6"/>`);
  parts.push(`<text x="${cx}" y="${cy + 5}" text-anchor="middle" font-family=${FONT_ATTR} font-size="13.5" font-weight="600" fill="${C.decideInk}">${esc(text)}</text>`);
  return { cx, y, w, h, top: y, bottom: y + h, id };
}

function arrowV(from, to, label) {
  parts.push(`<path d="M ${from.cx} ${from.bottom} L ${to.cx} ${to.top}" fill="none" stroke="${C.line}" stroke-width="1.8" marker-end="url(#ah)"/>`);
  if (label) parts.push(`<text x="${from.cx + 10}" y="${(from.bottom + to.top) / 2 + 4}" font-family=${FONT_ATTR} font-size="12.5" fill="${C.muted}">${esc(label)}</text>`);
}
function arrowPath(d, label, lx, ly) {
  parts.push(`<path d="${d}" fill="none" stroke="${C.line}" stroke-width="1.8" marker-end="url(#ah)"/>`);
  if (label) parts.push(`<text x="${lx}" y="${ly}" font-family=${FONT_ATTR} font-size="12.5" fill="${C.muted}">${esc(label)}</text>`);
}

/* ===================== ① 订单进入与数据接入 ===================== */
let y = 60;
band(y, 150, "① 订单进入与数据接入", "空白启动：没有隐式数据源，数据只来自上传或显式深链");
const n1 = box("n1", W / 2, y + 74, 780, ["订单文件 / 设备产能文件 / .json 数据快照", "订单号 · 规格 · 数量 · 预发货日；设备台账 + 捻股/合绳产能矩阵（空值 = 不适配）"]);
y = n1.bottom + 46;

/* ===================== ② 工艺映射与建模 ===================== */
band(y, 520, "② 工艺映射与建模（buildModel）", "把「一张订单」变成「订单 × 三道工序」的可求解问题；任何缺口都进阻断清单，不静默丢单");
let cy = y + 74;
const n2 = box("n2", W / 2, cy, 780, ["规则校验 R7：订单号 / 规格 / 数量 / 预发货日", "缺一不可；缺交期的订单不许进入排产（否则会出现「标为阻断却照排」的自相矛盾）"]);
const d1 = diamond("d1", W / 2, n2.bottom + 30, 300, "字段完整？");
const e1 = box("e1", W / 2 + 420, n2.bottom + 8, 320, ["进入阻断清单", "保留在交付率分母中，给出补录入口"], "stop");
arrowV(n2, d1);
arrowPath(`M ${d1.cx + 150} ${d1.y + 37} L ${e1.x - 6} ${d1.y + 37}`, "否", d1.cx + 158, d1.y + 30);
const n3 = box("n3", W / 2, d1.bottom + 34, 800, ["buildCapacity：设备台账 → 规格区间 / 产速；产能矩阵 → 每台机每分钟产出米数", "矩阵空值与非正值一律视为「不适配」，绝不补 0、不补均值"]);
const n4 = box("n4", W / 2, n3.bottom + 24, 900, ["resolveMapping：成品规格 → 合绳规格（规格归一化键匹配）→ 捻股股型（股径几何推导 + 就近匹配）", "→ 拉丝单丝直径 → 各工序需求量（合绳 ×1.00 / 捻股 ×股数×捻缩 / 拉丝 ×丝数×损耗）"]);
const d2 = diamond("d2", W / 2, n4.bottom + 30, 320, "映射完整？");
const e2 = box("e2", W / 2 + 420, n4.bottom + 8, 320, ["R1 阻断：给出缺口字段与修复入口", "不猜测、不套用不存在的机台"], "stop");
arrowV(n3, n4); arrowV(n4, d2);
arrowPath(`M ${d2.cx + 160} ${d2.y + 37} L ${e2.x - 6} ${d2.y + 37}`, "否", d2.cx + 168, d2.y + 30);
const n5 = box("n5", W / 2, d2.bottom + 30, 820, ["buildModel 产出 jobs[]：每张可排订单 = 拉丝 → 捻股 → 合绳三道工序", "同时记录 due / duePolicy / graceHours / 名义工时 / 各工序需求量"]);
arrowV(d2, n5, "是");
y = n5.bottom + 46;

/* ===================== ③ 前瞻派单核心 ===================== */
band(y, 1110, "③ 前瞻派单核心（dispatch.js）：订单进入后「如何挑订单、挑机台」的全过程", "目标序：硬约束优先 → 交期优先 → 减少换型；单步前瞻 + 设备预约，不做全局搜索、不做回溯");
cy = y + 74;
const n6 = box("n6", W / 2, cy, 820, ["事件循环：t ← 下一个事件时刻（机台空闲 / 订单就绪），同一时刻的事件先批量处理再统一派单", "空白工厂起步：所有机台初始空闲、初始配置未知（首次上机保守计一次换型）"]);
const n7 = box("n7", W / 2, n6.bottom + 22, 880, ["机台空闲 → 先兑现「到期且仍有效」的设备预约（预约机台空闲后优先兑现）", "预约只允许被「严格更早且完全可行」的方案转移：不允许反复把同一订单推给未来的下一台"], "core");
const n8 = box("n8", W / 2, n7.bottom + 22, 900, ["候选筛选（三条缺一不可）：本工序已就绪 · 机台兼容 · 未被其他机台或预约占用", "不能因为「平均 10 分钟就有一台空闲」就假设订单可以等——只有核实过的机台才算数"]);
const n9 = box("n9", W / 2, n8.bottom + 22, 940, ["计算两个余量：S = 交期 −（本工序及下游名义加工 + 最坏换型）　｜　G = 上工序完工 + 4320 − 本工序开工", "S < 0 表示已无等待空间；G 只对捻股 / 合绳生效（R6：相邻工序间隔 ≤ 72 小时）"]);
const n10 = box("n10", W / 2, n9.bottom + 22, 940, ["分层：紧急可行（0 ≤ S < 阈值）→ 负余量（S < 0）→ 普通可行（S ≥ 阈值）", "阈值默认 拉丝 1500 / 捻股 1080 / 合绳 600 分钟；负余量可选 AFTER_URGENT（默认）或 DEFER（暂缓并记录原因）"]);
const n11 = box("n11", W / 2, n10.bottom + 22, 940, ["层内排序：约束余量 min(S, G) 最小者优先 → 更早交期 → 更早下达 → 订单号", "d = 层内最紧急订单　｜　c = 层内「当前机台同型号（无需换型）且完全可行」的最紧急订单"]);
arrowV(n6, n7); arrowV(n7, n8); arrowV(n8, n9); arrowV(n9, n10); arrowV(n10, n11);

const dY = n11.bottom + 52;
/* §5.5 的四行决策，拆成一条竖直判定链：每一行就是一个「是 / 否」出口，避免了并排两个菱形互相压线。 */
const d1x = diamond("dd1", W / 2, dY, 360, "d 同型号，或没有可行的 c？");
const d2x = diamond("dd2", W / 2, d1x.bottom + 46, 360, "d 有更早的可行下一台？");
const d3x = diamond("dd3", W / 2, d2x.bottom + 46, 340, "d 在本机可行？");
const aA = box("aA", 1010, d1x.y - 10, 400, ["动作 A：加工 d", "必要时按目标配置换型（d 同型号则免换型）", "§5.5 第 1 行"], "core");
const aB = box("aB", 215, d2x.y - 10, 390, ["动作 B：预约 d 到下一台 + 本机加工 c", "本机保持当前配置不换型", "d 在下一台空闲后按预约优先兑现（§5.5 第 2 行）"], "core");
const aC = box("aC", 1010, d3x.y - 10, 400, ["动作 C：立即换型加工 d", "等待会违约或超 72 h，但当前方案可行", "→ 不等待（§5.5 第 3 行）"], "core");
const aD = box("aD", W / 2, d3x.bottom + 40, 620, ["动作 D：让位给同层其他可行订单 + 登记风险", "立即与等待方案都不可行时：本机不空转，d 记为「无法保护」", "绝不静默放宽，也绝不把订单丢掉（§5.5 第 4 行）"], "stop");
arrowV(n11, d1x);
arrowPath(`M ${d1x.cx + 180} ${d1x.y + 37} L ${aA.x - 8} ${aA.y + 48}`, "是", d1x.cx + 188, d1x.y + 30);
arrowV(d1x, d2x, "否");
arrowPath(`M ${d2x.cx - 180} ${d2x.y + 37} L ${aB.x + aB.w + 8} ${aB.y + 48}`, "有", d2x.cx - 188, d2x.y + 30);
arrowV(d2x, d3x, "没有");
arrowPath(`M ${d3x.cx + 170} ${d3x.y + 37} L ${aC.x - 8} ${aC.y + 48}`, "可行", d3x.cx + 178, d3x.y + 30);
arrowV(d3x, aD, "不可行（含超出计划窗口）");
const busY = Math.max(aA.bottom, aB.bottom, aC.bottom, aD.bottom) + 34;
const drops = [aA, aB, aC, aD];
drops.forEach((n) => parts.push(`<path d="M ${n.cx} ${n.bottom} L ${n.cx} ${busY}" fill="none" stroke="${C.line}" stroke-width="1.8"/>`));
parts.push(`<path d="M ${Math.min(...drops.map(n => n.cx))} ${busY} L ${Math.max(...drops.map(n => n.cx))} ${busY}" fill="none" stroke="${C.line}" stroke-width="1.8"/>`);
parts.push(`<text x="60" y="${busY - 10}" font-family=${FONT_ATTR} font-size="12.5" fill="${C.muted}">四种决策动作最终都汇入同一处落位逻辑：</text>`);
const landY = busY + 46;
const n12 = box("n12", W / 2, landY, 960, ["落位：B = max(t, 订单就绪时间, 机台空闲时刻) → A = B + 换型 → C = A + 加工（向上取整到分钟）", "更新机台：freeTime = C，currentFamily = 目标配置；把加工段与换型段写入占用时间线"], "core");
arrowV({ cx: W / 2, bottom: busY }, n12);
const n13 = box("n13", W / 2, n12.bottom + 24, 960, ["可行性（§5.4）：已释放 / 工序就绪 / 机台兼容 · 无时间冲突与重复分配", "预计完成 E ≤ 交期 · 捻股与合绳还要求 A ≤ 上工序完工 + 4320 分钟", "满足不了就「排进去 + 显式标注异常」，而不是悄悄放宽，也不是把订单丢掉"]);
arrowV(n12, n13);
y = n13.bottom + 46;

/* ===================== ④ 后处理与校验 ===================== */
band(y, 430, "④ 后处理 · 校验 · 指标", "后处理只做「修复与回收」，不改变求解目标；校验与指标独立于求解过程重算");
cy = y + 74;
const n14 = box("n14", W / 2, cy, 940, ["repairWaits：R6 工序间隔修复（前序任务原地后移 / 换机台重放，把间隔压回 72 小时内）", "只移动任务，不新增设备，也不放宽上限"]);
const n15 = box("n15", W / 2, n14.bottom + 24, 940, ["improveSchedule：迟到恢复（在不产生新冲突的前提下把任务往前挪）", "每次提交前做整体占用与停机自洽性校验，不通过则整体回滚"]);
const n16 = box("n16", W / 2, n15.bottom + 24, 940, ["refreshTraceFields：收尾归一化「上工序完工 / 工序间隔 / 换型段」字段", "保证工序排产表的可追溯字段与任务实际位置永远自洽"]);
const n17 = box("n17", W / 2, n16.bottom + 24, 940, ["validateSchedule：三级风险（阻断 / 警告 / 提示）—— canConfirm = 阻断数 == 0", "computeMetrics：准时交付率 · 延期单数与小时 · 设备计划占用率 · 加工利用率 · 换型总时长"]);
arrowV(n14, n15); arrowV(n15, n16); arrowV(n16, n17);
y = n17.bottom + 46;

/* ===================== ⑤ 版本与人工干预 ===================== */
band(y, 330, "⑤ 版本 · 人工干预 · 确认导出", "人工干预优先于自动结果：锁定与冻结的任务在重算中位置不变");
cy = y + 74;
const n18 = box("n18", W / 2, cy, 940, ["生成候选版本（不可变快照 + 内容指纹），可与基线对比", "存在阻断时确认按钮禁用：不许把有硬冲突的计划标成「已确认」"]);
const n19 = box("n19", W / 2 - 250, n18.bottom + 30, 440, ["人工干预后重算", "锁定（机台 + 起止）/ 执行冻结 / 调整表单", "非法输入当场拦截，保留用户输入并指出原因"], "note");
const n20 = box("n20", W / 2 + 250, n18.bottom + 30, 440, ["一键收敛（有界）", "反复排除阻断订单并重算，直到可确认", "排除需明确勾选，排除清单进导出首页"], "note");
arrowV(n18, n19); arrowV(n18, n20);
const n21 = box("n21", W / 2, n19.bottom + 30, 940, ["确认版本 / 导出（排产清单 · 工单 · 风险清单 · 甘特 PNG · 负荷报告 · CSV）", "使用演示参数时，版本与导出文件持续标注「模拟结果，含未验证参数」"], "core");
arrowV(n19, n21); arrowV(n20, n21);
y = n21.bottom + 46;

/* ===================== 图例与边界 ===================== */
band(y, 210, "图例与适用边界", "");
const lg = [["步骤 / 判定", "#eef2ff", "#6366f1"], ["决策动作", "#ecfdf5", "#10b981"], ["阻断 / 风险出口", "#fef2f2", "#ef4444"], ["人工干预", "#f1f5f9", "#cbd5e1"]];
lg.forEach((it, i) => {
  const x = 60 + i * 250;
  parts.push(`<rect x="${x}" y="${y + 74}" width="34" height="18" rx="5" fill="${it[1]}" stroke="${it[2]}" stroke-width="1.4"/>`);
  parts.push(`<text x="${x + 44}" y="${y + 88}" font-family=${FONT_ATTR} font-size="13.5" fill="${C.ink2}">${esc(it[0])}</text>`);
});
const NOTES = [
  "本流程给出的是「在给定目标序下的一版可解释、可复现的可行计划」，不是数学意义上的全局最优解。",
  "它保证：硬约束不被静默放宽 · 每个任务都给得出适配依据与工时公式 · 同一输入必得同一输出 · 风险显式分级。",
  "它不保证：全局最优 · 所有订单必然按期 · 接入真实换型矩阵与工艺路线后的产能最优。",
];
NOTES.forEach((t, i) => parts.push(`<text x="60" y="${y + 128 + i * 24}" font-family=${FONT_ATTR} font-size="13.5" fill="${C.ink2}">${esc(t)}</text>`));
H = y + 230;

const svg = [
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="君威智能排产助手 · 排产决策流程图">`,
  `<title>君威智能排产助手 · 排产决策流程图</title>`,
  `<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${C.line}"/></marker></defs>`,
  `<rect width="${W}" height="${H}" fill="${C.bg}"/>`,
  parts.join("\n"),
  "</svg>",
].join("\n");
writeFileSync(resolve(OUT, "01-排产决策流程图.svg"), svg, "utf8");
console.log("已生成 算法说明/01-排产决策流程图.svg（" + W + " × " + H + "）");

const css = [
  ":root{color-scheme:light}",
  "body{margin:0;background:#f1f5f9;font-family:" + FONT + ";color:#0f172a}",
  "header{position:sticky;top:0;background:#0f172a;color:#fff;padding:12px 22px;display:flex;gap:16px;align-items:baseline;flex-wrap:wrap;z-index:2}",
  "header h1{font-size:16px;margin:0;font-weight:700}",
  "header span{font-size:12.5px;color:#cbd5e1}",
  "header a{color:#93c5fd;font-size:12.5px}",
  "main{padding:20px}.sheet{background:#fff;border-radius:12px;box-shadow:0 1px 3px rgba(15,23,42,.12);overflow:auto}",
  "svg{display:block;height:auto;max-width:100%}",
  "@media print{header{position:static;background:#fff;color:#0f172a}header span,header a{color:#475569}main{padding:0}.sheet{box-shadow:none}}",
].join("\n");
const head = [
  "<!DOCTYPE html>",
  "<html lang=\"zh-CN\"><head><meta charset=\"utf-8\"/>",
  "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"/>",
  "<title>君威智能排产助手 · 排产决策流程图</title>",
  "<style>", css, "</style></head><body>",
  "<header><h1>君威智能排产助手 · 排产决策流程图</h1>",
  "<span>订单进入 → 校验 → 工艺映射 → 前瞻派单 → 后处理 → 校验指标 → 确认导出</span>",
  "<a href=\"./02-三工序排产算法说明.md\">算法说明（Markdown）</a>",
  "<a href=\"./README.md\">目录</a></header>",
  "<main><div class=\"sheet\">",
].join("\n");
writeFileSync(resolve(OUT, "排产决策流程图.html"), head + "\n" + svg + "\n</div></main></body></html>\n", "utf8");
console.log("已生成 算法说明/排产决策流程图.html（内联 SVG，可双击直接打开）");