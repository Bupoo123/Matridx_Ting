import { openDB } from "idb";

export type RecordingBlob = {
  id: string;
  recordingId?: string;
  title: string;
  createdAt: string;
  durationMs: number;
  mimeType: string;
  encryptedAudio: ArrayBuffer;
  iv: number[];
};

const DB_NAME = "matridx-recorder-v1";
const STORE_NAME = "recordings";

async function getDb() {
  return openDB(DB_NAME, 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    }
  });
}

export async function saveRecording(recording: RecordingBlob) {
  const db = await getDb();
  await db.put(STORE_NAME, recording);
}

export async function listRecordings() {
  const db = await getDb();
  const all = (await db.getAll(STORE_NAME)) as RecordingBlob[];
  return all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function getRecording(id: string) {
  const db = await getDb();
  return (await db.get(STORE_NAME, id)) as RecordingBlob | undefined;
}

export async function removeRecording(id: string) {
  const db = await getDb();
  await db.delete(STORE_NAME, id);
}

export async function attachServerRecordingId(localId: string, recordingId: string) {
  const row = await getRecording(localId);
  if (!row) return;
  row.recordingId = recordingId;
  await saveRecording(row);
}
