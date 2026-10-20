/* 底层材料库：原材料目录、订单用料判定、储备统计与缺料门禁
 * ---------------------------------------------------------------------------
 * 定位（不要误读）：这是**本产品新增的扩展能力**，不属于赛题手册 R1–R10，也不在 PRD D00–D07 页面清单内，
 * 因此缺料门禁的风险标签用 MAT 而不是 R1x，界面上也明确标注「产品扩展」。
 *
 * 三条设计原则：
 *   1. **默认有货**：材料目录里的每一种材料初始 available = true，不因为「忘了登记库存」而误伤排产；
 *   2. **用料判定必须可解释**：每张订单需要哪些材料，由品名 / 规格 / 绳芯 / 涂层四个字段显式推导，
 *      每条判定都带 reason 文案，界面上能逐条看到「为什么要这种料」，不做黑箱推断；
 *   3. **缺料 = 阻断**：缺料订单进阻断清单、不进入排产（不进行后续加工步骤），
 *      并保留在交付率分母里（与 R1/R7 的处理口径一致，不静默丢单）。
 *
 * 有消耗定额的只有钢材：按单丝直径与拉丝需求量做几何换算（钢密度 7.85 g/cm³）；
 * 锌 / 铝 / 塑料 / 油脂的消耗定额数据包未提供，只统计影响订单数，**不编造用量**。
 */

/**
 * 原材料目录（可按企业台账增删改；默认全部有货）。
 *
 * 关于两个数字字段的诚实边界：
 *   · stock（库存）：**默认等于 safetyStock** —— 没填过库存时按安全库存起步，界面不出现一排空格；
 *     企业拿到真实台账后在材料库表里直接改，改完即成为人工台账值；
 *   · safetyStock（安全库存）：给出的是**默认建议值**，只用于「低于安全库存」的提示，不参与任何排产约束，
 *     界面上明确标注为建议值，请按企业实际口径调整。
 */
export const MATERIAL_CATALOG = [
  { id: "steel-rod", name: "钢材（盘条 / 钢丝）", category: "金属", spec: "按单丝直径", unit: "kg",
    safetyStock: 5000, note: "拉丝工序的母材，所有订单必需" },
  { id: "zinc", name: "锌锭", category: "金属", spec: "0# 锌锭", unit: "kg",
    safetyStock: 800, note: "镀锌类订单的镀层原料" },
  { id: "zn-al", name: "锌铝合金", category: "金属", spec: "Zn-5%Al 合金锭", unit: "kg",
    safetyStock: 200, note: "镀锌铝合金（Galfan 类）订单的镀层原料" },
  { id: "copper", name: "铜", category: "金属", spec: "阴极铜 / 铜杆", unit: "kg",
    safetyStock: 200, note: "铜镀层与铜合金件；当前订单集未用到，保留为可维护目录项" },
  { id: "iron-core", name: "铁（低碳钢芯用）", category: "金属", spec: "低碳钢盘条", unit: "kg",
    safetyStock: 500, note: "钢芯 / 钢丝芯（IWRC / WSC）用料" },
  { id: "plastic", name: "塑料（注塑 / 涂塑料）", category: "高分子", spec: "PE / PVC 粒料", unit: "kg",
    safetyStock: 300, note: "注塑钢芯（PIWRC / PWSC）与涂塑订单用料" },
  { id: "grease", name: "润滑油脂", category: "辅料", spec: "钢丝绳专用脂", unit: "kg",
    safetyStock: 150, note: "涂层为「绳涂油 / 股涂油」的订单用料" },
  { id: "fiber-core", name: "纤维芯（麻芯 / 合成纤维）", category: "辅料", spec: "剑麻 / PP 绳芯", unit: "m",
    safetyStock: 1000, note: "纤维芯（FC）订单用料" },
];

/** 材料类别（用于界面分组与统计） */
export const MATERIAL_CATEGORIES = ["金属", "高分子", "辅料"];

/**
 * 用料判定规则：每条规则说明「什么条件下需要哪种材料」。
 * predicate 只读订单的四个字段（productName / spec / coating / parsed.core），不依赖排产结果，
 * 因此订单导入后立刻就能判定，符合「导入之后若材料不存在就标红」的要求。
 */
export const REQUIREMENT_RULES = [
  { materialId: "steel-rod", test: () => true,
    reason: "所有订单都要经过拉丝工序，母材为盘条 / 钢丝" },
  { materialId: "zn-al", test: (o) => /铝合金/.test(text(o)),
    reason: "品名 / 规格含「铝合金」→ 需要锌铝合金镀层原料" },
  { materialId: "zinc", test: (o) => /镀锌/.test(text(o)) && !/铝合金/.test(text(o)),
    reason: "品名 / 规格含「镀锌」→ 需要锌锭" },
  { materialId: "plastic", test: (o) => /注塑|涂塑/.test(text(o)) || ["PIWRC", "PWSC"].includes(core(o)),
    reason: "品名含「注塑 / 涂塑」，或绳芯为注塑钢芯（PIWRC / PWSC）→ 需要塑料粒料" },
  { materialId: "grease", test: (o) => /涂油/.test(String(o && o.coating || "")),
    reason: "涂层为「涂油」→ 需要润滑油脂" },
  { materialId: "fiber-core", test: (o) => core(o) === "FC",
    reason: "绳芯为纤维芯（FC）→ 需要纤维绳芯" },
  { materialId: "iron-core", test: (o) => ["IWRC", "WSC"].includes(core(o)),
    reason: "绳芯为钢芯 / 钢丝芯（IWRC / WSC）→ 需要低碳钢芯料" },
];

