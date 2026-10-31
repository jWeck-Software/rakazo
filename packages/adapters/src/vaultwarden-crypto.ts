import * as nodeCrypto from "node:crypto";

export type EncString =
  | { type: 2; iv: Buffer; data: Buffer; mac: Buffer }
  | { type: 4; data: Buffer };

export interface SymmetricKey {
  enc: Buffer;
  mac: Buffer;
}

export type VaultwardenKdf =
  | { type: "pbkdf2"; iterations: number }
  | { type: "argon2id"; iterations: number; memoryMiB: number; parallelism: number };

export class VaultwardenDecryptError extends Error {
  constructor(message = "Vaultwarden value could not be decrypted") {
    super(message);
    this.name = "VaultwardenDecryptError";
  }
}

export class VaultwardenArgon2UnsupportedError extends Error {
  constructor() {
    super("This runtime cannot derive Argon2id keys; use Node.js 24.7 or newer");
    this.name = "VaultwardenArgon2UnsupportedError";
  }
}

const base64 = /^[A-Za-z0-9+/]+={0,2}$/;

function decodeBase64(part: string | undefined): Buffer {
  if (!part || !base64.test(part)) throw new VaultwardenDecryptError("Malformed encrypted value");
  return Buffer.from(part, "base64");
}

export function parseEncString(value: string): EncString {
  const dot = value.indexOf(".");
  const type = value.slice(0, dot);
  const parts = value.slice(dot + 1).split("|");
  if (type === "2" && parts.length === 3) {
    const [iv, data, mac] = parts.map(decodeBase64) as [Buffer, Buffer, Buffer];
    return { type: 2, iv, data, mac };
  }
  if (type === "4" && parts.length === 1) return { type: 4, data: decodeBase64(parts[0]) };
  throw new VaultwardenDecryptError("Unsupported encrypted value type");
}

export function symmetricKey(bytes: Buffer): SymmetricKey {
  if (bytes.length !== 64) throw new VaultwardenDecryptError("Unexpected key length");
  return { enc: bytes.subarray(0, 32), mac: bytes.subarray(32) };
}

export function decryptBytes(value: string, key: SymmetricKey): Buffer {
  const parsed = parseEncString(value);
  if (parsed.type !== 2) throw new VaultwardenDecryptError("Expected a symmetric encrypted value");
  const mac = nodeCrypto
    .createHmac("sha256", key.mac)
    .update(Buffer.concat([parsed.iv, parsed.data]))
    .digest();
  if (parsed.mac.length !== mac.length || !nodeCrypto.timingSafeEqual(parsed.mac, mac))
    throw new VaultwardenDecryptError("Encrypted value failed integrity check");
  try {
    const decipher = nodeCrypto.createDecipheriv("aes-256-cbc", key.enc, parsed.iv);
    return Buffer.concat([decipher.update(parsed.data), decipher.final()]);
  } catch {
    throw new VaultwardenDecryptError();
  }
}

export function decryptText(value: string, key: SymmetricKey): string {
  return decryptBytes(value, key).toString("utf8");
}

export function unwrapRsaKey(value: string, privateKeyDer: Buffer): SymmetricKey {
  const parsed = parseEncString(value);
  if (parsed.type !== 4) throw new VaultwardenDecryptError("Expected an RSA encrypted value");
  try {
    const key = nodeCrypto.createPrivateKey({ key: privateKeyDer, format: "der", type: "pkcs8" });
    return symmetricKey(
      nodeCrypto.privateDecrypt(
        { key, oaepHash: "sha1", padding: nodeCrypto.constants.RSA_PKCS1_OAEP_PADDING },
        parsed.data,
      ),
    );
  } catch (error) {
    if (error instanceof VaultwardenDecryptError) throw error;
    throw new VaultwardenDecryptError();
  }
}

/** Fails unless the private key is a usable PKCS#8 key, so a wrong user key never passes. */
export function decryptPrivateKey(value: string, userKey: SymmetricKey): Buffer {
  const der = decryptBytes(value, userKey);
  try {
    nodeCrypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  } catch {
    throw new VaultwardenDecryptError("Private key is not valid");
  }
  return der;
}

export async function deriveMasterKey(
  password: string,
  salt: string,
  kdf: VaultwardenKdf,
): Promise<Buffer> {
  if (kdf.type === "pbkdf2") {
    return await new Promise((resolve, reject) =>
      nodeCrypto.pbkdf2(password, salt, kdf.iterations, 32, "sha256", (error, key) =>
        error ? reject(error) : resolve(key),
      ),
    );
  }
  if (typeof nodeCrypto.argon2 !== "function") throw new VaultwardenArgon2UnsupportedError();
  const nonce = nodeCrypto.createHash("sha256").update(salt).digest();
  return await new Promise((resolve, reject) =>
    nodeCrypto.argon2(
      "argon2id",
      {
        message: Buffer.from(password, "utf8"),
        nonce,
        parallelism: kdf.parallelism,
        memory: kdf.memoryMiB * 1024,
        passes: kdf.iterations,
        tagLength: 32,
      },
      (error, key) => (error ? reject(error) : resolve(Buffer.from(key))),
    ),
  );
}

function hkdfExpand(prk: Buffer, info: string): Buffer {
  return nodeCrypto
    .createHmac("sha256", prk)
    .update(Buffer.concat([Buffer.from(info), Buffer.from([1])]))
    .digest();
}

/** Bitwarden stretches the 32-byte master key with HKDF-Expand only (no extract step). */
export function stretchMasterKey(masterKey: Buffer): SymmetricKey {
  return { enc: hkdfExpand(masterKey, "enc"), mac: hkdfExpand(masterKey, "mac") };
}

export function uriChecksum(uri: string): string {
  return nodeCrypto.createHash("sha256").update(uri, "utf8").digest("base64");
}
