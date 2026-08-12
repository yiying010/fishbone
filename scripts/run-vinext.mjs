import { spawnSync } from "node:child_process";

const command = process.argv[2] || "build";
const args = process.argv.slice(3);

process.env.WRANGLER_LOG_PATH ||= ".wrangler/wrangler.log";

const result = spawnSync("vinext", [command, ...args], {
  env: process.env,
  shell: true,
  stdio: "inherit",
});

process.exit(result.status ?? 1);
