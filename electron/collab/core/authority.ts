/** Account IDs are unique only within the server that issued them. */
export interface AccountAuthority {
  accountId: string;
  serverUrl: string;
}

export function normalizedServerUrl(value: string): string {
  return new URL(value).href.replace(/\/+$/, "");
}

export function sameAuthority(left: AccountAuthority, right: AccountAuthority): boolean {
  return left.accountId === right.accountId && normalizedServerUrl(left.serverUrl) === normalizedServerUrl(right.serverUrl);
}
