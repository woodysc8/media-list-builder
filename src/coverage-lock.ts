import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
export async function assertCoverageStopped(directory: string) {
  try {
    const pid = Number(
      await readFile(path.join(directory, ".coverage-server.pid"), "utf8"),
    );
    if (!Number.isInteger(pid) || pid <= 0)
      throw new Error(
        "Invalid coverage lock: inspect .coverage-server.pid before proceeding",
      );
    try {
      process.kill(pid, 0);
    } catch (e: any) {
      if (e.code === "ESRCH") return;
      throw e;
    }
    throw new Error(
      `Coverage server process ${pid} is running. Stop it before resetting or starting another worker.`,
    );
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
  }
}
export async function acquireCoverageLock(directory: string) {
  await mkdir(directory, { recursive: true });
  await assertCoverageStopped(directory);
  const lock = path.join(directory, ".coverage-server.pid");
  await unlink(lock).catch((e: any) => {
    if (e.code !== "ENOENT") throw e;
  });
  await writeFile(lock, String(process.pid), { flag: "wx" });
}
