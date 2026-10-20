/**
 * 本地历史库（IndexedDB）
 *
 * 用 IndexedDB 而非 chrome.storage：条目里要存缩略图 dataURL，
 * 体积大且需要按标签检索，storage 会很快撑爆配额。
 *
 * 健壮性要点（都是踩过的坑）：
 *   1. 连接必须缓存复用。每次 open() 新建连接会让旧连接阻塞版本升级，
 *      触发 "Version change transaction was aborted"。
 *   2. onupgradeneeded 里任何抛错都会 abort 整个升级事务 → DB 永久打不开，
 *      所以每一步都要单独 try，且用 ensure 语义而不是 create。
 *   3. open 必须处理 onblocked，否则另一个连接不释放就永久挂起。
 *   4. 打不开时降级到内存 Map，绝不让历史记录功能拖垮主流程。
 */

const DB_NAME = 'img2prompt';
/** 改名前的库名。用户重命名扩展时这里需要跟着改，
 *  并配合下方migrateOnce 把数据搬过来 —— 否则历史与收藏会全部读不出来。 */
const LEGACY_DB_NAME = 'prompt-reverse';
const STORE = 'records';
// 收藏单独一个 store：与历史记录的生命周期完全不同（不会自动增长到几百条，
// 也不该被「清空历史」清掉），混在一个 store 里两者会互相干扰。
const STORE_FAV = 'favorites';
const VERSION = 2;

/** 迁移只做一次，避免每次启动都去碰旧库 */
let migratePromise = null;

let dbPromise = null;
let memoryFallback = null; // DB 不可用时的内存降级

function useMemory() {
  if (!memoryFallback) memoryFallback = new Map();
  return memoryFallback;
}

function isMissing(e) {
  const n = String(e?.name || '');
  return n === 'NotFoundError' || /no object store|does not exist|NotFound/i.test(String(e?.message || e));
}

function open() {
  if (dbPromise) return dbPromise;

  dbPromise = attemptOpen()
    .then((db) => {
      // 库名改过，必要时把旧库搬过来。挂在成功之后且不 await：
      // 迁移是后台任务，不能让首屏等它。
      migrateOnce();
      return db;
    })
    .catch(async (e) => {
      dbPromise = null;
      // 自愈：坏库删掉重建。历史记录丢失可接受，
      // 但让它永久不可用会让整个插件看起来「坏了」，必须能自己恢复。
      console.warn('[拾光] IndexedDB 打开失败，尝试重建', e);
      try {
        await deleteDb();
        const db = await rawOpen();
        dbPromise = Promise.resolve(db);
        return db;
      } catch (e2) {
        console.warn('[拾光] 重建失败，降级到内存', e2);
        throw e;
      }
    });

  return dbPromise;
}

/** 首次打开。onupgradeneeded 里任何抛出都会 abort 整个升级事务，
 *  所以每一步都单独 try，并且用"存在性检查 + 补建"而不是无条件 create。 */
function attemptOpen() {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, VERSION);
    } catch (e) {
      reject(e);
      return;
    }

    req.onupgradeneeded = () => {
      const db = req.result;
      try {
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
          if (!store.indexNames.contains('createdAt')) {
            store.createIndex('createdAt', 'createdAt');
          }
        } else {
          // 老库可能缺索引，只补不建
          const store = req.transaction.objectStore(STORE);
          if (!store.indexNames.contains('createdAt')) {
            store.createIndex('createdAt', 'createdAt');
          }
        }

        // 收藏表：keyPath 用 recordId（一条记录只收藏一次，天然去重）
        if (!db.objectStoreNames.contains(STORE_FAV)) {
          const fav = db.createObjectStore(STORE_FAV, { keyPath: 'recordId' });
          if (!fav.indexNames.contains('createdAt')) {
            fav.createIndex('createdAt', 'createdAt');
          }
        }
      } catch (e) {
        console.warn('[拾光] upgrade 异常', e);
      }
    };

    req.onsuccess = () => {
      const db = req.result;
      // 别的上下文要升级版本时主动让路，否则它会一直 blocked
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };

    req.onerror = () => reject(req.error);
    req.onblocked = () =>
      reject(new Error('数据库被其他标签页占用，请关闭其他插件面板后重试'));
  });
}

