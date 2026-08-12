// 프로덕트/릴리즈 주소는 전부 여기서 만든다(팀 슬러그와 같은 규칙 — 손으로 문자열을 조립하지 않는다).
// 컬렉션은 복수(/products), 하나는 단수(/product/:slug, /release/:id).
export function productsHref(workspace: string): string {
  return `/${workspace}/products`
}

// 주소로 쓸 참조 — 슬러그가 있으면 슬러그, 없으면 id. 컨트롤 플레인은 둘 다 같은 레코드로 해석하므로
// 슬러그가 아직 없는 행(mig 0169 이전에 쓰인)도 링크가 깨지지 않는다.
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
