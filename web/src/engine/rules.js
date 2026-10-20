/* R1–R10 规则登记表：既是界面文案来源，也是约束可解释的对照表 */
/* 工序元数据不再写死在本文件：默认工艺链的定义与解析见 engine/chain.js（可被 dataset / options 覆盖）。
   这里导出的 PROCESSES 仍是同一份默认三工序（拉丝 / 捻股 / 合绳），字段与历史版本完全兼容。 */
import { DEFAULT_PROCESS_CHAIN, chainToProcesses } from './chain.js';

export const RULES = [
  { id: 'R1', title: '排产单位：按设备型号排产', source: '赛题手册 R1',
    text: '订单先匹配到可加工它的设备型号；同型号内按订单紧急程度、先后顺序排产。产能矩阵空值视为不适配。',
    impl: '适配判定为硬约束：拉丝按规格区间，捻股/合绳按产能矩阵非空列。同型号内按 优先级 → 预发货日 → 订单日期 → 订单号 稳定排序。',
    level: 'hard' },
  { id: 'R2', title: '班次日历：两班倒 12 小时', source: '赛题手册 R2',
    text: '两班倒、每班 12 小时，全天 24 小时连续生产。',
    impl: '日历以 00:00–12:00 / 12:00–24:00 两班显示；换班默认不切断工序，跨班任务连续占用。',
    level: 'calendar' },
  { id: 'R3', title: '换型判定（拉丝）', source: '赛题手册 R3',
    text: '成品和原料有一个不同，就要换型。',
    impl: '相邻任务比对「原料规格」与「成品规格」两项，任一不同即触发换型占用，并显示触发字段。',
    level: 'hard' },
  { id: 'R4', title: '换型判定（捻股、合绳）', source: '赛题手册 R4',
    text: '结构和（绳）股径有一个不同，就要换型。',
    impl: '相邻任务比对「结构」与「（绳）股径」两项，任一不同即触发换型占用，并显示触发字段。',
    level: 'hard' },
  { id: 'R5', title: '换型耗时 1–5 小时', source: '赛题手册 R5',
    text: '换型耗时 1–5 小时不等，随规格切换幅度变化。',
    impl: '数据包未提供换型耗时矩阵，默认使用「演示参数模型」：按切换维度数 × 幅度分档取值，全部换型耗时在界面标注来源与依据。',
    level: 'param' },
  { id: 'R6', title: '工序间隔不超过 3 天', source: '赛题手册 R6',
    text: '相邻工序之间允许间隔等待，须控制在 3 天以内。',
    impl: '等待 = 后序加工开始 − 前序加工结束；超过 72 小时判为冲突并阻断确认（按连续小时口径）。',
    level: 'hard' },
  { id: 'R7', title: '订单必需字段', source: '赛题手册 R7',
    text: '订单号、规格、数量、交期。',
    impl: '导入时做完整性校验；缺失则阻断该订单排产，不静默丢弃也不使用默认值。',
    level: 'data' },
  { id: 'R8', title: '交期约束：硬交期 / 可容忍 ≤3 天', source: '赛题手册 R8',
    text: '部分客户延期罚款（硬约束），部分客户可容忍 ≤3 天（软约束）。',
    impl: '逐单区分「承诺交期」与「允许最晚完工」；未知政策显示「交期政策待确认」，不默认宽限。',
    level: 'hard' },
  { id: 'R9', title: '优先级：重点客户、重点订单优先', source: '赛题手册 R9',
    text: '重点客户、重点订单优先生产。',
    impl: '优先级参与排序与解释，但不覆盖适配等硬约束；同级按订单日期与订单号稳定排序。',
    level: 'soft' },
  { id: 'R10', title: '插单频率约每周 5 次', source: '赛题手册 R10',
    text: '紧急插单约每周 5 次。',
    impl: '在「模拟变更」中提供插单/故障/物料延迟三类扰动，基于当前版本重排并量化逐单影响。',
    level: 'scenario' },
  /* 以下为**本产品扩展**，不属于赛题手册 R1–R10；单独列出以免被误读成赛题要求。 */
  { id: 'MAT', title: '底层材料齐备（产品扩展）', source: '本产品扩展 · 材料库',
    text: '订单所需的底层原材料（铜 / 锌 / 铁 / 塑料 / 油脂 / 纤维芯）必须齐备。',
    impl: '用料由订单的品名 / 规格 / 绳芯 / 涂层四个字段显式推导；材料库中标记为「无」的材料，会让需要它的订单立刻阻断、不进入排产。默认全部有货。',
    level: 'hard', product: true },
];
export const RULE_MAP = Object.fromEntries(RULES.map(r => [r.id, r]));
export const ruleRef = (id) => '<span class="rule-ref" title="' + (RULE_MAP[id]?.title || '') + '">' + id + '</span>';

/* 工序元数据：由默认工艺链派生（单一事实来源） */
export const PROCESSES = chainToProcesses(DEFAULT_PROCESS_CHAIN);
export const PROC_MAP = Object.fromEntries(PROCESSES.map(p => [p.key, p]));
export const procName = k => PROC_MAP[k]?.name || k;
export const procCls = k => PROC_MAP[k]?.cls || '';