/** 裸 open，仅用于重建流程（不做自愈递归） */
function rawOpen() {
  return attemptOpen();
}

/**
 * 一次性把旧库的数据搬到新库。
 *
 * 背景：扩展从 Prompt Reverse 改名为拾光 Img2Prompt 时，IndexedDB 的库名
 * 是**按名字寻址**的 —— 名字一变，浏览器就认为这是一个全新空库，
 * 用户的历史记录和收藏会全部「消失」。所以改名必须配一个迁移。
 *
 * 触发时机：新库第一次打开成功之后、任何读写之前。
 * 迁移完成后写一个标记，此后不再执行 —— 否则每次启动都要开一次旧库，
 * 既慢又可能在旧库已被其他标签占用时卡住。
 *
 * 失败不阻断：新库是空的但功能正常，好过因为迁移出错而整体不可用。
 */
function migrateOnce() {
  if (migratePromise) return migratePromise;

  migratePromise = (async () => {
    const FLAG = 'img2prompt_migrated_from_prompt_reverse';
    try {
      const flag = await chrome.storage.local.get(FLAG);
      if (flag[FLAG]) return;

      const old = await openNamed(LEGACY_DB_NAME);
      if (!old) {
        // 旧库不存在 = 新装用户或已经迁移过，记标记即可
        await chrome.storage.local.set({ [FLAG]: 1 });
        return;
      }

      let moved = 0;
      for (const name of [STORE, STORE_FAV]) {
        if (!old.db.objectStoreNames.contains(name)) continue;
        const rows = await readAll(old.db, name);
        for (const row of rows) {
          await writeRow(name, row);
          moved++;
        }
      }
      old.db.close();

      if (moved) console.log(`[拾光] 已从 ${LEGACY_DB_NAME} 迁移 ${moved} 条数据`);
      await chrome.storage.local.set({ [FLAG]: 1 });
    } catch (e) {
      // 迁移失败不抛：新库照样能用，只是历史从零开始
      console.warn('[拾光] 旧库迁移失败，历史记录可能为空', e);
    }
  })();

  return migratePromise;
}

/**
 * 打开指定名字的库。
 *
 * 不传版本号 = 不触发 upgrade，因此只读地探测「这个库存在吗」，
 * 绝不会因为探测而凭空建出一个空壳把真库盖住。
 * 返回 null 表示库不存在（新装用户），而非打开失败。
 */
function openNamed(name) {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open(name);
    } catch (e) {
      reject(e);
      return;
    }
    req.onsuccess = () => resolve({ db: req.result });
    req.onerror = () => {
      // NotFoundError = 该库从未建立过，不是错误
      if (String(req.error?.name) === 'NotFoundError') resolve(null);
      else reject(req.error);
    };
    req.onblocked = () => resolve(null);
  });
}

