// Every product and release address is built here (the same rule as team slugs — strings are never assembled by hand).
// A collection is plural (/products) and one of them is singular (/product/:slug, /release/:id).
export function productsHref(workspace: string): string {
  return `/${workspace}/products`
}

// The reference used as the address — the slug when there is one, else the id. The control plane resolves both to the same record, so a row
// that has no slug yet (written before mig 0169) does not get a broken link.
export function productRef(product: { id: string; slug?: string }): string {
  return product.slug ?? product.id
}

export function productHref(workspace: string, ref: string): string {
  return `/${workspace}/product/${encodeURIComponent(ref)}`
}

export function newProductHref(workspace: string): string {
  return `/${workspace}/products/new`
}

export function releaseHref(workspace: string, id: string): string {
  return `/${workspace}/release/${encodeURIComponent(id)}`
}
