/* 截图复核：把修复后的关键界面固化到 docs/ */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.argv[2] || "http://127.0.0.1:5178";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1680, height: 1080 } });

/* 1. 空白启动：应用打开时没有任何数据（这是现在的默认首屏） */
await page.goto(BASE + "/web/index.html?fresh=1", { waitUntil: "load" });
await page.waitForTimeout(2000);
await page.screenshot({ path: resolve(ROOT, "docs/shot-blank-start.png") });
console.log("空白启动截图完成（无订单 / 无设备 / 无计划）");

/* 2. 内置快照（显式深链）下的工作台 */
await page.goto(BASE + "/web/index.html?data=real&fresh=1", { waitUntil: "load" });
await page.waitForSelector(".g-task", { timeout: 180000 });
await page.waitForTimeout(2500);
await page.screenshot({ path: resolve(ROOT, "docs/shot-workbench.png") });
console.log("workbench 截图完成");

/* 3. 抽屉 + 「依据」页签：修复前这里一点就关 */
await page.locator(".g-task").first().click();
await page.waitForSelector(".drawer", { timeout: 10000 });
await page.locator('.drawer-tabs button[data-tab="why"]').click();
await page.waitForTimeout(700);
await page.screenshot({ path: resolve(ROOT, "docs/shot-drawer-why.png") });
console.log("抽屉「依据」截图完成，抽屉仍在：" + ((await page.locator(".drawer").count()) === 1));
await page.keyboard.press("Escape");
await page.waitForTimeout(500);

/* 4. D01 数据准备（两部分齐备时的校验与规格关联） */
await page.locator('.nav-item[data-route="data"]').click();
await page.waitForTimeout(1500);
await page.screenshot({ path: resolve(ROOT, "docs/shot-dataprep.png") });
console.log("数据准备截图完成");
await browser.close();