function readAll(db, storeName) {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

function writeRow(storeName, row) {
  return new Promise((resolve) => {
    open()
      .then((db) => {
        const tx = db.transaction(storeName, 'readwrite');
        // 旧库是 autoIncrement，直接 put 会带上旧 id，与新库冲突。
        // records 表显式清掉 id 让它自增；favorites 用 recordId 做键，
        // 本来就不冲突，但为稳妥同样按 put 的自然语义处理。
        const payload = storeName === STORE ? { ...row, id: undefined } : row;
        tx.objectStore(storeName).put(payload);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      })
      .catch(() => resolve());
  });
}

function deleteDb() {
  return new Promise((resolve) => {
    let req;
    try {
      req = indexedDB.deleteDatabase(DB_NAME);
    } catch {
      resolve();
      return;
    }
    // 删除可能被其他连接阻塞，最多等 2 秒后强行继续
    const timer = setTimeout(resolve, 2000);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    req.onsuccess = done;
    req.onerror = done;
    req.onblocked = done;
  });
}

async function tx(mode, fn, storeName = STORE) {
  let db;
  try {
    db = await open();
  } catch (e) {
    console.warn('[拾光] IndexedDB 不可用，降级到内存', e);
    return memoryTx(mode, fn);
  }

  return new Promise((resolve, reject) => {
    let t;
    try {
      t = db.transaction(storeName, mode);
    } catch (e) {
      // store 不存在等结构性错误 → 内存降级
      if (isMissing(e)) {
        console.warn('[拾光] store 缺失，降级到内存', e);
        return resolve(memoryTx(mode, fn));
      }
      return reject(e);
    }

    let out;
    try {
      out = fn(t.objectStore(storeName));
    } catch (e) {
      if (isMissing(e)) return resolve(memoryTx(mode, fn));
      return reject(e);
    }

    t.oncomplete = () => resolve(out?.result !== undefined ? out.result : out);
    t.onerror = () => {
      // store 不存在在事务开始时才暴露，转换后降级
      if (isMissing(t.error)) return resolve(memoryTx(mode, fn));
      reject(t.error);
    };
    t.onabort = () => {
      if (isMissing(t.error)) return resolve(memoryTx(mode, fn));
      reject(t.error || new Error('事务被中断'));
    };
  });
}

/** 内存降级：只实现本次需要的语义，够用即可 */
function memoryTx(mode, fn) {
  const mem = useMemory();
  const proxy = {
    add(rec) {
      const id = mem.size + 1;
      mem.set(id, { ...rec, id, createdAt: rec.createdAt ?? Date.now() });
      return { result: id };
    },
    put(rec) {
      // 收藏表以 recordId 为主键；历史表以自增 id 为主键
      const key = rec.recordId != null ? rec.recordId : rec.id ?? mem.size + 1;
      const idKey = 'recordId' in rec ? 'recordId' : 'id';
      mem.set(key, { ...rec, [idKey]: key });
      return { result: key };
    },
    get(key) {
      return {
        result: mem.get(key),
        onsuccess: null,
      };
    },
    delete(key) {
      mem.delete(key);
      return { result: undefined };
    },
    clear() {
      mem.clear();
      return { result: undefined };
    },
    getAll() {
      return { result: [...mem.values()] };
    },
    index() {
      return {
        openCursor() {
          const items = [...mem.values()].sort(
            (a, b) => (b.createdAt || 0) - (a.createdAt || 0)
          );
          const cbs = [];
          let i = 0;
          const cursor = {
            result: null,
            continue: () => {
              const cb = cbs[0];
              if (!cb) return;
              const next = items[i++];
              cursor.result = next ? { value: next } : null;
              cb({ target: cursor });
            },
          };
          return {
            set onsuccess(cb) {
              cbs[0] = cb;
              const next = items[i++];
              cursor.result = next ? { value: next } : null;
              cb({ target: cursor });
            },
          };
        },
      };
    },
  };
  return fn(proxy);
}

/** 返回新记录的 id（autoIncrement 主键），面板据此把本次与历史区分开 */
export async function saveRecord(rec) {
  return tx('readwrite', (s) => s.add({ ...rec, createdAt: rec.createdAt ?? Date.now() }));
}

export async function listRecords(limit = 50) {
  try {
    const db = await open();
    return await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, 'readonly');
      const idx = t.objectStore(STORE).index('createdAt');
      const out = [];
      idx.openCursor(null, 'prev').onsuccess = (e) => {
        const c = e.target.result;
        if (!c || out.length >= limit) return resolve(out);
        out.push(c.value);
        c.continue();
      };
      t.onerror = () => reject(t.error);
    });
  } catch (e) {
    if (isMissing(e)) return memoryList(limit);
    console.warn('[拾光] 读历史失败', e);
    return [];
  }
}

function memoryList(limit = 50) {
  return [...useMemory().values()]
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, limit);
}

