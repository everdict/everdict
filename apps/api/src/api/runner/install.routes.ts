import { isRunnerToken, renderRunnerInstallScript } from "@everdict/application-control";
import type { FastifyInstance } from "fastify";
import { baseUrl } from "../route-context.js";

// Public runner bootstrap — `GET /install.sh?token=rnr_…` renders the `curl … | sh` installer that downloads the
// standalone everdict-runner binary and pairs this machine (docs/architecture/runner-distribution.md). It is
// UNAUTHENTICATED by design: the pairing token IS the credential (the runner authenticates with it when it connects),
// exactly as the raw attach command already exposes it. The token is boundary-validated before it is embedded so a
// crafted `token` can't inject into the served script. The release repo is a deployment constant (env, default the
// public repo) that names where the cli-release workflow published the everdict-runner-* assets.
export function registerRunnerInstallRoutes(app: FastifyInstance): void {
  const releaseRepo = process.env.EVERDICT_RELEASE_REPO ?? "everdict/everdict";
  app.get<{ Querystring: { token?: string; "api-url"?: string } }>("/install.sh", async (req, reply) => {
    const token = req.query.token;
    if (!token || !isRunnerToken(token)) {
      // Plain-text 400 so a `curl … | sh` fails loudly (curl -f) instead of piping an HTML error into sh.
      return reply.code(400).type("text/plain").send("# Missing or malformed ?token=rnr_… (pairing token required).\n");
    }
    // api-url the runner connects to: an explicit override wins, else the base this request came in on (publicly reachable).
    const apiUrl = req.query["api-url"] ?? baseUrl(req);
    return reply.type("text/x-shellscript").send(renderRunnerInstallScript({ token, apiUrl, releaseRepo }));
  });
}
