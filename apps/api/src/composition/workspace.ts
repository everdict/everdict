import { MembershipService } from "@everdict/application-control";
import { ProfileService } from "@everdict/application-control";
import { RunnerService } from "@everdict/application-control";
import { WorkspaceService } from "@everdict/application-control";
import type { RunnerStore, UserProfileStore, WorkspaceInviteStore, WorkspaceStore } from "@everdict/db";
import type { ScheduleServiceRef } from "./schedule.js";

// Early workspace-membership services (workspace/membership/profile/runner). MembershipService's member-removal hook
// resolves the (late-bound) ScheduleService through the shared reference — the only construction cycle seam, isolated
// in schedule.ts. See ScheduleServiceRef for why this is late-bound rather than a direct service reference.
export function buildWorkspace(deps: {
  workspaceStore: WorkspaceStore;
  inviteStore: WorkspaceInviteStore;
  userProfileStore: UserProfileStore;
  runnerStore: RunnerStore;
  scheduleRef: ScheduleServiceRef;
}) {
  const { workspaceStore, inviteStore, userProfileStore, runnerStore, scheduleRef } = deps;
  const workspaceService = new WorkspaceService(workspaceStore);
  const membershipService = new MembershipService(
    workspaceStore,
    inviteStore,
    userProfileStore,
    (ws, sub) => scheduleRef.require().disableByCreator(ws, sub),
    // Lets createInvite return the full shareable link (…/invite?token=…) — same default as the other web-base sites.
    process.env.WEB_BASE_URL ?? "http://localhost:3001",
  );
  const profileService = new ProfileService(userProfileStore);
  const runnerService = new RunnerService(runnerStore);
  return { workspaceService, membershipService, profileService, runnerService };
}
