// ===== 拦截日志存储：IndexedDB 后端 =====
// 取代原先 chrome.storage.local 单键 `interceptLog` 数组的「全量读-改-写」：
// 每写 1 条日志都要读回整个数组、逐条累加字节、超限裁尾、整键写回（无事务、写放大严重，
// 观察模式下每个 fetch/XHR 触发一次）。改为按 seq 自增主键**追加单条**（O(1)），
// 游标倒序读取、游标删除清空。上限、数据形状、newest-first 顺序与原实现保持一致。
//
// 供 background/index.ts 的日志消息处理器（LOG_SAVE/GET/COUNT/CLEAR/CLEAR_SCOPE）与
// webRequest observed 写入器调用；调用方已用 logWriteQueue 串行化，故本模块单写者、meta 计数不竞态。

const DB_NAME = 'apimockflow';
const DB_VERSION = 1;
const STORE = 'logs';        // keyPath 'seq' 自增；seq 越大越新
const META = 'meta';         // 存 { k:'stats', count, totalBytes }，供裁剪与计数 O(1) 判定
const META_KEY = 'stats';

// 上限与原 background/index.ts 一致：200 条 / 总量 32MB。单条 body 完整保留，绝不截断。
const MAX_ENTRIES = 200;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;

// 与原 logEntryBytes 同口径：UTF-16 近似字节数。
function approxBytes(x: unknown): number {
  try { return JSON.stringify(x).length * 2; } catch { return 0; }
}
function entryBytes(e: any): number {
  return typeof e?._bytes === 'number' ? e._bytes : approxBytes(e);
}

let dbP: Promise<IDBDatabase> | null = null;
function openDB(): Promise<IDBDatabase> {
  if (dbP) return dbP;
  dbP = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'seq', autoIncrement: true });
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'k' });
    };
    req.onsuccess = () => {
      const db = req.result;
      // SW 回收 / 其它上下文触发版本变化时关库并清缓存，下次按需重开。
      db.onclose = () => { dbP = null; };
      db.onversionchange = () => { db.close(); dbP = null; };
      resolve(db);
    };
    req.onerror = () => { dbP = null; reject(req.error); };
  });
  return dbP;
}

// 弹窗实时刷新信号：IDB 无跨上下文变更事件，故每次日志变更后向 chrome.storage.local 写一个
// 极小的递增计数器 interceptLogRev；弹窗订阅该键的 storage.onChanged → 触发一次 LOG_GET 拉取，
// 只投递一个数字而非整个大数组。用递增值（非 Date.now）保证 onChanged 必触发。
//
// 高频合并（关键）：观察模式下每个 fetch/XHR 都追加一条日志。若每条都同步 storage.set 落盘，会把
// onChanged 打成洪流——扇出到后台自身 + 所有弹窗/独立窗口，既抖动主线程、又拖慢清空（清空排在这串
// 追加之后，而每条追加都要等一次 storage 往返才 resolve）。故内存计数即时自增，**落盘**（才真正触发
// onChanged）用 leading+trailing 节流：窗口内首次立即写、其余合并到窗口末尾一次写。用户主动清空走
// bumpRevNow 立即落盘（低频、需即时刷新）。
const REV_FLUSH_MS = 400;
let revCache: number | null = null;
let lastRevFlush = 0;
let revFlushTimer: ReturnType<typeof setTimeout> | null = null;

async function ensureRevSeed(): Promise<void> {
  if (revCache !== null) return;
  revCache = await new Promise<number>((r) =>
    chrome.storage.local.get('interceptLogRev', (res) => r(typeof res.interceptLogRev === 'number' ? res.interceptLogRev : 0)));
}
function flushRev(): void {
  if (revCache === null) return;
  lastRevFlush = Date.now();
  try { chrome.storage.local.set({ interceptLogRev: revCache }); } catch { /* 忽略 */ }
}
// 追加日志用：节流落盘。内存自增即时完成，appendLog 立即 resolve（队列快速排空，清空不再被堵）。
async function bumpRev(): Promise<void> {
  try {
    await ensureRevSeed();
    revCache! += 1;
    const now = Date.now();
    if (now - lastRevFlush >= REV_FLUSH_MS) {
      flushRev(); // leading：窗口外首次立即落盘 → 低流量下弹窗即时刷新
    } else if (revFlushTimer === null) {
      // trailing：窗口内合并，末尾补一次落盘，保证最终一致
      revFlushTimer = setTimeout(() => { revFlushTimer = null; flushRev(); }, REV_FLUSH_MS - (now - lastRevFlush));
    }
  } catch { /* storage 不可用则跳过；弹窗仍有 2s 轮询兜底 */ }
}
// 清空/迁移用：立即落盘，用户即时看到刷新。
async function bumpRevNow(): Promise<void> {
  try {
    await ensureRevSeed();
    revCache! += 1;
    if (revFlushTimer !== null) { clearTimeout(revFlushTimer); revFlushTimer = null; }
    flushRev();
  } catch { /* 同上 */ }
}

