/* D08 材料库：原材料储备统计 + 材料数据库（人工调节原材有无）
 * ---------------------------------------------------------------------------
 * 本页是**产品扩展**，不在 PRD D00–D07 的页面清单内，界面上如实标注。
 *
 * 与排产的关系（闭环）：材料库的「有无」直接参与 buildModel 的门禁 ——
 * 把某种材料标为「无」，需要它的订单立刻变成阻断（订单异常），不进入排产，也就没有后续加工步骤；
 * 恢复为「有」后重新生成计划即可照常排产。判定只用订单自身的字段，所以订单一导入就能标红。
 */
import { html, raw, icon } from "../core/dom.js";
import { section, dataTable, tag, emptyState, openModal } from "../components/ui.js";
import { fmtNum, num } from "../core/util.js";
import { computeMaterialStats, MATERIAL_CATEGORIES } from "../engine/materials.js";

export function renderMaterials(host, ctx) {
  const { snapshot, settings } = ctx;
  host.className = "view";
  if (!snapshot) { host.innerHTML = emptyState({ icon: "box", title: "尚未载入数据", desc: "先回到排产工作台上传订单文件。" }); return; }

  const materials = settings.materials || [];
  const active = snapshot.orders.filter((o) => o.endCode !== "已结束");
  /* 钢材用量估算需要单丝直径与拉丝需求量：向 store 取一次工艺映射结果；取不到就留空，不编造 */
  const wireOf = (order) => {
    const m = ctx.store.mappingOf(order.id);
    if (!m || !m.wire || !m.qty) return null;
    return { diaMm: m.wire.specMm, lengthM: m.qty.drawing };
  };
  const stats = computeMaterialStats(materials, active, { wireOf });
  const missing = stats.filter((s) => s.status === "missing");
  const lowCount = stats.filter((s) => s.status === "low").length;
  const affected = new Set();
  for (const s of missing) for (const id of s.orderIds) affected.add(id);

  const table = dataTable({
    columns: [
      { label: "材料", render: (r) => html`<div><b class="tiny">${r.material.name}</b>${r.material.note ? html`<div class="tiny2 muted">${r.material.note}</div>` : ""}</div>` },
      { label: "类别", render: (r) => tag(r.material.category, "gray"), width: "76px" },
      { label: "规格", render: (r) => html`<span class="tiny2 mono">${r.material.spec || "—"}</span>`, width: "150px" },
      { label: "库存", render: (r) => html`<span class="row" style="gap:6px"><input type="number" data-act="setMaterialStock" data-id="${r.material.id}" value="${r.material.stock == null ? "" : r.material.stock}" placeholder="—" style="width:92px" aria-label="${r.material.name} 库存量" min="0" step="10" /><span class="tiny2 muted">${r.material.unit}</span></span>`, width: "180px" },
      { label: "安全库存", render: (r) => html`<span class="tiny2">${r.material.safetyStock == null ? "—" : fmtNum(r.material.safetyStock)}</span>`, width: "92px" },
      { label: "用量估算", render: (r) => r.usage == null
        ? html`<span class="tiny2 muted" title="数据包未提供该材料的消耗定额，不做估算">未提供定额</span>`
        : html`<div><b class="tiny">${fmtNum(Math.round(r.usage))} ${r.material.unit}</b><div class="tiny2 muted">按 ${r.usageCounted} 单几何换算</div></div>`, width: "150px" },
      { label: "影响订单", render: (r) => r.orderCount ? html`<span class="tiny">${r.orderCount} 单</span>` : html`<span class="tiny2 muted">无</span>`, width: "84px" },
      { label: "状态", render: (r) => r.status === "missing" ? tag("缺料", "red", "alert") : r.status === "low" ? tag("低于安全库存", "amber", "info") : tag("有货", "green", "check"), width: "116px" },
      { label: "有无（人工调节）", render: (r) => html`<button class="btn sm ${r.material.available ? "" : "danger"}" data-act="toggleMaterial" data-id="${r.material.id}" aria-pressed="${r.material.available ? "false" : "true"}" title="默认有货；标记为「无」后需要它的订单立即变成阻断">${r.material.available ? "标记为无" : "恢复为有"}</button>`, width: "110px" },
    ],
    rows: stats, rowKey: (r) => r.material.id,
  });

  host.innerHTML = html`
    <div class="grid g5 mb">
      ${raw([["材料种类", materials.length, ""], ["有货", materials.length - missing.length, "good"],
        ["缺料", missing.length, missing.length ? "bad" : ""], ["低于安全库存", lowCount, lowCount ? "warnv" : ""],
        ["受影响订单", affected.size, affected.size ? "bad" : ""]]
        .map((c) => html`<div class="card" style="padding:10px 12px"><div class="tiny muted">${c[0]}</div>
          <div style="font-size:20px;font-weight:680;font-variant-numeric:tabular-nums" class="${c[2]}">${c[1]}</div></div>`).join(""))}
    </div>

    ${raw(section("材料储备", html`
      <div class="card-b">
        <div class="row mb">
          <button class="btn primary" data-act="openMaterialDb">${raw(icon("db", 14))}材料数据库</button>
          <button class="btn" data-act="allMaterialsOn">全部恢复为有货</button>
          <span class="spacer"></span>
          <span class="tiny2 muted">「有无」默认全部为有；只有显式标记为「无」才会阻断订单。库存与安全库存只做统计提示，不参与排产约束。</span>
        </div>
        <div class="materials-table">${raw(table)}</div>
      </div>`, { flush: true, sub: "库存默认取安全库存（可在表中直接改）；安全库存是默认建议值，请按企业台账调整；仅钢材有几何用量估算，其余材料的消耗定额数据包未提供，不做猜测" }))}

    `;
}

