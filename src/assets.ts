import { mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";

const IMAGE_DOWNLOAD_TIMEOUT_MS = 30_000;

export interface CachedImage {
  imagePath: string;
  imageUrl: string;
}

export interface CacheStoryImageInput {
  libraryDir: string;
  slug: string;
  imageUrl?: string;
  fetchImage?: typeof fetch;
}

export async function cacheStoryImage(input: CacheStoryImageInput): Promise<CachedImage | undefined> {
  if (!input.imageUrl) {
    return undefined;
  }

  const fetchImage = input.fetchImage ?? fetch;
  const response = await fetchImage(input.imageUrl, {
    signal: AbortSignal.timeout(IMAGE_DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Could not download article image: ${response.status}`);
  }

  const contentType = response.headers.get("content-type") ?? undefined;
  const extension = extensionForImage(input.imageUrl, contentType);
  const imageDir = join(input.libraryDir, "images");
  const imagePath = join(imageDir, `${input.slug}${extension}`);
  await mkdir(imageDir, { recursive: true });
  await writeFile(imagePath, Buffer.from(await response.arrayBuffer()));

  return {
    imagePath,
    imageUrl: `/images/${input.slug}${extension}`,
  };
}

export function contentTypeForAsset(filename: string): string {
  const extension = extname(filename).toLowerCase();
  if (extension === ".png") {
    return "image/png";
  }
  if (extension === ".jpg" || extension === ".jpeg") {
    return "image/jpeg";
  }
  if (extension === ".webp") {
    return "image/webp";
  }
  if (extension === ".gif") {
    return "image/gif";
  }
  return "application/octet-stream";
}

function extensionForImage(imageUrl: string, contentType?: string): string {
  if (contentType?.includes("png")) {
    return ".png";
  }
  if (contentType?.includes("jpeg") || contentType?.includes("jpg")) {
    return ".jpg";
  }
  if (contentType?.includes("webp")) {
    return ".webp";
  }

  const extension = extname(unwrapNextImageUrl(imageUrl).split("?")[0] ?? "").toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(extension)) {
    return extension === ".jpeg" ? ".jpg" : extension;
  }
  return ".jpg";
}

function unwrapNextImageUrl(imageUrl: string): string {
  try {
    const nested = new URL(imageUrl).searchParams.get("url");
    return nested ?? imageUrl;
  } catch {
    return imageUrl;
  }
}
