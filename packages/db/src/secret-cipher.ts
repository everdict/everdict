import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// At-rest encryption for workspace secrets (model/provider keys). AES-256-GCM envelope encryption.
// The KEK (key-encryption key) comes from the environment (EVERDICT_SECRETS_KEY) — for production, replacing it with Vault/KMS is recommended (infra-deploy rule).
export interface EncryptedSecret {
  ciphertext: string; // base64
  iv: string; // base64
  tag: string; // base64 (GCM auth tag)
}

export interface SecretCipher {
  encrypt(plaintext: string): EncryptedSecret;
  decrypt(enc: EncryptedSecret): string;
}

export function aesGcmCipher(key: Buffer): SecretCipher {
  if (key.length !== 32) throw new Error("EVERDICT_SECRETS_KEY must be 32 bytes (AES-256) when base64-decoded.");
  return {
    encrypt(plaintext) {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key, iv);
      const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
      return { ciphertext: ct.toString("base64"), iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64") };
    },
    decrypt({ ciphertext, iv, tag }) {
      const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
      d.setAuthTag(Buffer.from(tag, "base64"));
      return Buffer.concat([d.update(Buffer.from(ciphertext, "base64")), d.final()]).toString("utf8");
    },
  };
}

// If EVERDICT_SECRETS_KEY (base64 32B) is set, a cipher; otherwise undefined → the caller picks the fallback (generatedCipher).
// Key generation: `openssl rand -base64 32`.
export function cipherFromEnv(envVar = "EVERDICT_SECRETS_KEY"): SecretCipher | undefined {
  const raw = process.env[envVar];
  if (!raw) return undefined;
  return aesGcmCipher(Buffer.from(raw, "base64"));
}

// An ephemeral KEK (random 32B) cipher to keep the secrets feature "default-ON" even without an explicit key.
// Safe for in-memory since secrets are ephemeral there anyway. For Pg-persistent production, the key must be fixed via EVERDICT_SECRETS_KEY
// so existing secrets can still be decrypted after a restart (an ephemeral key differs every boot).
export function generatedCipher(): SecretCipher {
  return aesGcmCipher(randomBytes(32));
}
