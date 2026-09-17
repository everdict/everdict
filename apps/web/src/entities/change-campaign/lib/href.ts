// One `change` campaign's address. The segment is SINGULAR because it addresses one campaign, matching the
// evaluated grade's `/{workspace}/campaign/{id}` beside it.
//
// The id is ENCODED for the same reason `controlPlane.getChangeCampaign` encodes it one layer down: an id that
// is not a bare uuid would otherwise mean one thing to the link and another to the read, and the page would
// fetch a campaign the address does not name.
export function changeCampaignHref(workspace: string, id: string): string {
  return `/${workspace}/change-campaign/${encodeURIComponent(id)}`
}
