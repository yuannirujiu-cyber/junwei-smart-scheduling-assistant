#!/usr/bin/env node
/* 材料库自检：原材料目录 / 用品判定 / 储备统计 / 缺料门禁（真浏览器 + 纯引擎两段）
 * ---------------------------------------------------------------------------
 * 这是本产品扩展能力（铜、锌、铁等底层材料）的回归，守住四件事：
 *   1) 用料判定基于订单真实字段（品名/规格/绳芯/涂层），不是黑箱；
 *   2) **默认全部有货** —— 装上这个门禁不能改变任何既有数据集的结果；
 *   3) 把材料标为「无」后，需要它的订单变成异常（阻断），并且
 *      **不产生任何工序任务**（用户要求的「不进行后续加工步骤」）；
 *   4) 恢复有货后重新生成，计划回到原状（门禁可逆，不是单向破坏）。
 * 用法：node tools/check_materials.mjs [baseUrl]
 * 未安装 playwright 时只跑引擎段并打印 SKIP（不计为通过）。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { createRequire } from "node:module";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.argv[2] || "http://127.0.0.1:5178";
let pass = 0, fail = 0;
const ok = (n, c, e = "") => { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.log("  ✗ " + n + (e ? " :: " + e : "")); } };

const { MATERIAL_CATALOG, resolveMaterials, requiredMaterialsFor, checkOrderMaterials,
  computeMaterialStats, estimateSteelKg } = await import("../web/src/engine/materials.js");
const { buildCapacity } = await import("../web/src/engine/capacity.js");
const { buildModel } = await import("../web/src/engine/model.js");
const { engineDefaults, seedMaterials } = await import("../web/src/engine/index.js");
const ds = JSON.parse(readFileSync(resolve(ROOT, "data/dataset.json"), "utf8"));
const active = ds.orders.filter((o) => o.endCode !== "已结束");

/* ================= A. 目录与默认值 ================= */
console.log("--- A. 材料目录与默认值 ---");
ok("目录含铜 / 锌 / 铁等底层材料", ["copper", "zinc", "iron-core"].every((id) => MATERIAL_CATALOG.some((m) => m.id === id)),
  MATERIAL_CATALOG.map((m) => m.id).join(","));
const mats = resolveMaterials(MATERIAL_CATALOG, {});
ok("默认全部有货（" + mats.length + " 种）", mats.every((m) => m.available === true) && mats.length === MATERIAL_CATALOG.length);
ok("显式 available=false 才算缺料", resolveMaterials(MATERIAL_CATALOG, { zinc: { available: false } }).find((m) => m.id === "zinc").available === false);
ok("未提及的材料仍然默认有货", resolveMaterials(MATERIAL_CATALOG, { zinc: { available: false } }).filter((m) => m.available).length === mats.length - 1);
ok("seedMaterials 保留上一层的有无与库存", (() => {
  const s = seedMaterials([{ id: "zinc", name: "锌锭", available: false, stock: 12 }]);
  const z = s.find((m) => m.id === "zinc");
  return z.available === false && z.stock === 12;
})());

/* ================= B. 用料判定（可解释） ================= */
console.log("--- B. 订单用品判定 ---");
const need = (o) => requiredMaterialsFor(o).map((r) => r.materialId);
const pick = (re) => active.find((o) => re.test(o.productName || ""));
ok("所有订单都需要钢材（拉丝母材）", active.every((o) => need(o).includes("steel-rod")));
const zn = pick(/^镀锌(?!.*铝合金)/);
ok("镀锌订单需要锌锭", !!zn && need(zn).includes("zinc"), zn ? zn.productName : "未找到样例");
const al = pick(/铝合金/);
ok("镀锌铝合金订单需要锌铝合金、且不重复计锌锭", !!al && need(al).includes("zn-al") && !need(al).includes("zinc"), al ? al.productName : "未找到样例");
const inj = pick(/注塑|涂塑/);
ok("注塑 / 涂塑订单需要塑料", !!inj && need(inj).includes("plastic"), inj ? inj.productName : "未找到样例");
const fc = active.find((o) => (o.parsed || {}).core === "FC");
ok("纤维芯（FC）订单需要纤维芯", !!fc && need(fc).includes("fiber-core"), fc ? fc.id : "未找到样例");
const iwrc = active.find((o) => (o.parsed || {}).core === "IWRC");
ok("钢芯（IWRC）订单需要铁（低碳钢芯料）", !!iwrc && need(iwrc).includes("iron-core"), iwrc ? iwrc.id : "未找到样例");
const oiled = active.find((o) => /涂油/.test(o.coating || ""));
ok("涂油订单需要润滑油脂", !!oiled && need(oiled).includes("grease"), oiled ? oiled.id : "未找到样例");
ok("每条判定都带可读依据（不是黑箱）", requiredMaterialsFor(zn).every((r) => typeof r.reason === "string" && r.reason.length > 6));

