// The request for one group's next page — the server component draws the first, and "show more" appends in this shape.
// It is a plain interface because it arrives as a server action's argument FROM the client (`control-plane` is
// server-only and cannot enter the client bundle).
//
// Why the client may assemble the filters itself: authorization is still the CONTROL PLANE's. This request goes out with the signed-in
// person's token, and the workspace and team visibility narrowing is applied again by the server.
export interface IssuePageQuery {
  status?: string[]
  priority?: string[]
  assignee?: string[]
  label?: string[]
  project?: string[]
  cycle?: string[]
  team?: string
  parent?: string
  triage?: boolean
  order?: string
  limit?: number
  cursor?: string
}
