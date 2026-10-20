/* 产品定额导入：替换当前工作台使用的设备与产能数据。 */
import { html, raw, icon } from '../core/dom.js';
import { openModal } from '../components/ui.js';
import { looksLikeDeviceWorkbook, parseDeviceWorkbook } from '../data/deviceImport.js';

const MAX_BYTES = 20 * 1024 * 1024;

export function confirmDeviceReplacement(ctx) {
  openModal({
    title: '更换产品定额',
    body: html`<div class="banner warn">${raw(icon('alert', 16))}<div>导入成功后将替换当前设备与产能数据；现有方案会保留并标记为基于旧数据，需要重新生成计划。</div></div>`,
    footer: html`<button class="btn" data-act="close">取消</button><button class="btn primary" data-act="choose">选择产品定额文件</button>`,
    onMount(box, close) {
      box.querySelector('[data-act="choose"]').addEventListener('click', () => { close(); chooseFile(ctx); });
    },
  });
}

function chooseFile(ctx) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.xlsx';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (file) readFile(ctx, file);
  }, { once: true });
  input.click();
}

async function readFile(ctx, file) {
  if (file.size > MAX_BYTES) { ctx.toast('产品定额文件过大，最大支持 20 MB', 'err'); return; }
  ctx.toast('正在解析产品定额文件 ' + file.name + ' …');
  try {
    const { readXlsx } = await import('../data/xlsxReader.js');
    const parsed = await readXlsx(file);
    if (!looksLikeDeviceWorkbook(parsed)) {
      ctx.toast('未识别到产品定额所需的“拉丝、捻股、合绳”工作表', 'err');
      return;
    }
    const data = parseDeviceWorkbook(parsed);
    if (!data.machines.drawing.length || !data.machines.stranding.length || !data.machines.closing.length || !data.capacity.stranding.rows.length || !data.capacity.closing.rows.length) {
      ctx.toast('产品定额文件不完整，需包含拉丝设备、捻股与合绳产能数据', 'err');
      return;
    }
    previewImport(ctx, file.name, data);
  } catch (error) {
    ctx.toast('产品定额文件解析失败：' + String(error.message), 'err');
  }
}

function previewImport(ctx, fileName, data) {
  const s = data.stats;
  openModal({
    title: '确认导入产品定额',
    body: html`<div class="banner info mb">${raw(icon('check', 16))}<div><b>${fileName}</b> 已解析完成，将作为当前工作台的设备与产能数据。</div></div>
      <div class="grid g3"><div class="metric"><div class="k">拉丝设备</div><div class="v">${s.drawing}<small>台</small></div></div><div class="metric"><div class="k">捻股设备 / 规格</div><div class="v">${s.stranding}<small>台</small></div><div class="f">${s.strandRows} 行产能</div></div><div class="metric"><div class="k">合绳设备 / 规格</div><div class="v">${s.closing}<small>台</small></div><div class="f">${s.closingRows} 行产能</div></div></div>
      ${data.issues.length ? html`<div class="tiny muted mt">解析提示：${data.issues.join('；')}</div>` : ''}`,
    footer: html`<button class="btn" data-act="close">取消</button><button class="btn primary" data-act="apply">确认替换</button>`,
    onMount(box, close) {
      box.querySelector('[data-act="apply"]').addEventListener('click', () => {
        ctx.store.applyDeviceData({
          machines: data.machines, capacity: data.capacity,
          source: '产品定额 · ' + fileName, sourceId: 'uploaded-rated-' + Date.now(), stats: data.stats,
        });
        close();
        ctx.toast('产品定额已更新，请重新生成计划', 'ok');
        ctx.navigate('workbench');
      });
    },
  });
}