/* ================= C. 储备统计 ================= */
console.log("--- C. 储备统计 ---");
ok("钢材用量按几何换算（1mm × 1000m ≈ 6.165 kg）", Math.abs(estimateSteelKg(1, 1000) - 6.165) < 0.01, String(estimateSteelKg(1, 1000)));
ok("直径或长度缺失时不给估算值（不编造）", estimateSteelKg(null, 1000) === null && estimateSteelKg(1, 0) === null);
const stats = computeMaterialStats(mats, active, {});
ok("统计覆盖全部材料", stats.length === mats.length);
const st = (id) => stats.find((s) => s.material.id === id);
ok("钢材影响全部 " + active.length + " 张订单", st("steel-rod").orderCount === active.length, String(st("steel-rod").orderCount));
ok("锌锭只影响镀锌订单（" + st("zinc").orderCount + " 张）", st("zinc").orderCount > 0 && st("zinc").orderCount < active.length);
ok("铜当前无订单用到，如实显示 0", st("copper").orderCount === 0, String(st("copper").orderCount));
ok("未提供消耗定额的材料不做用量估算（usage = null）", st("zinc").usage === null && st("grease").usage === null);

/* ================= D. 缺料门禁 ================= */
console.log("--- D. 缺料门禁（核心） ---");
const cap = buildCapacity(ds);
const base = engineDefaults(ds, {});
const buildWith = (patch) => {
  const list = base.materials.map((m) => (patch[m.id] === undefined ? m : { ...m, available: patch[m.id] }));
  return buildModel({ snapshot: ds, settings: { ...base, materials: list }, cap });
};
const m0 = buildWith({});
ok("默认全有货：可排 / 阻断与改造前一致（301 / 11）", m0.jobs.length === 301 && m0.blocked.length === 11,
  m0.jobs.length + " / " + m0.blocked.length);
ok("默认情况下没有任何 MAT 阻断", m0.blocked.every((b) => !b.gaps.some((g) => g.rule === "MAT")));
const m1 = buildWith({ zinc: false });
const matBlocked = m1.blocked.filter((b) => b.gaps.some((g) => g.rule === "MAT"));
ok("锌锭标为「无」：镀锌订单全部进入阻断（" + matBlocked.length + " 张）", matBlocked.length === st("zinc").orderCount,
  matBlocked.length + " vs " + st("zinc").orderCount);
ok("这些订单**不进入排产**（jobs 里没有它们）", matBlocked.every((b) => !m1.jobs.some((j) => j.order.id === b.order.id)));
ok("阻断原因写明缺哪种料与判定依据", matBlocked.every((b) => {
  const g = b.gaps.find((x) => x.rule === "MAT");
  return /锌锭/.test(g.why) && /镀锌/.test(g.why) && /材料库/.test(g.fix);
}));
ok("非镀锌订单不受影响（仍在可排列表）", m1.jobs.some((j) => j.order.id === active.find((o) => !need(o).includes("zinc")).id));
const mAll = buildWith(Object.fromEntries(base.materials.map((m) => [m.id, false])));
/* blocked 只统计未结束订单（历史订单不参与排产），因此分母是 active 而不是全部订单 */
ok("全部标为「无」：0 张可排、未结束订单全部阻断（" + active.length + " 张）", mAll.jobs.length === 0 && mAll.blocked.length === active.length,
  mAll.jobs.length + " / " + mAll.blocked.length);

/* ================= E. 真浏览器 ================= */
let chromium;
try { ({ chromium } = createRequire(import.meta.url)("playwright")); }
catch {
  console.log("");
  console.log("SKIP：未安装 playwright，真浏览器部分未执行（不计为通过）。");
  console.log("引擎部分结果：通过 " + pass + " / 失败 " + fail);
  process.exit(fail ? 1 : 0);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1680, height: 1050 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.message)));
