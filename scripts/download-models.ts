// Download Libera's local models from the command line, on request.
//
//   npm run models:download -- [search|reading|read-aloud|speech|all]
//
// Files go to the same folder the app uses (Preferences' folder if one is set,
// else Libera's application data), with the same resume, size and SHA-256
// checks. Set LIBERA_CONFIG_PATH / LIBERA_DATA_DIR to target a desktop install.
import { LOCAL_MODEL_IDS, cancelLocalModelDownload, getLocalModelStatus, startLocalModelDownload, type LocalModelId } from "../src/lib/models/local-models";
import { cancelSpeechModelsDownload, getSpeechModelsStatus, startSpeechModelsDownload } from "../src/lib/transcription/models";

type Target = LocalModelId | "speech";
const TARGETS: Target[] = [...LOCAL_MODEL_IDS, "speech"];

const targets = (name: string): Target[] => {
  if (name === "all") return TARGETS;
  if (TARGETS.includes(name as Target)) return [name as Target];
  throw new Error(`Unknown model "${name}". Use one of: ${TARGETS.join(", ")}, all.`);
};

const status = (target: Target) => (target === "speech" ? getSpeechModelsStatus() : getLocalModelStatus(target));
const start = (target: Target) => (target === "speech" ? startSpeechModelsDownload() : startLocalModelDownload(target));
const cancel = (target: Target) => (target === "speech" ? cancelSpeechModelsDownload() : cancelLocalModelDownload(target));
const mb = (bytes: number) => `${(bytes / 1e6).toFixed(0)} MB`;

async function download(target: Target) {
  let current = await status(target);
  if (current.state === "ready") {
    console.log(`✓ ${target}: already downloaded (${current.directory})`);
    return;
  }
  console.log(`Downloading ${target} to ${current.directory}`);
  start(target);
  do {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    current = await status(target);
    process.stdout.write(`\r  ${mb(current.downloadedBytes)} / ${mb(current.totalBytes)}   `);
  } while (current.state === "downloading");
  process.stdout.write("\n");
  if (current.state !== "ready") throw new Error(`${target}: ${current.error || "the download did not finish"}`);
  console.log(`✓ ${target}: ${current.directory}`);
}

async function main() {
  const selected = targets(process.argv[2] ?? "all");
  process.on("SIGINT", () => {
    selected.forEach(cancel);
    process.exit(130);
  });
  for (const target of selected) await download(target);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
