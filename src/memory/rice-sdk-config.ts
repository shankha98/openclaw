import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const GENERATED_RICE_CONFIG = `module.exports = {
  storage: { enabled: true },
  state: { enabled: true },
};
`;

let cachedConfigPath: string | null = null;
let initPromise: Promise<string> | null = null;

async function writeConfigFile(filePath: string): Promise<void> {
  try {
    const existing = await fs.readFile(filePath, "utf8");
    if (existing === GENERATED_RICE_CONFIG) {
      return;
    }
  } catch {
    // Missing file is expected the first time.
  }
  await fs.writeFile(filePath, GENERATED_RICE_CONFIG, "utf8");
}

export async function ensureRiceSdkConfigPath(): Promise<string> {
  if (cachedConfigPath) {
    return cachedConfigPath;
  }
  if (initPromise) {
    return initPromise;
  }

  initPromise = (async () => {
    const dir = path.join(os.tmpdir(), "openclaw-rice-sdk");
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, "rice.config.js");
    await writeConfigFile(filePath);
    cachedConfigPath = filePath;
    return filePath;
  })();

  try {
    return await initPromise;
  } finally {
    initPromise = null;
  }
}
