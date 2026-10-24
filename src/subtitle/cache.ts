const DB_NAME = "ytpp_subtitle_cache_v1";
const STORE_NAME = "translations";
const MAX_ENTRIES = 120;

interface CacheRecord {
  key: string;
  updatedAt: number;
  translations: Record<number, string>;
}

class SubtitleCache {
  private memory = new Map<string, Record<number, string>>();
  private dbPromise: Promise<IDBDatabase | null> | null = null;

  makeKey(
    videoId: string,
    trackId: string,
    cueCountOrFingerprint: number | string,
    targetLang: string,
    model: string,
  ): string {
    const tag =
      typeof cueCountOrFingerprint === "number"
        ? `c${cueCountOrFingerprint}`
        : cueCountOrFingerprint;
    return `${videoId}::${trackId}::${tag}::${targetLang}::${model}`;
  }

  private openDb(): Promise<IDBDatabase | null> {
    if (typeof indexedDB === "undefined") {
      return Promise.resolve(null);
    }
    if (this.dbPromise) {
      return this.dbPromise;
    }
    this.dbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            const store = db.createObjectStore(STORE_NAME, { keyPath: "key" });
            store.createIndex("updatedAt", "updatedAt", { unique: false });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    return this.dbPromise;
  }

  async get(key: string): Promise<Record<number, string> | null> {
    const inMem = this.memory.get(key);
    if (inMem) {
      return { ...inMem };
    }
    const db = await this.openDb();
    if (!db) return null;

    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, "readonly");
        const store = tx.objectStore(STORE_NAME);
        const req = store.get(key);
        req.onsuccess = () => {
          const record = req.result as CacheRecord | undefined;
          if (record && record.translations) {
            this.memory.set(key, record.translations);
            resolve({ ...record.translations });
          } else {
            resolve(null);
          }
        };
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  async merge(key: string, partial: Record<number, string>): Promise<void> {
    const existing = (await this.get(key)) || {};
    const merged: Record<number, string> = { ...existing, ...partial };
    this.memory.set(key, merged);

    const db = await this.openDb();
    if (!db) return;

    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        const record: CacheRecord = {
          key,
          updatedAt: Date.now(),
          translations: merged,
        };
        store.put(record);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    });

    void this.pruneIfNeeded(db);
  }

  private async pruneIfNeeded(db: IDBDatabase): Promise<void> {
    try {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const countReq = store.count();
      countReq.onsuccess = () => {
        const total = countReq.result;
        if (total <= MAX_ENTRIES) return;
        const toDelete = total - MAX_ENTRIES;
        const index = store.index("updatedAt");
        let deleted = 0;
        const cursorReq = index.openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (cursor && deleted < toDelete) {
            cursor.delete();
            deleted++;
            cursor.continue();
          }
        };
      };
    } catch {
      // Ignore pruning errors
    }
  }
}

export const subtitleCache = new SubtitleCache();