page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
await page.goto(BASE + "/web/index.html?data=real&fresh=1", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForSelector(".g-task", { timeout: 180000 });
await page.waitForTimeout(1800);

console.log("--- E. 材料库页面 ---");
await page.locator(".nav-item[data-route=materials]").click();
await page.waitForTimeout(1500);
const pageInfo = await page.evaluate(() => {
  const v = document.querySelector("#view");
  return { fail: /页面渲染失败/.test(v.innerText), rows: v.querySelectorAll("tbody tr").length,
    text: v.innerText, hasDb: !!v.querySelector("button[data-act=openMaterialDb]") };
});
ok("材料库页面正常渲染（无渲染失败横幅）", !pageInfo.fail);
/* 默认库存 = 安全库存（用户明确要求）；否则初始是一排空格，且「低于安全库存」判据没有起点 */
const stockDefaults = await page.evaluate(() => window.__jwStore.state.settings.materials.every((m) => m.stock === m.safetyStock));
ok("库存默认取安全库存（8 种材料全部相等）", stockDefaults === true);
/* 连续输入：视图是整块重渲染，逐字重渲染会让光标回到开头，把输入变成倒序（1234 → 4321）。
   这里逐位输入并断言顺序正确，且停顿后继续输入是追加而不是插到最前。 */
const stockInput = page.locator("input[data-act=setMaterialStock][data-id=zinc]");
await stockInput.fill("");
await stockInput.type("1234", { delay: 70 });
await page.waitForTimeout(600);
const typed1 = await page.evaluate(() => ({ dom: document.querySelector("input[data-act=setMaterialStock][data-id=zinc]").value,
  state: window.__jwStore.state.settings.materials.find((m) => m.id === "zinc").stock,
  focus: document.activeElement === document.querySelector("input[data-act=setMaterialStock][data-id=zinc]") }));
ok("库存可连续输入多位数字（1234 而不是倒序 4321）", typed1.dom === "1234" && typed1.state === 1234, JSON.stringify(typed1));
ok("输入过程中不丢焦点", typed1.focus === true);
await stockInput.type("56", { delay: 70 });
await page.waitForTimeout(600);
const typed2 = await page.evaluate(() => document.querySelector("input[data-act=setMaterialStock][data-id=zinc]").value);
ok("停顿后继续输入是追加（123456 而不是 561234）", typed2 === "123456", typed2);
/* 恢复成安全库存，避免影响后面的断言 */
await stockInput.fill("800");
await page.waitForTimeout(600);
ok("材料储备表列出全部材料（8 行）", pageInfo.rows === 8, String(pageInfo.rows));
ok("提供「材料数据库」按钮", pageInfo.hasDb);
ok("页面如实标注这是产品扩展（不在 PRD D00–D07 内）", /产品扩展/.test(pageInfo.text) && /PRD D00–D07/.test(pageInfo.text));
ok("默认状态显示「原材料齐备」", /原材料齐备/.test(pageInfo.text));

console.log("--- F. 人工调节有无 → 订单标红、不排产 ---");
await page.locator("button[data-act=toggleMaterial][data-id=zinc]").click();
await page.waitForTimeout(1200);
const afterToggle = await page.evaluate(() => {
  const v = document.querySelector("#view");
  const s = window.__jwStore.state;
  return { zinc: s.settings.materials.find((m) => m.id === "zinc").available, text: v.innerText,
    dirty: !!(window.__jwStore.currentVersion && window.__jwStore.currentVersion.dirty) };
});
ok("锌锭已切换为「无」", afterToggle.zinc === false);
ok("页面立刻给出受影响订单数", /共 111 张订单被判定为异常/.test(afterToggle.text), afterToggle.text.slice(0, 80));
ok("已有计划被标记为「存在未重算的修改」（不能在缺料下直接确认）", afterToggle.dirty);

await page.locator(".nav-item[data-route=orders]").click();
await page.waitForTimeout(1500);
const orderInfo = await page.evaluate(() => {
  const rows = [...document.querySelectorAll("tr.row-block")];
  return { red: rows.length, sample: rows.length ? rows[0].innerText.replace(/\n+/g, " | ") : "" };
});
ok("订单中心把缺料订单整行标红（111 行）", orderInfo.red === 111, String(orderInfo.red));
ok("标红行里能看到缺料说明", /锌锭/.test(orderInfo.sample), orderInfo.sample);

console.log("--- G. 重新生成：缺料订单不产生任何工序任务 ---");
await page.locator(".nav-item[data-route=workbench]").click();
await page.waitForTimeout(900);
await page.locator(".tb-actions [data-act=generate]").click();
await page.waitForFunction(() => !window.__jwStore.state.solving || window.__jwStore.state.solving.status !== "running", null, { timeout: 180000 });
await page.waitForTimeout(1500);
const gen = await page.evaluate(() => {
  /* versions 是**追加**的（store.generate 用 push），[0] 是最旧的一版；
     必须读 currentVersion，否则拿到的是重算前的旧结果。 */
  const s = window.__jwStore.state; const v = window.__jwStore.currentVersion;
  const isZn = (o) => /镀锌/.test(o.productName || "") && !/铝合金/.test(o.productName || "");
  const znOrders = s.snapshot.orders.filter((o) => o.endCode !== "已结束" && isZn(o));
  const taskOrders = new Set(v.tasks.filter((t) => t.scheduled).map((t) => t.orderId));
  const leaked = znOrders.filter((o) => taskOrders.has(o.id)).map((o) => o.id);
  return { tasks: v.tasks.filter((t) => t.scheduled).length, zn: znOrders.length,
    mat: new Set(v.validation.risks.filter((r) => r.rule === "MAT").map((r) => r.orderId)).size,
    leaked: leaked.slice(0, 3), leakedN: leaked.length, dirty: !!v.dirty };
});
/* 直接对着「需要锌锭的订单」断言，而不是对着风险条数：
   111 张镀锌单里有 8 张此前就因工艺映射缺口被阻断，不会产生新的 MAT 风险，
   所以 MAT 条数会略少于 111 —— 拿 111 去卡会得到一个看起来像 bug 的假失败。 */
ok("所有需要锌锭的镀锌订单（" + gen.zn + " 张）都没有任何工序任务", gen.leakedN === 0 && gen.zn > 100,
  "泄漏 " + gen.leakedN + " 张：" + gen.leaked.join(","));
ok("缺料风险项覆盖被阻断的镀锌订单（" + gen.mat + " 张，≤ " + gen.zn + "）", gen.mat > 100 && gen.mat <= gen.zn, String(gen.mat));
ok("任务数下降（" + gen.tasks + " < 903）", gen.tasks < 903, String(gen.tasks));
ok("重算后不再处于「未重算」状态", gen.dirty === false);

console.log("--- H. 恢复有货 → 计划可逆 ---");
await page.locator(".nav-item[data-route=materials]").click();
await page.waitForTimeout(1200);
await page.locator("button[data-act=allMaterialsOn]").first().click();
await page.waitForTimeout(1000);
await page.locator(".nav-item[data-route=workbench]").click();
await page.waitForTimeout(800);
await page.locator(".tb-actions [data-act=generate]").click();
await page.waitForFunction(() => !window.__jwStore.state.solving || window.__jwStore.state.solving.status !== "running", null, { timeout: 180000 });
await page.waitForTimeout(1500);
const restored = await page.evaluate(() => {
  const v = window.__jwStore.currentVersion;
  return { tasks: v.tasks.filter((t) => t.scheduled).length, mat: v.validation.risks.filter((r) => r.rule === "MAT").length };
});
ok("恢复有货并重算后回到 903 条任务 / 0 缺料阻断", restored.tasks === 903 && restored.mat === 0,
  restored.tasks + " / " + restored.mat);

console.log("--- I. 材料数据库（目录编辑器） ---");
await page.locator(".nav-item[data-route=materials]").click();
await page.waitForTimeout(1200);
await page.locator("button[data-act=openMaterialDb]").click();
await page.waitForSelector("#matRows", { timeout: 8000 });
await page.waitForTimeout(500);
ok("材料数据库弹窗列出全部目录项", (await page.locator("#matRows tr").count()) === 8, String(await page.locator("#matRows tr").count()));
await page.locator("#addMatRow").click();
await page.waitForTimeout(300);
ok("可以新增一行材料", (await page.locator("#matRows tr").count()) === 9);
await page.locator("#matRows tr").last().locator("[data-f=name]").fill("自检用材料");
await page.locator("#matRows tr").last().locator("[data-f=unit]").fill("kg");
await page.locator("#saveMatDb").click();
await page.waitForTimeout(1200);
const saved = await page.evaluate(() => window.__jwStore.state.settings.materials.map((m) => m.name));
ok("保存后目录里出现新材料", saved.includes("自检用材料"), String(saved.length) + " 项");
ok("新材料默认有货", await page.evaluate(() => {
  const m = window.__jwStore.state.settings.materials.find((x) => x.name === "自检用材料");
  return !!m && m.available === true;
}));
/* 收尾：删掉自检材料，避免污染后续断言 */
await page.locator("button[data-act=openMaterialDb]").click();
await page.waitForSelector("#matRows", { timeout: 8000 });
await page.waitForTimeout(400);
await page.locator("#matRows tr").last().locator("[data-del]").click();
await page.waitForTimeout(300);
await page.locator("#saveMatDb").click();
await page.waitForTimeout(1000);
ok("删除后目录恢复 8 项", await page.evaluate(() => window.__jwStore.state.settings.materials.length === 8));
ok("全程无未捕获 JS 异常", errors.length === 0, errors.slice(0, 3).join(" | "));
await browser.close();

console.log("");
console.log("通过 " + pass + " / 失败 " + fail);
process.exit(fail ? 1 : 0);
