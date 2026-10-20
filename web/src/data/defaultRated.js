/* 固定的产品额定数据：由 tools/build_default_rated.py 从工作簿编译而来。
   页面只读取这个轻量 JSON，不再让计划员上传或替换设备 / 产能文件。 */
export const DEFAULT_RATED_ID = 'product-rated-default-20260919';
const DEFAULT_RATED_URL = '../data/default-rated-capacity.json';
let cached = null;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export async function loadDefaultRatedData() {
  if (!cached) {
    cached = fetch(DEFAULT_RATED_URL)
      .then(async response => {
        if (!response.ok) throw new Error('内置产品额定数据无法载入（HTTP ' + response.status + '）');
        const data = await response.json();
        if (data?.meta?.id !== DEFAULT_RATED_ID || !data?.machines || !data?.capacity) {
          throw new Error('内置产品额定数据格式无效');
        }
        return data;
      })
      .catch(error => { cached = null; throw error; });
  }
  return clone(await cached);
}
