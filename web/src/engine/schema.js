/* 数据契约（DATA CONTRACT）——排产数据集的结构定义与校验
   1) DATASET_SCHEMA：JSON Schema draft-07，纯 JS 对象字面量，零依赖、零 CDN；
   2) validateAgainstSchema(schema, value)：够用即可的 draft-07 子集校验器
      （type / required / properties / additionalProperties / items / enum / const /
        minimum / exclusiveMinimum / maximum / minLength / maxLength / pattern /
        minItems / maxItems / anyOf / $ref），支持 $ref 指向 #/definitions/*；
   3) validateDataset(obj)：结构层（schema）+ 语义层（重复主键、矩阵行列对齐、
      空值语义 null=不适配、规格可解析性、工艺链与设备分组对应）两层校验，
      返回 { ok, errors, warnings, stats }，每条含 path / expected / actual / message / code。

   口径约定（重要）：
   - errors 非空 = 数据不可安全构建模型（缺表、类型错、主键重复、矩阵行列不对齐…）；
   - warnings = 数据缺口（缺数量 / 缺交期 / 规格无法解析 / 矩阵空值…），
     引擎会把它降级成「阻断订单」并给出可读原因，绝不静默丢单或补默认值；
   - 产能矩阵的空值（null / 0）语义是「不适配」，不是「产能为 0」，更不是「可用」。 */
import { parseSpec } from './spec.js';
import { resolveProcessChain } from './chain.js';

export const SCHEMA_VERSION = '1.0.0';
export const DATASET_SCHEMA_ID = 'junwei-scheduler/dataset.schema.json';

