/* 极简事件总线 + 全局应用状态 */
export function createBus() {
  const map = new Map();
  return {
    on(evt, fn) { if (!map.has(evt)) map.set(evt, new Set()); map.get(evt).add(fn); return () => map.get(evt).delete(fn); },
    off(evt, fn) { map.get(evt)?.delete(fn); },
    emit(evt, payload) {
      map.get(evt)?.forEach(fn => { try { fn(payload); } catch (e) { console.error('[bus]', evt, e); } });
      map.get('*')?.forEach(fn => { try { fn({ evt, payload }); } catch (e) { console.error(e); } });
    },
  };
}
export const bus = createBus();
