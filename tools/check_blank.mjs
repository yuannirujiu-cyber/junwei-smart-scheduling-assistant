#!/usr/bin/env node
/* 空白启动 → 上传源文件 → 装配 → 排产 的端到端回归（Playwright + Chromium）
 * ---------------------------------------------------------------------------
 * 这个脚本守住三件事，每一条都能在缺陷复现时变红：
 *   1) 应用打开时必须是**空白**的：没有订单、没有设备、没有任务、没有版本；
 *   2) 上传真实源文件（订单信息.xlsx + 产品额定（平均值）.xlsx）后必须能建立快照并排产；
 *   3) 【关键】「界面导入」与「预置快照 data/dataset.json」必须给出**完全相同的任务集合与指标**。
 *      两者分别由 JS（engine/spec.parseSpec + data/deviceImport）与 Python（tools/build_dataset.py）
 *      解析同一份 Excel；任何一边漂移，这里就会红。历史上正是这条断言抓出了两个真实缺陷：
 *        · deviceImport 丢弃重复 (品名,规格) 行，没有回填空缺单元格 → 机台被误判为不适配；
 *        · parseSpec 不支持「股数带字母后缀」（35W*K7）→ 104 张订单的股数/丝数为空，需求量全错。
 * 用法：node tools/check_blank.mjs [baseUrl]
 * 未安装 playwright 时打印 SKIP 并以 0 退出（不计为通过）。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname, join } from "node:path";
import { createRequire } from "node:module";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.argv[2] || "http://127.0.0.1:5178";
const PKG = process.env.HACK_PKG || resolve(ROOT, "..", "黑客松数据包");
const ORDERS_XLSX = join(PKG, "订单信息.xlsx");
const DEVICE_XLSX = join(PKG, "产品额定（平均值）.xlsx");

let pass = 0, fail = 0;
const ok = (n, c, e = "") => { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.log("  ✗ " + n + (e ? " :: " + e : "")); } };

/* ================= 第一节：解析器等价（不需要浏览器） =================
   直接拿 data/dataset.json 里 323 张订单的 spec 重新走 JS 解析器，
   与快照中由 Python 产出的 parsed 逐字段比对。 */
async function specParity() {
  const { parseSpec } = await import("../web/src/engine/spec.js");
  const ds = JSON.parse(readFileSync(join(ROOT, "data", "dataset.json"), "utf8"));
  const FIELDS = ["parseOk", "diameterMm", "diameterRaw", "grade", "lay", "structure", "strandCount", "strandConstruction", "core"];
  let cells = 0, diff = 0;
  const samples = [];
  for (const o of ds.orders) {
    const got = parseSpec(o.spec);
    for (const f of FIELDS) {
      cells++;
      if (JSON.stringify(got[f]) !== JSON.stringify(o.parsed[f])) {
        diff++;
        if (samples.length < 6) samples.push(o.id + " " + f + ": 快照=" + JSON.stringify(o.parsed[f]) + " 解析=" + JSON.stringify(got[f]) + " (" + o.spec + ")");
      }
    }
  }
  console.log("--- 规格解析：JS parseSpec ≡ Python parse_spec（" + ds.orders.length + " 张订单 × " + FIELDS.length + " 字段）---");
  ok("逐字段完全一致（" + cells + " 格）", diff === 0, samples.join(" | "));
  return { orders: ds.orders.length, cells, diff };
}

await specParity();
console.log("");

/* ================= 第二节：真浏览器端到端 ================= */

let chromium;
try { ({ chromium } = createRequire(import.meta.url)("playwright")); }
catch {
  console.log("");
  console.log("SKIP：未安装 playwright，真浏览器部分未执行（不计为通过）。");
  console.log("静态部分结果：通过 " + pass + " / 失败 " + fail);
  process.exit(fail ? 1 : 0);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 1050 } });
const errors = [];
page.on("pageerror", e => errors.push("pageerror: " + e.message));
page.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });

const state = () => page.evaluate(() => {
  const s = window.__jwStore.state; const v = s.versions[0];
  return { route: s.ui.route, datasetKey: s.datasetKey, orders: s.snapshot ? s.snapshot.orders.length : -1,
    draw: s.snapshot ? s.snapshot.machines.drawing.length : -1,
    devices: s.snapshot ? (s.snapshot.machines.drawing.length + s.snapshot.machines.stranding.length + s.snapshot.machines.closing.length) : -1,
    versions: s.versions.length, tasks: v ? v.tasks.length : 0,
    rate: v ? v.metrics.deliveryRate : null, blocks: v ? v.validation.counts.block : null,
    fingerprint: v ? v.tasks.map(t => [t.orderId, t.process, t.machineId, t.start, t.end].join("~")).sort().join("\n") : "" };
});

