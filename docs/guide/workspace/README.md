# Your workspace

A workspace is more than a tenant boundary. It holds an agent that works for you, a file tree that
agent writes into, the environments your evals run in, and the registry that says where their images
came from.

- **[Workspace agents](agents.md)** — the agent that runs *inside* Everdict, and how it wakes itself
- **[What the agent knows](agent-context.md)** — three layers of context, and time as a coordinate
- **[The workspace filesystem](filesystem.md)** — one file tree per workspace, with attributed revisions
- **[Environments](environments.md)** — `repo` · `prompt` · `browser` · `os-use`, and which one a task deserves
- **[Secrets](secrets.md)** — every credential, by name, encrypted at rest
- **[Image registry](image-registry.md)** — publishing images, and the provenance that makes two scorecards comparable

These four connect: an agent writes its output to the filesystem, an eval runs in an environment, and
that environment is an image whose reference decides whether last week's number means anything.

- **[Browser profiles](browser-profiles.md)** — a captured session, so a case is about the task rather than the login

For the boundary itself — roles, secrets, isolation — see [Workspace](../concepts/workspace.md).
