import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// 워크스페이스 시크릿(모델/프로바이더 키)의 저장 시 암호화(at-rest). AES-256-GCM 봉투암호화.
// KEK(키암호화키)는 환경(ASSAY_SECRETS_KEY)에서 — 운영은 Vault/KMS 로 대체 권장(infra-deploy 규칙).
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
  if (key.length !== 32) throw new Error("ASSAY_SECRETS_KEY 는 base64 디코딩 시 32바이트(AES-256)여야 합니다.");
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

// ASSAY_SECRETS_KEY(base64 32B) 가 있으면 cipher, 없으면 undefined → 시크릿 기능 비활성(fail-closed).
// 키 생성: `openssl rand -base64 32`.
export function cipherFromEnv(envVar = "ASSAY_SECRETS_KEY"): SecretCipher | undefined {
  const raw = process.env[envVar];
  if (!raw) return undefined;
  return aesGcmCipher(Buffer.from(raw, "base64"));
}