const uploadDevice = async () => {
  await page.locator("#deviceFileInput").setInputFiles(DEVICE_XLSX);
  await page.waitForSelector("[data-act=confirmDevice]", { timeout: 60000 });
  await page.locator("[data-act=confirmDevice]").click();
  await page.waitForTimeout(2000);
};
const uploadOrders = async () => {
  await page.locator("#fileInput").setInputFiles(ORDERS_XLSX);
  await page.waitForSelector("[data-act=confirmMap]", { timeout: 60000 });
  await page.locator("[data-act=confirmMap]").click();
};
const waitSolved = () => page.waitForFunction(() => window.__jwStore.state.versions.length > 0, null, { timeout: 180000 });

/* ---- 1. 空白启动 ---- */
await page.goto(BASE + "/web/index.html?fresh=1", { waitUntil: "load" });
await page.waitForTimeout(1500);
let st = await state();
console.log("--- 空白启动（不预置任何数据）---");
ok("打开页面即停在「数据准备」而不是工作台", st.route === "data", "route=" + st.route);
ok("没有订单", st.orders === 0, "orders=" + st.orders);
ok("没有设备", st.devices === 0, "devices=" + st.devices);
ok("没有排产版本", st.versions === 0, "versions=" + st.versions);
ok("甘特图上没有任务条", (await page.locator(".g-task").count()) === 0);
ok("页面上没有既成的交付指标", !(await page.locator("text=预测准时交付率").count()));
ok("显示上传向导：订单槽", (await page.locator("#dropzone").count()) === 1);
ok("显示上传向导：设备 / 产能槽", (await page.locator("#dropzoneDevice").count()) === 1);
ok("显示上传向导：.json 快照入口", (await page.locator("#jsonFileInput").count()) === 1);
const blankText = await page.locator("#view").innerText();
ok("明确写出「还缺少：订单文件、设备 / 产能文件」", blankText.includes("还缺少") && blankText.includes("订单文件") && blankText.includes("设备 / 产能文件"), blankText.slice(0, 80));
ok("内置快照只作为显式按钮存在（不是默认路径）", blankText.includes("内置数据快照"));
ok("顶栏未生成计划时禁用确认 / 导出", await page.locator("[data-act=confirm]").isDisabled() && await page.locator("[data-act=export]").isDisabled());

/* ---- 2. 只上传订单：不得排产 ---- */
console.log("--- 只上传订单时不得排产（不拿半份数据出计划）---");
await uploadOrders();
await page.waitForTimeout(2500);
st = await state();
ok("订单已解析入库", st.orders > 300, "orders=" + st.orders);
ok("仍然没有设备", st.devices === 0, "devices=" + st.devices);
ok("没有生成任何排产版本", st.versions === 0, "versions=" + st.versions);
const halfText = await page.locator("#view").innerText();
ok("提示还缺「设备 / 产能文件」，订单部分显示已就位", halfText.includes("还缺少") && halfText.includes("设备 / 产能文件") && halfText.includes("已就位"), halfText.slice(0, 120));
ok("订单槽显示已就位的真实行数", /[0-9]+ 条订单/.test(halfText));

/* ---- 3. 补上设备：自动装配并排产 ---- */
console.log("--- 补上设备 / 产能文件后自动建快照并排产 ---");
await uploadDevice();
await waitSolved();
await page.waitForTimeout(2500);
const imported = await state();
ok("自动切换到了排产工作台", imported.route === "workbench", "route=" + imported.route);
ok("设备台账为真实数据（47 + 51 + 11 = 109 台）", imported.devices === 109, "devices=" + imported.devices);
ok("生成了首排候选计划", imported.versions === 1 && imported.tasks > 0, "versions=" + imported.versions + " tasks=" + imported.tasks);
ok("页面上出现了甘特任务条", (await page.locator(".g-task").count()) > 0, String(await page.locator(".g-task").count()));
ok("页面显示交付指标", (await page.locator("#view").innerText()).includes("准时"));
const dsName = await page.evaluate(() => window.__jwStore.state.snapshot.meta.name);
ok("数据快照标注为导入来源，而非内置快照", /导入/.test(dsName), dsName);