/* ---------------- 材料数据库（目录编辑器） ---------------- */
function openMaterialDb(ctx) {
  const s = ctx.settings;
  const list = () => (s.materials || []);
  const rowHtml = (m, i) => html`<tr data-row="${i}">
    <td><input type="text" data-f="name" value="${m.name}" aria-label="材料名称" style="width:100%" /></td>
    <td><select data-f="category" aria-label="材料类别">${raw(MATERIAL_CATEGORIES.map((c) => html`<option value="${c}"${m.category === c ? " selected" : ""}>${c}</option>`).join(""))}</select></td>
    <td><input type="text" data-f="spec" value="${m.spec || ""}" aria-label="规格" style="width:100%" /></td>
    <td><input type="text" data-f="unit" value="${m.unit || ""}" aria-label="单位" style="width:100%" /></td>
    <td><input type="number" data-f="safetyStock" value="${m.safetyStock == null ? "" : m.safetyStock}" aria-label="安全库存" style="width:100%" /></td>
    <td><input type="text" data-f="note" value="${m.note || ""}" aria-label="说明" style="width:100%" /></td>
    <td><button class="btn sm danger" data-del="1" aria-label="删除 ${m.name}">删除</button></td>
  </tr>`;
  const body = html`
    <div class="tbl-wrap" style="max-height:380px"><table class="tbl">
      <thead><tr><th style="width:170px">材料名称</th><th style="width:104px">类别</th><th style="width:130px">规格</th>
      <th style="width:62px">单位</th><th style="width:92px">安全库存</th><th>说明</th><th style="width:64px">操作</th></tr></thead>
      <tbody id="matRows">${raw(list().map(rowHtml).join(""))}</tbody>
    </table></div>
    <div class="row mt"><button class="btn sm" id="addMatRow">${raw(icon("more", 13))}新增一种材料</button>
    <span class="tiny2 muted">新增的材料默认「有货」；只有名称命中用料判定规则时才会被订单引用。</span></div>`;
  openModal({ title: "材料数据库 · 原材料目录", width: "wide", body,
    footer: html`<button class="btn" data-act="close">取消</button><button class="btn primary" id="saveMatDb">保存目录</button>`,
    onMount(box, close) {
      const cell = (label, inner) => "<td>" + inner + "</td>";
      const input = (f, label) => '<input type="text" data-f="' + f + '" aria-label="' + label + '" style="width:100%" />';
      box.querySelector("#addMatRow").addEventListener("click", () => {
        const tb = box.querySelector("#matRows");
        const tr = document.createElement("tr");
        tr.dataset.row = "new";
        tr.innerHTML = cell("材料名称", input("name", "材料名称"))
          + cell("类别", '<select data-f="category" aria-label="材料类别">' + MATERIAL_CATEGORIES.map((c) => '<option value="' + c + '">' + c + '</option>').join("") + "</select>")
          + cell("规格", input("spec", "规格")) + cell("单位", input("unit", "单位"))
          + cell("安全库存", '<input type="number" data-f="safetyStock" aria-label="安全库存" style="width:100%" />')
          + cell("说明", input("note", "说明"))
          + cell("操作", '<button class="btn sm danger" data-del="1" aria-label="删除该行">删除</button>');
        tb.appendChild(tr);
      });
      box.addEventListener("click", (e) => {
        const b = e.target.closest("[data-del]");
        if (!b) return;
        e.preventDefault();
        const tr = b.closest("tr");
        if (tr) tr.remove();
      });
      box.querySelector("#saveMatDb").addEventListener("click", () => {
        const rows = [...box.querySelectorAll("#matRows tr")];
        const next = [];
        for (const tr of rows) {
          const get = (k) => { const n = tr.querySelector('[data-f="' + k + '"]'); return n ? n.value : ""; };
          const name = String(get("name") || "").trim();
          if (!name) continue;                       // 空行直接忽略，不往目录里塞垃圾
          const idx = tr.dataset.row;
          const prev = (idx && idx !== "new") ? list()[Number(idx)] : null;
          next.push({
            id: (prev && prev.id) || ("mat-" + Date.now().toString(36) + "-" + next.length),
            name,
            category: get("category") || "金属",
            spec: String(get("spec") || "").trim() || null,
            unit: String(get("unit") || "").trim() || "kg",
            safetyStock: num(get("safetyStock")),
            note: String(get("note") || "").trim() || null,
            stock: prev ? prev.stock : null,
            available: prev ? !!prev.available : true,   // 新增材料默认有货
          });
        }
        if (!next.length) { ctx.toast("材料目录不能为空", "err"); return; }
        ctx.store.setMaterials(next);
        close();
        ctx.toast("材料目录已更新：" + next.length + " 种材料", "ok");
        ctx.rerender();
      });
    } });
}

