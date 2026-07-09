import { z } from "zod";

// Secret name = env-variable format (since it's injected as job env).
export const SecretNameSchema = z.string().regex(/^[A-Z_][A-Z0-9_]*$/);
