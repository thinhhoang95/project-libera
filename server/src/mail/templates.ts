// Plain-text email templates. Names and project titles come from users, so
// they are flattened to one line to keep headers and layout intact.

import type { MailMessage } from "./index.js";

function oneLine(value: string, max = 120): string {
  const flat = value.replace(/[\r\n\t]+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const ROLE_LABEL: Record<string, string> = {
  editor: "an editor",
  commenter: "a commenter",
  viewer: "a viewer",
};

export function invitationEmail(input: {
  to: string;
  inviterName: string;
  projectName: string;
  role: string;
  url: string;
  expiresAt: Date;
}): MailMessage {
  const inviter = oneLine(input.inviterName, 80);
  const project = oneLine(input.projectName, 120);
  return {
    to: input.to,
    subject: `${inviter} invited you to "${project}" on Libera`,
    text: [
      `${inviter} invited you to join the shared notebook "${project}" as ${ROLE_LABEL[input.role] ?? input.role}.`,
      "",
      "Open this link in Libera to accept:",
      input.url,
      "",
      `The invitation expires on ${input.expiresAt.toUTCString()}.`,
      "If you did not expect this email, you can ignore it.",
    ].join("\n"),
  };
}

export interface DigestItem {
  line: string;
}

export function digestEmail(input: { to: string; displayName: string; items: DigestItem[]; publicUrl: string }): MailMessage {
  const count = input.items.length;
  return {
    to: input.to,
    subject: `Libera: ${count} unread notification${count === 1 ? "" : "s"}`,
    text: [
      `Hi ${oneLine(input.displayName, 80)},`,
      "",
      `You have ${count} unread notification${count === 1 ? "" : "s"} in your shared notebooks:`,
      "",
      ...input.items.map((item) => `- ${oneLine(item.line, 300)}`),
      "",
      "Open Libera to read and reply.",
      `Server: ${input.publicUrl}`,
    ].join("\n"),
  };
}
