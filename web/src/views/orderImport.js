import { html, raw, icon, qs } from '../core/dom.js';
import { openModal } from '../components/ui.js';
import { fmtDate, fmtDateTime, num, round, toDate } from '../core/util.js';
import { normKey, parseSpec } from '../engine/spec.js';

const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
const TARGET_FIELDS = [
  { key: 'id', label: '订单号', aliases: ['项目编号', '订单号'] },
  { key: 'internalNo', label: '内部订单单号', aliases: ['内部订单单号-序号-次序号', '内部订单单号'] },
  { key: 'spec', label: '规格', aliases: ['规格'] }, { key: 'productName', label: '品名', aliases: ['品名'] },
  { key: 'qtyMeters', label: '业务数量', aliases: ['业务数量'] }, { key: 'qtyMetersUnit', label: '业务单位', aliases: ['业务单位'] },
  { key: 'qtyKg', label: '计价数量', aliases: ['计价数量'] }, { key: 'qtyKgUnit', label: '计价单位', aliases: ['计价单位'] },
  { key: 'orderDate', label: '订单日期', aliases: ['订单日期'] }, { key: 'preShipDate', label: '预发货日', aliases: ['预发货日'] },
  { key: 'preArrivalDate', label: '预到货日', aliases: ['预到货日'] }, { key: 'endCode', label: '结束码', aliases: ['结束码'] },
  { key: 'coating', label: '涂层', aliases: ['涂层'] },
];

const fmtSize = n => n < 1024 ? n + ' B' : n < 1024 * 1024 ? round(n / 1024, 1) + ' KB' : round(n / 1048576, 1) + ' MB';

export function mountOrderImport(host, ctx) {
  const input = qs('#workbenchOrderFile', host);
  if (input) input.addEventListener('change', () => { if (input.files[0]) handleFile(ctx, input.files[0]); input.value = ''; });
}

export function openOrderFilePicker(host) {
  qs('#workbenchOrderFile', host)?.click();
}

async function handleFile(ctx, file) {
  if (file.size > MAX_IMPORT_BYTES) {
    ctx.toast('文件过大：' + file.name + ' 为 ' + fmtSize(file.size) + '，上限为 ' + fmtSize(MAX_IMPORT_BYTES), 'err');
    return;
  }
  ctx.toast('正在解析订单文件 ' + file.name + ' …');
  try {
    const mod = await import('../data/xlsxReader.js');
    const parsed = /\.csv$/i.test(file.name) ? await mod.readCsv(file) : await mod.readXlsx(file);
    const sheet = parsed.sheets[0], headers = sheet.rows[0] || [];
    openMappingModal(ctx, file, sheet, headers, mod.guessColumnMapping?.(headers, TARGET_FIELDS) || {});
  } catch (error) {
    ctx.toast('订单文件解析失败：' + String(error.message), 'err');
  }
}

function openMappingModal(ctx, file, sheet, headers, mapping) {
  const body = html`<div class="banner info mb">${raw(icon('info', 15))}<div>工作表 <b>${sheet.name}</b> · ${sheet.rows.length - 1} 行数据 · ${headers.length} 列。请确认字段映射。</div></div>
    <div class="tbl-wrap" style="max-height:380px"><table class="tbl"><thead><tr><th>目标字段</th><th>原列名</th><th>样例值</th></tr></thead><tbody>
    ${raw(TARGET_FIELDS.map(f => { const idx = mapping[f.key] ?? -1, sample = idx >= 0 ? sheet.rows[1]?.[idx] : ''; return html`<tr><td class="tiny">${f.label}${['id','spec','qtyMeters','preShipDate'].includes(f.key) ? ' <span class="tag red sm">必需</span>' : ''}</td><td><select data-map="${f.key}"><option value="-1">（未映射）</option>${raw(headers.map((h,i) => html`<option value="${i}"${i === idx ? ' selected' : ''}>${String(h ?? '')}</option>`).join(''))}</select></td><td class="tiny muted">${sample == null ? '—' : String(sample).slice(0,40)}</td></tr>`; }).join(''))}
    </tbody></table></div>`;
  openModal({ title: '字段映射 · ' + file.name, width: 'wide', body,
    footer: html`<button class="btn" data-act="close">取消</button><button class="btn primary" data-act="confirmMap">确认映射并建立快照</button>`,
    onMount(box, close) {
      box.querySelector('[data-act="confirmMap"]').addEventListener('click', () => {
        const map = {}; box.querySelectorAll('[data-map]').forEach(sel => { map[sel.dataset.map] = Number(sel.value); });
        const required = ['id', 'spec', 'qtyMeters', 'preShipDate'], missing = required.filter(k => map[k] < 0);
        if (missing.length) { ctx.toast('必需字段未映射：' + missing.map(k => TARGET_FIELDS.find(f => f.key === k).label).join('、'), 'err'); return; }
        buildSnapshot(ctx, sheet, map, file.name); close();
      });
    } });
}

function buildSnapshot(ctx, sheet, map, fileName) {
  const wasComplete = ctx.store.intakeStatus().ready, get = (row, key) => map[key] >= 0 ? row[map[key]] : null, orders = [];
  for (let rowNo = 1; rowNo < sheet.rows.length; rowNo++) {
    const row = sheet.rows[rowNo]; if (!row || row.every(v => v == null || v === '')) continue;
    const id = String(get(row, 'id') ?? '').trim(); if (!id) continue;
    const date = value => { const d = toDate(value); return d ? fmtDate(d) : null; };
    const order = { id, internalNo: get(row,'internalNo') == null ? null : String(get(row,'internalNo')).trim() || null,
      productName: get(row,'productName'), spec: get(row,'spec'), coating: get(row,'coating'),
      qtyMeters: num(get(row,'qtyMeters')), qtyMetersUnit: get(row,'qtyMetersUnit') || '米', qtyKg: num(get(row,'qtyKg')), qtyKgUnit: get(row,'qtyKgUnit') || 'Kg',
      orderDate: date(get(row,'orderDate')), preShipDate: date(get(row,'preShipDate')), preArrivalDate: date(get(row,'preArrivalDate')),
      endCode: String(get(row,'endCode') || '未结束').trim(), lastShipDate: null, wireSpecHint: null };
    order.parsed = parseSpec(order.spec); order.mappingKey = normKey(order.spec); order.matchStatus = 'unknown'; order.mappingCandidates = [];
    orders.push(order);
  }
  const snap = ctx.snapshot;
  const dataset = { meta: { id: 'imported-' + Date.now(), name: '导入快照 · ' + fileName, source: [fileName], generatedAt: fmtDateTime(new Date()), orderCount: orders.length, note: '由排产工作台导入的订单文件' },
    orders, machines: snap.machines, capacity: snap.capacity, specIndex: snap.specIndex };
  /* 每次导入都是新的订单快照。这样已有版本会被保留并明确标成「基于旧数据」，
     不会把旧任务表误用于刚上传的订单。 */
  ctx.afterImport(dataset, dataset.meta.id, { autoSettle: !wasComplete });
}
