import type { MattermostClient } from "@everdict/application-control";

// The fetch-backed Mattermost adapter — owns the wire protocol (/api/v4/posts, bot-token bearer,
// props.attachments envelope). The injectable fetch keeps tests recording the exact wire bytes.
export function mattermostHttpClient(fetchImpl: typeof fetch = fetch): MattermostClient {
  return {
    async post(host, botToken, post) {
      const base = host.endsWith("/") ? host.slice(0, -1) : host;
      await fetchImpl(`${base}/api/v4/posts`, {
        method: "POST",
        headers: { authorization: `Bearer ${botToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          channel_id: post.channelId,
          message: post.message,
          ...(post.attachments ? { props: { attachments: post.attachments } } : {}),
        }),
      });
    },
  };
}
