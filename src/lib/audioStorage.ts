const DB_NAME = 'PodcastStudioAudioDB';
const DB_VERSION = 1;
const STORE_NAME = 'audio_blobs';

export const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000; // 3일 (259,200,000 ms)

export interface AudioRecord {
  blob: Blob;
  timestamp: number;
  projectId: string;
  segmentId: string;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveAudioBlob(
  projectId: string, 
  segmentId: string, 
  blob: Blob, 
  timestamp: number = Date.now()
): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const record: AudioRecord = {
      blob,
      timestamp,
      projectId,
      segmentId
    };
    store.put(record, `${projectId}_${segmentId}`);
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.error('Failed to save audio blob to IndexedDB:', e);
  }
}

export async function getAudioBlob(projectId: string, segmentId: string): Promise<Blob | null> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const key = `${projectId}_${segmentId}`;
    const request = store.get(key);
    return new Promise((resolve, reject) => {
      request.onsuccess = () => {
        const result = request.result;
        if (!result) {
          resolve(null);
          return;
        }

        // 3일 만료 여부 확인
        let blob: Blob | null = null;
        let timestamp: number | undefined;

        if (result instanceof Blob) {
          blob = result;
        } else if (result && result.blob instanceof Blob) {
          blob = result.blob;
          timestamp = result.timestamp;
        }

        if (timestamp && (Date.now() - timestamp > THREE_DAYS_MS)) {
          // 3일이 경과한 오디오 캐시 자동 삭제
          store.delete(key);
          resolve(null);
          return;
        }

        resolve(blob);
      };
      request.onerror = () => reject(request.error);
    });
  } catch (e) {
    console.error('Failed to get audio blob from IndexedDB:', e);
    return null;
  }
}

export async function deleteAudioBlob(projectId: string, segmentId: string): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.delete(`${projectId}_${segmentId}`);
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.error('Failed to delete audio blob from IndexedDB:', e);
  }
}

export async function deleteProjectAudioBlobs(projectId: string): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAllKeys();
    request.onsuccess = () => {
      const keys = request.result as string[];
      const prefix = `${projectId}_`;
      keys.forEach(key => {
        if (typeof key === 'string' && key.startsWith(prefix)) {
          store.delete(key);
        }
      });
    };
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.error('Failed to delete project audio blobs:', e);
  }
}

/**
 * 3일이 지난 오디오 캐시를 IndexedDB에서 일괄 검색하여 자동 정리(삭제)합니다.
 * @param maxAgeMs 기본값: 3일 (THREE_DAYS_MS)
 * @param projectTimestamps 레거시 Blob(타임스탬프 미포함) 정리를 위한 프로젝트 최종수정 시각 매핑
 * @returns 정리(삭제)된 오디오 캐시 개수
 */
export async function cleanExpiredAudioBlobs(
  maxAgeMs: number = THREE_DAYS_MS,
  projectTimestamps?: Map<string, number>
): Promise<number> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const now = Date.now();
    let deletedCount = 0;

    return new Promise((resolve, reject) => {
      const cursorReq = store.openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor) {
          const val = cursor.value;
          const key = cursor.key as string;
          let itemTimestamp: number | undefined;

          if (val && typeof val.timestamp === 'number') {
            itemTimestamp = val.timestamp;
          } else if (projectTimestamps && typeof key === 'string') {
            const pid = key.split('_')[0];
            if (pid && projectTimestamps.has(pid)) {
              itemTimestamp = projectTimestamps.get(pid);
            }
          }

          if (itemTimestamp && (now - itemTimestamp > maxAgeMs)) {
            cursor.delete();
            deletedCount++;
          }
          cursor.continue();
        } else {
          resolve(deletedCount);
        }
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    });
  } catch (e) {
    console.error('Failed to clean expired audio blobs:', e);
    return 0;
  }
}

export async function clearAllAudioBlobs(): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.clear();
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    });
  } catch (e) {
    console.error('Failed to clear all audio blobs:', e);
  }
}

/**
 * 보존할 프로젝트 ID 목록에 포함되지 않는 모든 오디오 캐시(IndexedDB)를 삭제합니다.
 * @param preservedProjectIds 오늘 등록된 프로젝트 등 보존할 프로젝트 ID Set
 * @returns 삭제된 오디오 블롭 개수
 */
export async function clearAudioBlobsExceptProjects(preservedProjectIds: Set<string>): Promise<number> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    let deletedCount = 0;

    return new Promise((resolve, reject) => {
      const cursorReq = store.openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor) {
          const key = cursor.key as string;
          const val = cursor.value;
          // 키 형태: `${projectId}_${segmentId}`
          const pid = val?.projectId || (typeof key === 'string' ? key.split('_')[0] : '');

          if (!pid || !preservedProjectIds.has(pid)) {
            cursor.delete();
            deletedCount++;
          }
          cursor.continue();
        } else {
          resolve(deletedCount);
        }
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    });
  } catch (e) {
    console.error('Failed to clear audio blobs except preserved projects:', e);
    return 0;
  }
}

