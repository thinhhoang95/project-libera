const fs = require("node:fs");
const fsPromises = require("node:fs/promises");

// Some removable/shared Windows filesystems return EISDIR when readlink is
// called for an ordinary file or directory. Node normally returns EINVAL on
// Windows, which is what Webpack's filesystem snapshotter expects when it
// probes paths for symlinks.
function normalizeReadlinkError(error) {
  if (
    process.platform === "win32" &&
    error?.code === "EISDIR" &&
    error?.syscall === "readlink"
  ) {
    error.code = "EINVAL";
  }

  return error;
}

const readlink = fs.readlink;
fs.readlink = function patchedReadlink(...args) {
  const callback = args.at(-1);

  if (typeof callback === "function") {
    args[args.length - 1] = (error, result) =>
      callback(normalizeReadlinkError(error), result);
  }

  return readlink.apply(this, args);
};

const readlinkSync = fs.readlinkSync;
fs.readlinkSync = function patchedReadlinkSync(...args) {
  try {
    return readlinkSync.apply(this, args);
  } catch (error) {
    throw normalizeReadlinkError(error);
  }
};

const readlinkPromise = fsPromises.readlink;
fsPromises.readlink = async function patchedReadlinkPromise(...args) {
  try {
    return await readlinkPromise.apply(this, args);
  } catch (error) {
    throw normalizeReadlinkError(error);
  }
};
