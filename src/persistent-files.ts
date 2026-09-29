import { BlobNotFoundError, get, put } from "@vercel/blob";
import { mkdir, readFile as readLocalFile, writeFile as writeLocalFile } from "node:fs/promises";
import path from "node:path";

function isVercelRuntime(): boolean {
  return process.env.VERCEL === "1";
}

function blobPath(filePath: string): string {
  const relative = path.relative(process.cwd(), path.resolve(filePath)).replaceAll("\\", "/");
  if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) {
    throw new Error("Persistent data path must stay inside the application directory");
  }
  return `media-list-builder/${relative}`;
}

/** Reads private durable data on Vercel, falling back to the deployed seed file. */
export async function readPersistentFile(filePath: string, encoding: BufferEncoding = "utf8"): Promise<string> {
  if (!isVercelRuntime()) return readLocalFile(filePath, encoding);
  let stored;
  try {
    stored = await get(blobPath(filePath), { access: "private", useCache: false });
  } catch (error) {
    if (!(error instanceof BlobNotFoundError)) throw error;
  }
  if (stored?.statusCode === 200) return new Response(stored.stream).text();
  return readLocalFile(filePath, encoding);
}

/** Writes mutable app state to private Blob storage on Vercel and disk locally. */
export async function writePersistentFile(filePath: string, contents: string, encoding: BufferEncoding = "utf8"): Promise<void> {
  if (!isVercelRuntime()) {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeLocalFile(filePath, contents, encoding);
    return;
  }
  await put(blobPath(filePath), contents, {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 0
  });
}
