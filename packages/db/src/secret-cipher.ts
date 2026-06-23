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

// ASSAY_SECRETS_KEY(base64 32B) 가 있으면 cipher, 없으면 undefined → 호출부가 폴백(generatedCipher)을 선택.
// 키 생성: `openssl rand -base64 32`.
export function cipherFromEnv(envVar = "ASSAY_SECRETS_KEY"): SecretCipher | undefined {
  const raw = process.env[envVar];
  if (!raw) return undefined;
  return aesGcmCipher(Buffer.from(raw, "base64"));
}

// 명시 키 없이도 시크릿 기능을 "기본 ON" 으로 유지하기 위한 임시 KEK(랜덤 32B) cipher.
// in-memory 에선 시크릿이 어차피 휘발이라 안전하다. Pg 영속 운영은 ASSAY_SECRETS_KEY 로 키를 고정해야
// 재기동 후에도 기존 시크릿을 복호화할 수 있다(임시 키는 매 부팅마다 달라짐).
export function generatedCipher(): SecretCipher {
  return aesGcmCipher(randomBytes(32));
}