/**
 * 批量删除。传id 数组。
 * @returns {Promise<number>} 成功删除的条数
 */
export async function deleteRecords(ids) {
  const list = (Array.isArray(ids) ? ids : [ids]).filter((x) => x != null);
  if (!list.length) return 0;

  try {
    const db = await open();
    return await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, 'readwrite');
      const store = t.objectStore(STORE);
      let done = 0;
      for (const id of list) {
        const req = store.delete(id);
        req.onsuccess = () => {
          done++;
        };
        // 单条不存在时 delete 也会成功，不算错误
        req.onerror = () => {};
      }
      t.oncomplete = () => resolve(done);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('删除被中断'));
    });
  } catch (e) {
    const mem = useMemory();
    let n = 0;
    for (const id of list) if (mem.delete(id)) n++;
    return n;
  }
}

export async function clearRecords() {
  try {
    await tx('readwrite', (s) => s.clear());
  } catch {
    /* DB 不可用时清空内存副本即可 */
  }
  // 内存副本始终要清 —— DB 不可用时 tx 会走 memory.clear，
  // 但 DB 可用时内存里可能残留降级期间的数据
  useMemory().clear();
}

/* ══════════════ 收藏 ══════════════
 *
 * 与历史记录分开存放，理由：
 *   1. 生命周期不同 —— 收藏不会自动增长到几百条，也不该被
 *      「清空历史」误删
 *   2. 一条记录只收藏一次 —— keyPath 用 recordId，天然去重
 *   3. 收藏的是**当前文本**（用户可能改过），不是原始结果
 */

/**
 * 收藏一条记录。
 * @param rec 原记录（提供 thumbnail/fullImage/subject 等）
 * @param text 收藏时的提示词文本 —— 用户编辑过就存编辑后的
 */
export async function addFavorite(rec, text) {
  // keyPath 是 recordId，给 undefined 会直接抛 DataError。
  // 理论上 rec.id 一定存在（saveRecord 走 autoIncrement），
  // 但内存降级路径下可能拿不到 —— 这时用内容哈希兜底，
  // 保证「同一张图的同一个结果」仍能定位到同一条收藏。
  const rid = rec.id != null ? rec.id : await fallbackKey(rec);

  const item = {
    recordId: rid,
    // 收藏的是「当时那个文本」。用户编辑过就是编辑后的版本。
    text: String(text ?? ''),
    thumbnail: rec.thumbnail || '',
    fullImage: rec.fullImage || rec.thumbnail || '',
    subject: rec.fields?.subject?.zh || rec.fields?.subject?.en || '',
    // 不兜底成 '1:1'：非标准比例的图片存下来就是「没有比例」，
    // 补一个方形会让重新打开时显示一个当初并不存在的比例。
    ratio: rec.ratio || null,
    engine: rec.engine || 'nanobanana',
    originUrl: rec.originUrl || '',
    createdAt: Date.now(),
    edited: false,
  };
  return tx('readwrite', (s) => s.put(item), STORE_FAV);
}

/** rec.id 缺失时的兜底 key：指纹 + 创建时间，保证可复现 */
async function fallbackKey(rec) {
  const base = String(rec.fingerprint || rec.originUrl || 'local');
  return `k:${base}:${rec.createdAt ?? ''}`.slice(0, 200);
}

export async function listFavorites() {
  try {
    const db = await open();
    return await new Promise((resolve, reject) => {
      const t = db.transaction(STORE_FAV, 'readonly');
      const idx = t.objectStore(STORE_FAV).index('createdAt');
      const out = [];
      idx.openCursor(null, 'prev').onsuccess = (e) => {
        const c = e.target.result;
        if (!c) return resolve(out);
        out.push(c.value);
        c.continue();
      };
      t.onerror = () => reject(t.error);
    });
  } catch (e) {
    console.warn('[拾光] 读收藏失败', e);
    return [];
  }
}

