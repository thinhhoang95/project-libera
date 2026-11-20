/**
 * What tells a local file from another file that later takes its path: when
 * it was created and its size, both of which the tree shows for each file. A
 * move, archive or delete sends it as `fileId` (the shared notebooks' file id
 * does the same job there), and the server refuses the action when the path
 * holds another file by then. Pure, so the renderer can compute it too.
 */
export function localFileIdentity(file: { createdAt: string; size: number }) {
  return `local:${file.createdAt}:${file.size}`;
}