function text(o) {
  if (!o) return "";
  return String(o.productName || "") + " " + String(o.spec || "");
}
function core(o) {
  const c = o && o.parsed && o.parsed.core;
  return c ? String(c).toUpperCase() : "";
}

/** 一张订单需要哪些材料（返回 [{ materialId, reason }]，按规则顺序去重） */
export function requiredMaterialsFor(order) {
  const out = [];
  const seen = new Set();
  for (const r of REQUIREMENT_RULES) {
    if (seen.has(r.materialId)) continue;
    let hit = false;
    try { hit = !!r.test(order); } catch (e) { hit = false; }
    if (!hit) continue;
    seen.add(r.materialId);
    out.push({ materialId: r.materialId, reason: r.reason });
  }
  return out;
}

/** 合并材料目录与人工调整后的状态，得到「当前生效的材料表」 */
export function resolveMaterials(catalog, overrides) {
  const ov = overrides || {};
  const base = Array.isArray(catalog) && catalog.length ? catalog : MATERIAL_CATALOG;
  return base.map((m) => {
    const o = ov[m.id] || {};
    return {
      ...m,
      /* 默认有货：只有显式设为 false 才算缺料 */
      available: o.available === undefined ? (m.available === undefined ? true : !!m.available) : !!o.available,
      /* 默认库存取安全库存（与 engine/index.js 的 seedMaterials 同一口径，避免两处漂移） */
      stock: o.stock === undefined ? (m.stock === undefined ? (m.safetyStock === undefined ? null : m.safetyStock) : m.stock) : o.stock,
      safetyStock: o.safetyStock === undefined ? m.safetyStock : o.safetyStock,
      disabled: !!o.disabled,
    };
  }).filter((m) => !m.disabled);
}

/** 钢材用量估算：单丝直径(mm) × 长度(m) → kg（钢密度 7.85 g/cm³） */
export function estimateSteelKg(wireDiaMm, lengthM) {
  const d = Number(wireDiaMm), L = Number(lengthM);
  if (!(d > 0) || !(L > 0)) return null;
  const r = d / 2;                       // mm
  const volumeMm3 = Math.PI * r * r * L * 1000;   // mm² × mm
  return (volumeMm3 * 7.85e-3) / 1000;   // g → kg
}

/**
 * 储备统计：每种材料的库存状态与受影响订单。
 * @param {Array} materials resolveMaterials() 的结果
 * @param {Array} orders 纳入范围的订单（未结束）
 * @param {object} opts { wireOf(order) → { diaMm, lengthM } | null } 用于钢材用量估算
 */
export function computeMaterialStats(materials, orders, opts) {
  const o = opts || {};
  const need = new Map();                 // materialId → { orders: [], usageKg: number }
  for (const m of materials) need.set(m.id, { orders: [], usage: 0, usageUnit: m.unit, hasUsage: false });
  for (const ord of (orders || [])) {
    for (const r of requiredMaterialsFor(ord)) {
      const slot = need.get(r.materialId);
      if (!slot) continue;
      slot.orders.push({ id: ord.id, reason: r.reason });
    }
  }
  /* 钢材用量：按单丝直径与拉丝需求量做几何换算（其余材料无消耗定额，不编造） */
  if (typeof o.wireOf === "function") {
    const slot = need.get("steel-rod");
    let total = 0, counted = 0, unknown = 0;
    for (const ord of (orders || [])) {
      const w = o.wireOf(ord);
      const kg = w ? estimateSteelKg(w.diaMm, w.lengthM) : null;
      if (kg == null) { unknown++; continue; }
      total += kg; counted++;
    }
    slot.usage = total; slot.hasUsage = true; slot.counted = counted; slot.unknown = unknown;
  }
  return materials.map((m) => {
    const slot = need.get(m.id);
    const affected = slot.orders.length;
    const low = m.stock != null && m.safetyStock != null && m.stock < m.safetyStock;
    return {
      material: m,
      orderCount: affected,
      orderIds: slot.orders.map((x) => x.id),
      usage: slot.hasUsage ? slot.usage : null,
      usageCounted: slot.counted || 0,
      usageUnknown: slot.unknown || 0,
      lowStock: low,
      status: !m.available ? "missing" : (low ? "low" : "ok"),
    };
  });
}

/**
 * 缺料门禁：返回 { ok, missing: [{ id, name, reason }] }。
 * 调用方（buildModel）把 missing 非空的订单判为阻断，不进入排产。
 */
export function checkOrderMaterials(order, materials) {
  const byId = new Map((materials || []).map((m) => [m.id, m]));
  const missing = [];
  for (const r of requiredMaterialsFor(order)) {
    const m = byId.get(r.materialId);
    if (!m) continue;                        // 目录里已删除的材料不参与门禁
    if (m.available) continue;
    missing.push({ id: m.id, name: m.name, category: m.category, reason: r.reason });
  }
  return { ok: missing.length === 0, missing };
}

/** 缺料清单（按订单汇总，供界面与导出使用） */
export function materialShortages(orders, materials) {
  const out = [];
  for (const o of (orders || [])) {
    const r = checkOrderMaterials(o, materials);
    if (!r.ok) out.push({ orderId: o.id, productName: o.productName || "", missing: r.missing });
  }
  return out;
}