export const DATASET_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: DATASET_SCHEMA_ID,
  title: '排产数据集（Scheduling Dataset）',
  description: '订单 + 设备台账 + 产能矩阵 + 规格索引。默认工艺链为拉丝/捻股/合绳，可用 processChain 覆盖。',
  type: 'object',
  required: ['orders', 'machines', 'capacity'],
  properties: {
    meta: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        source: { type: 'array', items: { type: 'string' } },
        generatedAt: { type: 'string' },
        orderCount: { type: 'integer', minimum: 0 },
        note: { type: 'string' },
        issues: { type: 'array', items: { type: 'string' } },
        processChain: { $ref: '#/definitions/processChain' },
      },
      additionalProperties: true,
    },
    processChain: { $ref: '#/definitions/processChain' },
    orders: { type: 'array', items: { $ref: '#/definitions/order' } },
    machines: {
      type: 'object',
      properties: {
        drawing: { $ref: '#/definitions/machineList' },
        stranding: { $ref: '#/definitions/machineList' },
        closing: { $ref: '#/definitions/machineList' },
      },
      additionalProperties: { $ref: '#/definitions/machineList' },
    },
    capacity: { type: 'object', additionalProperties: { $ref: '#/definitions/matrix' } },
    specIndex: { type: ['object', 'null'] },
    simulationPresets: { type: ['object', 'null'] },
  },
  definitions: {
    processChain: {
      type: 'array', minItems: 1,
      items: {
        type: 'object',
        required: ['key'],
        properties: {
          key: { type: 'string', minLength: 1, pattern: '^[^\\s:,]+$' },
          name: { type: 'string' },
          short: { type: 'string' },
          desc: { type: 'string' },
          machinePrefixes: { type: 'array', items: { type: ['string', 'number'] } },
          machinePrefix: { type: ['string', 'number'] },
          capability: {
            type: 'object',
            required: ['kind'],
            properties: {
              kind: { type: 'string', enum: ['specRange', 'matrix'] },
              matrix: { type: 'string', minLength: 1 },
              specField: { type: 'string' },
              minField: { type: 'string' },
              maxField: { type: 'string' },
              speedField: { type: 'string' },
            },
            additionalProperties: true,
          },
          changeover: {
            type: 'object',
            properties: {
              dims: {
                type: 'array', minItems: 1,
                items: {
                  type: 'object', required: ['field'],
                  properties: {
                    field: { type: 'string', minLength: 1 },
                    label: { type: 'string' },
                    unit: { type: 'string' },
                    numeric: { type: 'boolean' },
                  },
                  additionalProperties: true,
                },
              },
            },
            additionalProperties: true,
          },
          qty: {
            type: 'object',
            properties: {
              from: { type: ['string', 'null'] },
              by: { type: ['string', 'null'] },
              factor: { type: ['number', 'null'] },
              factorModel: { type: ['string', 'null'] },
            },
            additionalProperties: true,
          },
          waitLimitHours: { type: 'number', exclusiveMinimum: 0 },
        },
        additionalProperties: true,
      },
    },
    order: {
      type: 'object',
      required: ['id', 'spec', 'qtyMeters', 'preShipDate'],
      properties: {
        id: { type: 'string', minLength: 1 },
        spec: { type: 'string', minLength: 1 },
        qtyMeters: { type: ['number', 'null'], exclusiveMinimum: 0, description: '订单米数，必须为正数；null 表示缺失 → 该订单被阻断（不按 0 处理）' },
        qtyMetersUnit: { type: 'string' },
        preShipDate: { type: ['string', 'null'], description: '预发货日（交期）；null 表示缺失，订单会被阻断' },
        orderDate: { type: ['string', 'null'] },
        endCode: { type: 'string' },
        priority: { type: 'string' },
        duePolicy: { type: 'string', enum: ['hard', 'soft', 'unknown'] },
        graceHours: { type: ['number', 'null'], minimum: 0 },
        processMap: { type: ['object', 'null'] },
        processSpecs: { type: ['object', 'null'] },
        parsed: { type: ['object', 'null'] },
        mappingKey: { type: ['string', 'null'] },
        productName: { type: ['string', 'null'] },
        coating: { type: ['string', 'null'] },
        qtyKg: { type: ['number', 'null'] },
        rush: { type: ['boolean', 'null'] },
        locked: { type: ['boolean', 'null'] },
      },
      additionalProperties: true,
    },
    machineList: { type: 'array', items: { $ref: '#/definitions/machine' } },
    machine: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: ['string', 'number'] },
        name: { type: 'string' },
        type: { type: 'string' },
        specMin: { type: ['number', 'null'] },
        specMax: { type: ['number', 'null'] },
        specRangeRaw: { type: 'string' },
        speedMps: { type: ['number', 'null'] },
        downtime: { type: 'array' },
      },
      additionalProperties: true,
    },
    matrix: {
      type: 'object',
      required: ['machineIds', 'rows'],
      properties: {
        model: { type: 'string' },
        unit: { type: 'string' },
        machineIds: { type: 'array', items: { type: ['string', 'number'] } },
        coefficients: { type: 'array', items: { type: 'number' } },
        rows: { type: 'array', items: { $ref: '#/definitions/matrixRow' } },
      },
      additionalProperties: true,
    },
    matrixRow: {
      type: 'object',
      required: ['spec'],
      properties: {
        name: { type: 'string' },
        spec: { type: 'string', minLength: 1 },
        torsion: { type: ['number', 'null'] },
        rates: { type: 'array', items: { type: ['number', 'null'] } },
        caps: { type: 'array', items: { type: ['string', 'number'] } },
        capCount: { type: 'integer', minimum: 0 },
      },
      additionalProperties: true,
    },
  },
};

/* ==================================================================
   轻量 JSON Schema（draft-07 子集）校验器
   ================================================================== */
