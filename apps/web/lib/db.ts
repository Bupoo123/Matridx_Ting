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
const TRANSCRIPTS_CACHE_STORE = "transcripts_cache";
const MEETING_NOTES_CACHE_STORE = "meeting_notes_cache";

export type TranscriptCacheItem = {
  id: string;
  recording_id: string;
  text: string;
  created_at: string;
  cache_date: string;
};

export type MeetingNoteCacheItem = {
  id: string;
  recording_id: string;
  contributor: string;
  recorded_at: string;
  date: string;
  time: string;
  title: string;
  summary: string;
  transcript_text: string;
  source: "upload" | "realtime";
  storage_path: string | null;
  checksum: string | null;
  last_error?: string | null;
  created_at?: string;
  updated_at?: string;
};

async function getDb() {
  return openDB(DB_NAME, 2, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(TRANSCRIPTS_CACHE_STORE)) {
        db.createObjectStore(TRANSCRIPTS_CACHE_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(MEETING_NOTES_CACHE_STORE)) {
        db.createObjectStore(MEETING_NOTES_CACHE_STORE, { keyPath: "id" });
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

export async function saveTranscriptCache(items: TranscriptCacheItem[]) {
  const db = await getDb();
  const tx = db.transaction(TRANSCRIPTS_CACHE_STORE, "readwrite");
  for (const item of items) {
    await tx.store.put(item);
  }
  await tx.done;
}

export async function listTranscriptCacheByDate(date: string) {
  const db = await getDb();
  const rows = (await db.getAll(TRANSCRIPTS_CACHE_STORE)) as TranscriptCacheItem[];
  return rows
    .filter((item) => item.cache_date === date)
    .sort((a, b) => (a.created_at > b.created_at ? 1 : -1));
}

export async function saveMeetingNotesCache(items: MeetingNoteCacheItem[]) {
  const db = await getDb();
  const tx = db.transaction(MEETING_NOTES_CACHE_STORE, "readwrite");
  for (const item of items) {
    await tx.store.put(item);
  }
  await tx.done;
}

export async function listMeetingNotesCacheByDate(date: string) {
  const db = await getDb();
  const rows = (await db.getAll(MEETING_NOTES_CACHE_STORE)) as MeetingNoteCacheItem[];
  return rows
    .filter((item) => item.date === date)
    .sort((a, b) => (a.recorded_at > b.recorded_at ? 1 : -1));
}
