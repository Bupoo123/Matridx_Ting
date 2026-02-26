const SALT_STORAGE_KEY = "matridx_local_salt_v1";

function getOrCreateSalt(): Uint8Array {
  const existing = localStorage.getItem(SALT_STORAGE_KEY);
  if (existing) {
    return Uint8Array.from(atob(existing), (ch) => ch.charCodeAt(0));
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  localStorage.setItem(SALT_STORAGE_KEY, btoa(String.fromCharCode(...salt)));
  return salt;
}

export async function deriveAesKey(passcode: string): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passcode),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  const salt = getOrCreateSalt();
  const saltBuffer = salt.buffer.slice(salt.byteOffset, salt.byteOffset + salt.byteLength) as ArrayBuffer;
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: saltBuffer,
      iterations: 150_000
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function encryptAudioData(audioData: ArrayBuffer, key: CryptoKey) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, audioData);
  return { iv: Array.from(iv), encrypted };
}

export async function decryptAudioData(encrypted: ArrayBuffer, iv: number[], key: CryptoKey) {
  return crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: new Uint8Array(iv)
    },
    key,
    encrypted
  );
}