export function validateAgainstSchema(schema, value, options = {}) {
  const errors = [];
  const maxErrors = num(options.maxErrors, 500);
  const root = schema;

  function resolveRef(ref) {
    if (typeof ref !== 'string' || ref.charAt(0) !== '#') return null;
    const parts = ref.slice(1).split('/').filter(Boolean)
      .map(p => p.replace(/~1/g, '/').replace(/~0/g, '~'));
    let node = root;
    for (const p of parts) {
      if (node == null || typeof node !== 'object') return null;
      node = node[p];
    }
    return node && typeof node === 'object' ? node : null;
  }

  function push(path, expected, actual, message, code) {
    if (errors.length < maxErrors) errors.push({ path, expected, actual: preview(actual), message, code: code || 'SCHEMA' });
  }

  function walk(node, val, path) {
    if (!node || typeof node !== 'object') return;
    if (node.$ref) { const r = resolveRef(node.$ref); if (r) walk(r, val, path); return; }
    if (Array.isArray(node.anyOf)) {
      const okAny = node.anyOf.some(sub => {
        const saved = errors.slice();
        errors.length = 0;
        walk(sub, val, path);
        const pass = errors.length === 0;
        errors.length = 0;
        errors.push(...saved);
        return pass;
      });
      if (!okAny) push(path, '满足任一子模式', val, '不满足 anyOf 中的任何子模式');
      return;
    }
    if (node.type != null) {
      const types = Array.isArray(node.type) ? node.type : [node.type];
      if (!types.some(t => matchesType(val, t))) {
        push(path, '类型 ' + types.join(' | '), val, '字段类型不符合数据契约');
        return;
      }
    }
    if (node.const !== undefined && val !== node.const) push(path, String(node.const), val, '取值必须等于常量');
    if (Array.isArray(node.enum) && node.enum.indexOf(val) < 0) push(path, '枚举 ' + JSON.stringify(node.enum), val, '取值不在允许的枚举内');
    if (typeof val === 'string') {
      if (node.minLength != null && val.length < node.minLength) push(path, '长度 ≥ ' + node.minLength, val, '字符串过短（不能为空）');
      if (node.maxLength != null && val.length > node.maxLength) push(path, '长度 ≤ ' + node.maxLength, val, '字符串过长');
      if (typeof node.pattern === 'string') {
        let re = null;
        try { re = new RegExp(node.pattern); } catch (e) { re = null; }
        if (re && !re.test(val)) push(path, '匹配 ' + node.pattern, val, '字符串格式不符合数据契约');
      }
    }
    if (typeof val === 'number') {
      if (node.minimum != null && val < node.minimum) push(path, '≥ ' + node.minimum, val, '数值小于下限');
      if (node.maximum != null && val > node.maximum) push(path, '≤ ' + node.maximum, val, '数值大于上限');
      if (node.exclusiveMinimum != null && !(val > node.exclusiveMinimum)) push(path, '> ' + node.exclusiveMinimum, val, '数值必须大于下限（数量/耗时必须为正）');
      if (node.exclusiveMaximum != null && !(val < node.exclusiveMaximum)) push(path, '< ' + node.exclusiveMaximum, val, '数值必须小于上限');
      if (node.multipleOf != null && node.multipleOf > 0 && Math.abs(val / node.multipleOf - Math.round(val / node.multipleOf)) > 1e-9) push(path, node.multipleOf + ' 的整数倍', val, '不是指定倍数');
    }
    if (Array.isArray(val)) {
      if (node.minItems != null && val.length < node.minItems) push(path, '至少 ' + node.minItems + ' 项', val, '数组项数不足');
      if (node.maxItems != null && val.length > node.maxItems) push(path, '至多 ' + node.maxItems + ' 项', val, '数组项数过多');
      if (node.items) val.forEach((x, i) => walk(node.items, x, path + '[' + i + ']'));
    } else if (val && typeof val === 'object') {
      const props = (node.properties && typeof node.properties === 'object') ? node.properties : {};
      if (Array.isArray(node.required)) {
        for (const k of node.required) {
          if (!(k in val) || val[k] === undefined) push(joinPath(path, k), '必填字段（' + typeLabel(props[k]) + '）', undefined, '缺少必填字段「' + k + '」', 'REQUIRED');
        }
      }
      for (const k of Object.keys(props)) if (k in val && val[k] !== undefined) walk(props[k], val[k], joinPath(path, k));
      const ap = node.additionalProperties;
      if (ap !== undefined && ap !== true) {
        for (const k of Object.keys(val)) {
          if (k in props) continue;
          if (ap === false) push(joinPath(path, k), '未声明的字段', val[k], '出现了 schema 未允许的字段', 'ADDITIONAL');
          else walk(ap, val[k], joinPath(path, k));
        }
      }
    }
  }

  walk(schema, value, '');
  return { ok: errors.length === 0, errors };
}