/* ---- 4. 关键：与内置快照完全等价 ---- */
console.log("--- 关键：界面导入 ≡ 预置快照（同一份 Excel，两条解析路径）---");
await page.goto(BASE + "/web/index.html?data=real&fresh=1", { waitUntil: "load" });
await waitSolved();
await page.waitForTimeout(2500);
const builtin = await state();
ok("订单数一致", imported.orders === builtin.orders, imported.orders + " vs " + builtin.orders);
ok("设备数一致", imported.devices === builtin.devices, imported.devices + " vs " + builtin.devices);
ok("任务条数一致", imported.tasks === builtin.tasks, imported.tasks + " vs " + builtin.tasks);
ok("准时交付率一致", imported.rate === builtin.rate, imported.rate + " vs " + builtin.rate);
ok("阻断项数一致", imported.blocks === builtin.blocks, imported.blocks + " vs " + builtin.blocks);
const ia = imported.fingerprint.split("\n"), ib = builtin.fingerprint.split("\n");
const setB = new Set(ib);
const onlyImported = ia.filter(x => !setB.has(x));
const setA = new Set(ia);
const onlyBuiltin = ib.filter(x => !setA.has(x));
ok("任务集合完全相同（订单 × 工序 × 机台 × 起止）", onlyImported.length === 0 && onlyBuiltin.length === 0,
  "仅导入侧 " + onlyImported.length + " 条 / 仅快照侧 " + onlyBuiltin.length + " 条： " + onlyImported.slice(0, 2).join(" , "));

/* ---- 5. 反序上传（设备 → 订单）同样收敛 ---- */
console.log("--- 反序上传：先设备后订单 ---");
await page.goto(BASE + "/web/index.html?fresh=1", { waitUntil: "load" });
await page.waitForTimeout(1200);
await uploadDevice();
st = await state();
ok("只上传设备后仍不排产", st.versions === 0 && st.devices === 109, "versions=" + st.versions + " devices=" + st.devices);
await uploadOrders();
await waitSolved();
await page.waitForTimeout(2000);
const reversed = await state();
ok("补上订单后同样得到完整计划", reversed.tasks === builtin.tasks, reversed.tasks + " vs " + builtin.tasks);
ok("反序上传结果与内置快照一致", reversed.fingerprint === builtin.fingerprint);

/* ---- 6. .json 数据快照导入（含拒绝非法文件） ---- */
console.log("--- 导入 .json 数据快照 ---");
await page.goto(BASE + "/web/index.html?fresh=1", { waitUntil: "load" });
await page.waitForTimeout(1200);
const badJson = join(ROOT, "data", "spec-derivation.json");
await page.locator("#jsonFileInput").setInputFiles(badJson);
await page.waitForTimeout(900);
const badText = await page.locator("#importStatus").innerText();
ok("结构不符的 .json 被拒绝并给出可读原因", badText.includes("缺少必需字段") || badText.includes("导入失败"), badText.slice(0, 90));
st = await state();
ok("被拒绝的文件不产生任何快照", st.orders === 0 && st.versions === 0, JSON.stringify(st).slice(0, 100));
await page.locator("#jsonFileInput").setInputFiles(join(ROOT, "data", "dataset.json"));
await waitSolved();
await page.waitForTimeout(2000);
const fromJson = await state();
ok("合法快照导入后直接得到计划", fromJson.tasks === builtin.tasks, fromJson.tasks + " vs " + builtin.tasks);
ok("导入的 .json 与内置数据集完全一致", fromJson.fingerprint === builtin.fingerprint);

/* ---- 7. 回到空白 ---- */
console.log("--- 回到空白工作台 ---");
await page.locator("[data-act=nav][data-route=data]").first().click();
await page.waitForTimeout(1200);
await page.locator("[data-act=startBlank]").first().click();
await page.waitForTimeout(700);
await page.locator("[data-act=doBlank]").click();
await page.waitForTimeout(1500);
st = await state();
ok("确认清空后回到空白", st.orders === 0 && st.devices === 0 && st.versions === 0, JSON.stringify(st).slice(0, 140));
ok("回到空白后仍然停在数据准备页", st.route === "data", "route=" + st.route);

ok("全程无未捕获 JS 异常", errors.length === 0, errors.slice(0, 3).join(" | "));
await browser.close();

console.log("");
console.log("通过 " + pass + " / 失败 " + fail);
process.exit(fail ? 1 : 0);