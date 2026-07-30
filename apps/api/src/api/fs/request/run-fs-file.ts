import { FILE_EXECUTION_MAX_TIMEOUT_SEC } from "@everdict/contracts";
import { z } from "zod";

// POST /fs/executions — run one file from the workspace filesystem in an isolated sandbox and get back what it
// printed plus what it wrote. Paths are normalized server-side, like every other fs route.
//
// `image` overrides the interpreter's default image — pass a workspace environment image to run the script
// against the same dependencies an eval case would get. The interpreter still follows the extension.
export const RunFsFileBodySchema = z.object({
  path: z.string().min(1).max(600),
  image: z.string().min(1).max(512).optional(),
  timeoutSec: z.number().int().min(1).max(FILE_EXECUTION_MAX_TIMEOUT_SEC).optional(),
});
export type RunFsFileBody = z.infer<typeof RunFsFileBodySchema>;
