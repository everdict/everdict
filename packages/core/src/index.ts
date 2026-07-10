// L0 relocation (re-architecture P0a, docs/architecture/rearchitecture/00-target-architecture.md):
// The contracts + kernel now live in @everdict/contracts. This package is a compat shell that keeps
// consumers unbroken — when P1 splits kernel functions into @everdict/domain it re-exports both, and the P4 sweep removes it.
// New code should import @everdict/contracts (schemas/errors) directly.
export * from "@everdict/contracts";
