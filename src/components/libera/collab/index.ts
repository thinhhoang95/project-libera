// Collaboration UI. Components for other parts of the app (the editor wiring
// mounts the pill, the avatars and the banners per tab):
//
//   <CollabStatusPill status={syncStatus} compact? onClick? />
//   <PresenceAvatars users={[{ clientId, name, color, section? }]} max? followingClientId?
//                    onFollow?={(clientId) => …} quiet? onQuietChange?={(quiet) => …} />
//   <RejectedEditBanner rejectedText reason? onDismiss? />
//   <AccessChangedBanner onExport detail? onDismiss? />
//
// The shell mounts CollabProvider once and the small pieces in collab-shell.

export { CollabStatusPill, type CollabStatusPillProps } from "./collab-status-pill";
export { PresenceAvatars, type PresenceAvatarsProps, type PresenceUser } from "./presence-avatars";
export { AccessChangedBanner, RejectedEditBanner, copyText, type AccessChangedBannerProps, type RejectedEditBannerProps } from "./collab-banners";
export { CollabAccountDialog, type CollabAccountDialogProps } from "./collab-account-dialog";
export { ShareNotebookDialog, type ShareNotebookDialogProps } from "./share-notebook-dialog";
export { JoinNotebookDialog, type JoinNotebookDialogProps } from "./join-notebook-dialog";
export { NotificationsBell, groupNotifications, type NotificationsBellProps } from "./notifications-bell";
export { CollabProvider, useCollabShell, type CollabProviderProps, type CollabShellValue } from "./collab-provider";
export {
  CollabJoinButton,
  CollabRailButtons,
  ProjectBadge,
  SharedNotebookBadge,
  collabNotebookMenuItems,
  runCollabNotebookMenuItem,
} from "./collab-shell";