export const MATERIAL_ACTIONS = {
  /** 人工调节原材有无：默认有货，只有显式切换才会变成「无」 */
  toggleMaterial: (ctx, node, ds) => {
    const next = (ctx.settings.materials || []).map((m) => (m.id === ds.id ? { ...m, available: !m.available } : m));
    const m = next.find((x) => x.id === ds.id);
    ctx.store.setMaterials(next);
    ctx.toast(m.name + " 已标记为「" + (m.available ? "有" : "无") + "」"
      + (m.available ? "" : "；需要它的订单将立即阻断，不进入排产"), m.available ? "ok" : "warn");
    ctx.rerender();
  },
  setMaterialStock: (ctx, node, ds) => {
    const v = node.value === "" ? null : num(node.value);
    ctx.store.setMaterials((ctx.settings.materials || []).map((m) => (m.id === ds.id ? { ...m, stock: v } : m)));
    ctx.rerender();
  },
  allMaterialsOn: (ctx) => {
    ctx.store.setMaterials((ctx.settings.materials || []).map((m) => ({ ...m, available: true })));
    ctx.toast("已把全部原材料恢复为有货", "ok");
    ctx.rerender();
  },
  openMaterialDb: (ctx) => openMaterialDb(ctx),
  gotoOrder: (ctx, node, ds) => { ctx.openOrder(ds.id); },
};
