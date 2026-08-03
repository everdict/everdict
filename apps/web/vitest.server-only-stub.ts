// `server-only` is a build-time MARKER, not a runtime module: Next resolves it to a file that throws if a module
// ever lands in the client graph. Vitest is neither graph, and the package is not a dependency of this app, so the
// import simply fails to resolve — which made a client component that calls a server action untestable.
//
// Aliasing it to nothing restores that: the boundary is still enforced where it is real (the Next build), and a
// test can render a `'use client'` component whose action module sits behind it.
export {}
