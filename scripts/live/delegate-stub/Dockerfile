# A stand-in delegate image for the delegation drills: a `claude` on PATH that speaks the stream-json protocol
# and keeps a per-cwd session store, so --resume really continues a thread. It does real work too (it runs the
# shell command a brief asks for), which is what lets a drill verify a delegation instead of mocking one.
# `npm` is shadowed so the harness's sandbox-install step is a no-op against the baked binary.
FROM node:22-bookworm-slim
COPY claude /usr/local/sbin/claude
COPY npm /usr/local/sbin/npm
RUN chmod +x /usr/local/sbin/claude /usr/local/sbin/npm
