// 프로덕트/릴리즈 주소는 전부 여기서 만든다(팀 슬러그와 같은 규칙 — 손으로 문자열을 조립하지 않는다).
// 컬렉션은 복수(/products), 하나는 단수(/product/:id, /release/:id).
export function productsHref(workspace: string): string {
  return `/${workspace}/products`
}

export function productHref(workspace: string, id: string): string {
  return `/${workspace}/product/${encodeURIComponent(id)}`
}

export function newProductHref(workspace: string): string {
  return `/${workspace}/products/new`
}

export function releaseHref(workspace: string, id: string): string {
  return `/${workspace}/release/${encodeURIComponent(id)}`
}