// 追加单条日志，并按「条数 200 + 总量 32MB」双上限从最旧整条淘汰（绝不截断单条 body）。
export async function appendLog(entry: any): Promise<void> {
  const bytes = entryBytes(entry);
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([STORE, META], 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
    const logs = tx.objectStore(STORE);
    const meta = tx.objectStore(META);
    logs.add(entry); // 自增 seq；entry 无 seq 字段
    const g = meta.get(META_KEY);
    g.onsuccess = () => {
      let count = (g.result?.count || 0) + 1;
      let total = (g.result?.totalBytes || 0) + bytes;
      if (count <= MAX_ENTRIES && total <= MAX_TOTAL_BYTES) {
        meta.put({ k: META_KEY, count, totalBytes: total });
        return;
      }
      // 升序游标 = 最旧优先；刚追加的那条 seq 最大、最后才可能被删（与原 pop 尾部淘汰同序）。
      const cur = logs.openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (c && (count > MAX_ENTRIES || total > MAX_TOTAL_BYTES)) {
          count -= 1;
          total -= entryBytes(c.value);
          c.delete();
          c.continue();
        } else {
          meta.put({ k: META_KEY, count, totalBytes: Math.max(0, total) });
        }
      };
    };
  });
  await bumpRev();
}

// 读取全部日志，newest-first（与原 unshift 顺序一致）。
export async function getAllLogs(): Promise<any[]> {
  const db = await openDB();
  return new Promise<any[]>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const out: any[] = [];
    const cur = tx.objectStore(STORE).openCursor(null, 'prev'); // 降序 = 新→旧
    cur.onsuccess = () => {
      const c = cur.result;
      if (c) { out.push(c.value); c.continue(); } else resolve(out);
    };
    cur.onerror = () => reject(cur.error);
  });
}

export async function countLogs(): Promise<number> {
  const db = await openDB();
  return new Promise<number>((resolve) => {
    const tx = db.transaction(META, 'readonly');
    const g = tx.objectStore(META).get(META_KEY);
    g.onsuccess = () => resolve(g.result?.count || 0);
    g.onerror = () => resolve(0);
  });
}

export async function clearAll(): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([STORE, META], 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore(STORE).clear();
    tx.objectStore(META).put({ k: META_KEY, count: 0, totalBytes: 0 });
  });
  await bumpRevNow();
}

// 按视图隔离清空：保留 keep(entry) 为真者，删除其余；返回剩余条数。meta 随之重算。
export async function clearScope(keep: (entry: any) => boolean): Promise<number> {
  const db = await openDB();
  const remaining = await new Promise<number>((resolve, reject) => {
    const tx = db.transaction([STORE, META], 'readwrite');
    let count = 0, total = 0;
    const logs = tx.objectStore(STORE);
    const meta = tx.objectStore(META);
    tx.onerror = () => reject(tx.error);
    tx.oncomplete = () => resolve(count);
    const cur = logs.openCursor();
    cur.onsuccess = () => {
      const c = cur.result;
      if (c) {
        if (keep(c.value)) { count += 1; total += entryBytes(c.value); }
        else c.delete();
        c.continue();
      } else {
        meta.put({ k: META_KEY, count, totalBytes: total });
      }
    };
  });
  await bumpRevNow();
  return remaining;
}

// 批量导入（单事务）：一次性写入全部条目 + 一次 meta + 一次 rev。仅供一次性迁移使用——
// 旧数组已受旧实现的 200 条 / 32MB 上限约束，无需再裁剪。避免逐条事务 + 逐条落盘的启动写爆发。
async function bulkImport(entries: any[]): Promise<void> {
  if (!entries.length) return;
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([STORE, META], 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
    const logs = tx.objectStore(STORE);
    let count = 0, total = 0;
    for (const e of entries) { logs.add(e); count += 1; total += entryBytes(e); }
    tx.objectStore(META).put({ k: META_KEY, count, totalBytes: total });
  });
  await bumpRevNow();
}

// 一次性迁移：升级后把旧的 chrome.storage.local['interceptLog'] 数组导入 IDB，避免丢历史日志。
// 旧数组为 newest-first，倒序（oldest-first）批量写入使 seq 升序 = 时间顺序（新条 seq 最大）。导入后删除旧键。
export async function migrateFromStorageOnce(): Promise<void> {
  const old = await new Promise<any[]>((r) => {
    try { chrome.storage.local.get('interceptLog', (res) => r(Array.isArray(res.interceptLog) ? res.interceptLog : [])); }
    catch { r([]); }
  });
  const removeOldKey = () => new Promise<void>((r) => { try { chrome.storage.local.remove('interceptLog', () => r()); } catch { r(); } });
  if (!old.length) return;
  // IDB 已有数据则不重复导入，仅清除旧键。
  if ((await countLogs()) === 0) {
    await bulkImport(old.slice().reverse());
  }
  await removeOldKey();
}