/* ==================================================================
   数据集校验：结构层 + 语义层
   ================================================================== */
export function validateDataset(obj, options = {}) {
  const errors = [], warnings = [];
  const maxErrors = num(options.maxErrors, 500);
  const maxWarnings = num(options.maxWarnings, 200);
  const stats = { orders: 0, machines: {}, matrices: {}, chainKeys: [], hasSpecIndex: false, processChainSource: 'default' };
  const err = (path, expected, actual, message, code) => { if (errors.length < maxErrors) errors.push({ path, expected: String(expected), actual: preview(actual), message, code: code || 'DATA' }); };
  const warn = (path, expected, actual, message, code) => { if (warnings.length < maxWarnings) warnings.push({ path, expected: String(expected), actual: preview(actual), message, code: code || 'DATA_GAP' }); };

  if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) {
    err('$', 'dataset 对象', obj, '数据集必须是非空 JSON 对象（实际 ' + typeName(obj) + '）', 'DATASET_TYPE');
    return { ok: false, errors, warnings, stats };
  }

  /* ---------- 1. 结构层 ---------- */
  const s = validateAgainstSchema(DATASET_SCHEMA, obj, { maxErrors });
  for (const e of s.errors) errors.push(e);
  stats.hasSpecIndex = !!(obj.specIndex && typeof obj.specIndex === 'object');

  /* ---------- 2. 语义层：订单 ---------- */
  const orders = Array.isArray(obj.orders) ? obj.orders : [];
  stats.orders = orders.length;
  if (!orders.length) warn('orders', '至少 1 张订单', orders.length, '订单表为空：可以建模，但不会产出任何任务', 'EMPTY_ORDERS');
  const idSeen = new Map();
  orders.forEach((o, i) => {
    const at = 'orders[' + i + ']';
    if (!o || typeof o !== 'object' || Array.isArray(o)) return;
    if (o.id != null) {
      const key = String(o.id);
      const n = (idSeen.get(key) || 0) + 1;
      idSeen.set(key, n);
      if (n > 1) err(at + '.id', '唯一订单号', o.id, '订单号重复（第 ' + n + ' 次出现），排产会产生同 id 幽灵任务', 'DUPLICATE_ORDER_ID');
    }
    if (o.qtyMeters == null) warn(at + '.qtyMeters', 'number > 0', o.qtyMeters, '数量缺失：该订单会被阻断（R7），不会静默按 0 处理', 'QTY_MISSING');
    if (o.preShipDate == null || o.preShipDate === '') warn(at + '.preShipDate', '交期日期字符串', o.preShipDate, '交期缺失：该订单会被阻断（R7）', 'DUE_MISSING');
    else if (!isDateLike(o.preShipDate)) warn(at + '.preShipDate', '可解析日期（YYYY-MM-DD 或带时间）', o.preShipDate, '交期无法解析：该订单会被阻断', 'DUE_UNPARSED');
    if (o.orderDate != null && o.orderDate !== '' && !isDateLike(o.orderDate)) warn(at + '.orderDate', '可解析日期', o.orderDate, '订单日期无法解析，排序时会排到最后', 'ORDER_DATE_UNPARSED');
    if (typeof o.spec === 'string' && o.spec) {
      const p = o.parsed && typeof o.parsed === 'object' ? o.parsed : parseSpec(o.spec);
      if (!p.parseOk) warn(at + '.spec', '「直径mm 结构」格式', o.spec, '规格无法解析为「直径mm 结构」；使用显式 processMap 的自定义工艺链可忽略此提示', 'SPEC_UNPARSED');
    }
    if (o.processMap != null && (typeof o.processMap !== 'object' || Array.isArray(o.processMap))) err(at + '.processMap', '对象', o.processMap, '工艺映射必须是对象', 'PROCESS_MAP_TYPE');
  });

  /* ---------- 3. 语义层：设备 ---------- */
  const machineGroups = (obj.machines && typeof obj.machines === 'object' && !Array.isArray(obj.machines)) ? obj.machines : {};
  const machineIdsByGroup = {};
  for (const [g, list] of Object.entries(machineGroups)) {
    if (!Array.isArray(list)) { err('machines.' + g, '设备数组', list, '设备分组必须是数组', 'MACHINE_GROUP_TYPE'); continue; }
    stats.machines[g] = list.length;
    const seen = new Set();
    list.forEach((m, i) => {
      const at = 'machines.' + g + '[' + i + ']';
      if (!m || typeof m !== 'object' || Array.isArray(m)) return;
      if (m.id == null || m.id === '') err(at + '.id', '非空设备编号', m.id, '设备缺少编号', 'MACHINE_ID_MISSING');
      else {
        const key = String(m.id);
        if (seen.has(key)) err(at + '.id', '同组内唯一设备编号', m.id, '设备编号重复', 'DUPLICATE_MACHINE_ID');
        seen.add(key);
      }
      if (m.specMin != null && m.specMax != null && num(m.specMin) > num(m.specMax)) {
        err(at, 'specMin ≤ specMax', m.specMin + ' > ' + m.specMax, '设备的规格区间上下限颠倒', 'MACHINE_RANGE_INVERTED');
      }
    });
    machineIdsByGroup[g] = [...seen];
  }

  /* ---------- 4. 语义层：产能矩阵 ---------- */
  const capacity = (obj.capacity && typeof obj.capacity === 'object' && !Array.isArray(obj.capacity)) ? obj.capacity : {};
  for (const [mk, mx] of Object.entries(capacity)) {
    const at = 'capacity.' + mk;
    if (!mx || typeof mx !== 'object' || Array.isArray(mx)) { err(at, '矩阵对象', mx, '产能矩阵必须是对象', 'MATRIX_TYPE'); continue; }
    const ids = Array.isArray(mx.machineIds) ? mx.machineIds.map(String) : [];
    const coef = Array.isArray(mx.coefficients) ? mx.coefficients : null;
    const rows = Array.isArray(mx.rows) ? mx.rows : [];
    stats.matrices[mk] = { machineIds: ids.length, rows: rows.length, coefficients: coef ? coef.length : 0 };
    if (!ids.length) warn(at + '.machineIds', '非空设备列', ids.length, '矩阵未声明设备列：将回退为设备分组顺序，请确认列对齐', 'MATRIX_IDS_EMPTY');
    if (coef && ids.length && coef.length !== ids.length) err(at + '.coefficients', '长度等于 machineIds（' + ids.length + '）', coef.length, '设备系数与设备列数不一致', 'COEFF_LENGTH');
    const dupKeys = new Map();
    let nullCells = 0, nullRows = 0, allInadaptable = 0;
    rows.forEach((r, i) => {
      const rat = at + '.rows[' + i + ']';
      if (!r || typeof r !== 'object' || Array.isArray(r)) { err(rat, '矩阵行对象', r, '矩阵行必须是对象', 'MATRIX_ROW_TYPE'); return; }
      if (typeof r.spec !== 'string' || !r.spec) err(rat + '.spec', '非空规格字符串', r.spec, '矩阵行缺少规格', 'MATRIX_ROW_SPEC_MISSING');
      const key = String(r.name || '') + '|' + String(r.spec || '');
      dupKeys.set(key, (dupKeys.get(key) || 0) + 1);
      if (Array.isArray(r.caps)) {
        r.caps.forEach((c, ci) => {
          if (typeof c === 'number') {
            if (!Number.isInteger(c) || c < 0 || (ids.length && c >= ids.length)) err(rat + '.caps[' + ci + ']', '设备下标 0…' + Math.max(0, ids.length - 1) + ' 或设备编号', c, 'caps 指向不存在的设备列', 'CAPS_OUT_OF_RANGE');
          } else if (ids.length && ids.indexOf(String(c)) < 0) {
            err(rat + '.caps[' + ci + ']', 'machineIds 中的设备编号', c, 'caps 引用了矩阵未声明的设备', 'CAPS_UNKNOWN_MACHINE');
          }
        });
      }
      if (Array.isArray(r.rates)) {
        if (ids.length && r.rates.length !== ids.length) err(rat + '.rates', '长度等于 machineIds（' + ids.length + '）', r.rates.length, '产出列数与设备列数不一致，无法判定适配关系', 'RATES_LENGTH');
        let anyPositive = false, allEmpty = true;
        const nullIdx = [];
        r.rates.forEach((v, vi) => {
          if (v == null) { nullCells++; nullIdx.push(vi); }
          else { allEmpty = false; if (num(v) > 0) anyPositive = true; }
        });
        if (nullIdx.length) {
          warn(rat + '.rates', '每列 number > 0', '空值 ' + nullIdx.length + ' 列（下标 ' + nullIdx.slice(0, 8).join(',') + '）',
            '矩阵空值 = 不适配（既不是 0 产能，也不是可用产能），这些设备列不会被排产使用', 'MATRIX_NULL_CELL');
        }
        if (allEmpty) nullRows++;
        if (!anyPositive && !Array.isArray(r.caps)) {
          allInadaptable++;
          if (allInadaptable <= 5) warn(rat, '至少 1 个可用产出值', JSON.stringify(r.rates), '该行所有产出为空/非正：整行不适配，不会产出任务', 'MATRIX_ROW_INADAPTABLE');
        }
      } else if (!Array.isArray(r.caps)) {
        const coefLen = Array.isArray(mx.coefficients) ? mx.coefficients.length : 0;
        if (r.torsion != null && coefLen) {
          /* 合法口径：捻股矩阵「值 = 行捻距均值 × 设备系数」，不需要 rates */
        } else if (r.torsion != null) {
          warn(rat, '矩阵级 coefficients', null, '该行用「捻距 × 设备系数」还原产能，但矩阵缺少 coefficients，该行不会产出任务', 'MATRIX_COEFF_MISSING');
        } else {
          warn(rat, 'rates 或 caps 或 torsion', null, '矩阵行既无 rates/caps 也无捻距：无法判定适配关系，该行不会产出任务', 'MATRIX_ROW_NO_CAPACITY');
        }
      }
    });
    const dups = [...dupKeys.entries()].filter(([, n]) => n > 1);
    if (dups.length) warn(at + '.rows', '每行 (品名, 规格) 唯一', dups.length + ' 组重复', '存在重复的「品名|规格」行，按首次出现值使用（其余被忽略）', 'MATRIX_DUPLICATE_ROWS');
    stats.matrices[mk].nullCells = nullCells;
    stats.matrices[mk].allEmptyRows = nullRows;
  }

  /* ---------- 5. 语义层：meta 与规格索引 ---------- */
  const meta = (obj.meta && typeof obj.meta === 'object' && !Array.isArray(obj.meta)) ? obj.meta : null;
  if (!meta) warn('meta', '数据集元信息对象', obj.meta, '缺少 meta：数据集来源与版本无法追溯', 'META_MISSING');
  else if (meta.orderCount != null && num(meta.orderCount) !== orders.length) {
    warn('meta.orderCount', '等于 orders.length（' + orders.length + '）', meta.orderCount, 'meta 声明的订单数与实际订单数不一致', 'ORDER_COUNT_MISMATCH');
  }
  if (stats.hasSpecIndex && obj.specIndex.orderMatchStats && num(obj.specIndex.orderMatchStats.total) !== orders.length) {
    warn('specIndex.orderMatchStats.total', '等于 orders.length（' + orders.length + '）', obj.specIndex.orderMatchStats.total, '规格索引统计与订单数不一致', 'SPEC_INDEX_TOTAL');
  }

  /* ---------- 6. 语义层：工艺链 ↔ 设备分组 ---------- */
  const resolved = resolveProcessChain(obj, options.chainOptions || {});
  stats.chainKeys = resolved.chain.map(p => p.key);
  stats.processChainSource = resolved.source;
  for (const e of resolved.errors) errors.push({ path: e.path || 'processChain', expected: '合法工艺链定义', actual: '', message: e.message, code: 'CHAIN' });
  for (const w of resolved.warnings) warnings.push({ path: w.path || 'processChain', expected: '合法工艺链定义', actual: '', message: w.message, code: 'CHAIN_WARN' });
  for (const p of resolved.chain) {
    const list = Array.isArray(machineGroups[p.key]) ? machineGroups[p.key] : [];
    const prefixes = (p.machinePrefixes || []).map(String);
    const byPrefix = prefixes.length ? Object.values(machineGroups).some(arr => Array.isArray(arr)
      && arr.some(m => m && m.id != null && prefixes.some(pre => String(m.id).startsWith(pre)))) : false;
    if (!list.length && !byPrefix) {
      err('machines.' + p.key, '非空设备数组，或可用 machinePrefixes 匹配到设备', list.length, '工序「' + p.name + '」没有任何设备：该工序无法排产', 'NO_MACHINES_FOR_PROCESS');
    }
    const cap0 = p.capability || {};
    if (cap0.kind === 'matrix') {
      const mk = cap0.matrix || p.key;
      if (!capacity[mk]) err('capacity.' + mk, '产能矩阵', undefined, '工序「' + p.name + '」声明使用矩阵「' + mk + '」，但数据集中不存在', 'MATRIX_MISSING');
    }
    if (cap0.kind === 'specRange' && list.length && !list.some(m => m && (m.specMin != null || m.specMax != null))) {
      warn('machines.' + p.key, '至少一台设备带 specMin/specMax', list.length + ' 台', '工序「' + p.name + '」按规格区间适配，但设备台账没有任何区间字段', 'NO_SPEC_RANGE');
    }
  }

  return { ok: errors.length === 0, errors, warnings, stats };
}

