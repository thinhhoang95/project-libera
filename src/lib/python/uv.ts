// uv installs Libera's private Python runtimes (detection, and Python in
// notes) without touching the system. One pinned, checksummed release.

export const UV_VERSION = "0.13.1";

export const UV_ASSETS: Record<string, { file: string; size: number; sha256: string }> = {
  "darwin-arm64": { file: "uv-aarch64-apple-darwin.tar.gz", size: 14280170, sha256: "cfe454573412ff7380d15fc7dae5997ab53ffce72fce0a78e91ddbc84001acd2" },
  "darwin-x64": { file: "uv-x86_64-apple-darwin.tar.gz", size: 17491796, sha256: "bb7b805bdcf3d0bc8c74ceb94569e6b3e8aa35bd492acdbb9d46bf46d9d4ff6b" },
  "win32-x64": { file: "uv-x86_64-pc-windows-msvc.zip", size: 15308685, sha256: "3b2661a463a5baea7f5076ea2b25ab71d77f36a6c0d809e5350651792f80a672" },
  "win32-arm64": { file: "uv-aarch64-pc-windows-msvc.zip", size: 15802989, sha256: "ec7846a5939b4654afee24f2d82bf6fde71bd7a6952d7748f1135ab301dd0a49" },
};

export function uvAsset(platform: string = process.platform, arch: string = process.arch) {
  return UV_ASSETS[`${platform}-${arch}`] ?? null;
}

export function uvDownloadUrl(file: string) {
  return `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${file}`;
}
