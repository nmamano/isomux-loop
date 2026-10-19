// Screenshots attached to packets and sign-off items, kept under the data dir.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ValidationError } from "./store";

export type Image = { file: string; caption: string; type: string };

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGES = 20;
const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/;
const FILE = /^[0-9]{1,3}\.(png|jpg|webp)$/;

// The type comes from the bytes, never from a header.
export function sniff(bytes: Uint8Array): { ext: string; type: string } | null {
  const b = bytes;
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { ext: "png", type: "image/png" };
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: "jpg", type: "image/jpeg" };
  if (
    b.length > 12 &&
    String.fromCharCode(b[0], b[1], b[2], b[3]) === "RIFF" &&
    String.fromCharCode(b[8], b[9], b[10], b[11]) === "WEBP"
  )
    return { ext: "webp", type: "image/webp" };
  return null;
}

export function checkTaskId(taskId: string): string {
  if (!TASK_ID.test(taskId)) throw new ValidationError("taskId must be a board task id");
  return taskId;
}

export class ImageDir {
  constructor(private root: string) {}

  private dir(taskId: string): string {
    return join(this.root, checkTaskId(taskId));
  }

  save(taskId: string, current: Image[], bytes: Uint8Array, caption: string): Image {
    if (bytes.length === 0) throw new ValidationError("the body must be the image bytes");
    if (bytes.length > MAX_IMAGE_BYTES) throw new ValidationError(`an image is at most ${MAX_IMAGE_BYTES} bytes`);
    if (current.length >= MAX_IMAGES) throw new ValidationError(`at most ${MAX_IMAGES} images per item`);
    if (caption.length > 500) throw new ValidationError("caption is longer than 500 characters");
    const kind = sniff(bytes);
    if (!kind) throw new ValidationError("only PNG, JPEG and WebP images");
    const dir = this.dir(taskId);
    mkdirSync(dir, { recursive: true });
    const file = `${current.length + 1}.${kind.ext}`;
    writeFileSync(join(dir, file), bytes);
    return { file, caption, type: kind.type };
  }

  read(taskId: string, file: string): Uint8Array | null {
    if (!TASK_ID.test(taskId) || !FILE.test(file)) return null;
    const path = join(this.root, taskId, file);
    return existsSync(path) ? readFileSync(path) : null;
  }

  clear(taskId: string): void {
    rmSync(this.dir(taskId), { recursive: true, force: true });
  }
}