/** 把校验错误格式化成可读多行文本（用于抛错与 CLI 输出） */
export function formatValidationErrors(errors, limit = 12) {
  const list = Array.isArray(errors) ? errors : [];
  const lines = list.slice(0, limit).map(e => '  - ' + (e.path || '(root)') + '：' + e.message
    + '（期望 ' + e.expected + '，实际 ' + e.actual + '）');
  if (list.length > limit) lines.push('  … 其余 ' + (list.length - limit) + ' 项见 errors 明细');
  return lines.join('\n');
}

/* ---------------- 内部工具 ---------------- */
function joinPath(path, key) { return path ? path + '.' + key : key; }
function typeName(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return '数组';
  return typeof v === 'object' ? '对象' : typeof v;
}
function typeLabel(sub) {
  if (!sub) return '任意类型';
  if (Array.isArray(sub.type)) return sub.type.join(' | ');
  if (sub.$ref) return String(sub.$ref).split('/').pop();
  return sub.type || '任意类型';
}
function matchesType(v, t) {
  const actual = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
  if (t === 'number') return actual === 'number' && isFinite(v);
  if (t === 'integer') return actual === 'number' && Number.isInteger(v);
  if (t === 'object') return actual === 'object';
  return actual === t;
}
function num(v, dflt) { const n = typeof v === 'number' ? v : parseFloat(v); return Number.isFinite(n) ? n : dflt; }
function isDateLike(v) {
  if (typeof v !== 'string' || !v.trim()) return false;
  const s = v.trim();
  if (/^\d{4}-\d{1,2}-\d{1,2}([T ]\d{1,2}:\d{2}(:\d{2})?)?$/.test(s)) return true;
  const d = new Date(s);
  return !isNaN(d.getTime());
}
function preview(v) {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (typeof v === 'string') return v.length > 70 ? '"' + v.slice(0, 70) + '…"' : '"' + v + '"';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  let s = '';
  try { s = JSON.stringify(v); } catch (e) { s = String(v); }
  if (s == null) s = String(v);
  return s.length > 70 ? s.slice(0, 70) + '…' : s;
}