/** 某条记录是否已收藏 */
export async function isFavorite(recordId) {
  try {
    const db = await open();
    return await new Promise((resolve) => {
      const t = db.transaction(STORE_FAV, 'readonly');
      const req = t.objectStore(STORE_FAV).get(recordId);
      req.onsuccess = () => resolve(Boolean(req.result));
      req.onerror = () => resolve(false);
    });
  } catch {
    return false;
  }
}

/**
 * 更新收藏里的提示词文本（用户在收藏里继续编辑时调用）。
 * 自动保存：每次编辑都写一次，不设「手动保存」按钮。
 */
export async function updateFavoriteText(recordId, text) {
  try {
    const db = await open();
    return await new Promise((resolve, reject) => {
      const t = db.transaction(STORE_FAV, 'readwrite');
      const store = t.objectStore(STORE_FAV);
      const req = store.get(recordId);
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) return resolve(false);
        cur.text = String(text ?? '');
        cur.edited = true;
        cur.updatedAt = Date.now();
        const w = store.put(cur);
        w.onsuccess = () => resolve(true);
        w.onerror = () => resolve(false);
      };
      req.onerror = () => resolve(false);
      t.onerror = () => reject(t.error);
    });
  } catch {
    return false;
  }
}

export async function removeFavorite(recordId) {
  return tx('readwrite', (s) => s.delete(recordId), STORE_FAV);
}


/**
 * 指纹：标识「同一张图」。
 *
 * 早期版本用「URL 末段 + 解码后宽高」，但宽高会随取图方式变化——
 * canvas 路径缩放到长边 1024，fetch 路径可能保持原图尺寸，
 * 于是同一张图两次反推算出不同指纹，去重逻辑形同虚设。
 *
 * 现在用 URL 路径的**末两段 + 域名**：它由图片地址决定，与取图方式无关，
 * 又比「只取文件名」更能区分 —— CDN 上不同图片完全可能同名
 * （1.jpg、image.jpg、截断的哈希…），只比文件名会把它们聚成一组，
 * 表现为「换了一张图，卡片流里却混进上一张的记录」。
 *
 * 对 dataURL（拖拽/本地）退化为内容长度 + 首尾片段。
 */
export function fingerprint(url, width, height) {
  const raw = String(url || '');

  // dataURL：用内容特征
  if (raw.startsWith('data:')) {
    const body = raw.slice(raw.indexOf(',') + 1);
    return `data:${body.length}:${body.slice(0, 24)}`;
  }

  // http(s)：域名 + 路径末两段
  let host = '';
  let path = raw;
  const hm = raw.match(/^[a-z]+:\/\/([^/]+)(.*)$/i);
  if (hm) {
    host = hm[1].replace(/^www\./, '');
    path = hm[2];
  }

  const segs = path.split(/[?!#]/)[0].split('/').filter(Boolean);
  const tail = segs.slice(-2).join('/') || segs.slice(-1)[0] || path;
  // 文件名带尺寸后缀（如 xxx_1080x2160.jpg）时剥掉，避免同图不同尺寸算出不同指纹
  const clean = tail.replace(/[_-]\d{2,5}x\d{2,5}(?=\.[a-z0-9]+$)/i, '');
  return host ? `${host}/${clean || tail}` : clean || tail;
}

/**
 * 找出这张图的所有历史反推记录，按时间倒序。
 *
 * 同一张图可能被反推多次（换模型、换引擎、手动重跑），
 * 面板要一次展示全部让用户对比，而不是只给最近一条。
 *
 * 兼容旧格式：早期指纹是 `文件名:WxH`，与现在的纯文件名不同，
 * 这里额外做一次「去掉 :WxH 后缀」的宽松匹配，避免升级后历史「丢失」。
 */
export async function findByFingerprint(fp) {
  try {
    const recs = await listRecords(500);
    const loose = String(fp).replace(/:\d+x\d+$/, '');
    return recs
      .filter(
        (r) =>
          r.fingerprint === fp ||
          String(r.fingerprint || '').replace(/:\d+x\d+$/, '') === loose
      )
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  } catch {
    return [];
  }
}