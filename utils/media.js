import path from "path";
import fs from "fs";
import crypto from "crypto";
import { execFile } from "child_process";
import multer from "multer";
import sharp from "sharp";
import ffmpegPath from "ffmpeg-static";

/*
 * Shared media store: one way for the whole app to take a photo or video from
 * a user, shrink it, and hand back a record of what was stored.
 *
 * Everything is normalized on the way in, so nothing downstream has to care
 * what a phone happened to produce:
 *   - images  -> EXIF-rotated JPEG, long edge capped at 1600px
 *   - videos  -> H.264 MP4 (faststart, so it plays before it finishes
 *                downloading), long edge capped at 1280px, mono AAC audio
 *   - both    -> a 400px JPEG thumbnail for lists
 *
 * Files live under media/<bucket>/, one bucket per feature ("maintenance",
 * ...). The stored filename is random; the original name is kept only as a
 * label. Serve files back through sendAsset() -- never by joining a
 * user-supplied name onto a path.
 *
 * Typical use in a route:
 *
 *   const upload = mediaUpload({ bucket: "maintenance", fields: [
 *     { name: "photo", kind: "image", maxCount: 1 },
 *     { name: "video", kind: "video", maxCount: 1 },
 *   ]});
 *   router.post("/x", upload, async (req, res) => {
 *     const assets = await storeUploads(req.files, "maintenance");
 *     // ... save assets on your document; removeAssets(assets) to roll back
 *   });
 */

export const MEDIA_ROOT = path.join(process.cwd(), "media");

const IMAGE_EXTS = [".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"];
const VIDEO_EXTS = [".mp4", ".mov", ".m4v", ".webm", ".avi", ".mkv", ".3gp"];

// Phones hand over big originals; these are the pre-compression ceilings.
const MAX_IMAGE_BYTES = 15 * 1024 * 1024; // 15MB
const MAX_VIDEO_BYTES = 150 * 1024 * 1024; // 150MB

// Compression targets.
const IMAGE_MAX_EDGE = 1600;
const IMAGE_QUALITY = 78;
const THUMB_MAX_EDGE = 400;
const THUMB_QUALITY = 70;
const VIDEO_MAX_EDGE = 1280;
const VIDEO_CRF = 28; // visually fine for a shopfloor clip, ~10x smaller
const VIDEO_MAX_SECONDS = 120; // anything longer is trimmed, not rejected
const FFMPEG_TIMEOUT_MS = 10 * 60 * 1000;

export const bucketDir = (bucket) => path.join(MEDIA_ROOT, sanitizeBucket(bucket));

function sanitizeBucket(bucket) {
  const clean = String(bucket || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(clean)) throw new Error(`Invalid media bucket: "${bucket}"`);
  return clean;
}

export function ensureBucket(bucket) {
  const dir = bucketDir(bucket);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const randomName = () => crypto.randomBytes(16).toString("hex");

export const kindForExt = (filename) => {
  const ext = path.extname(String(filename || "")).toLowerCase();
  if (IMAGE_EXTS.includes(ext)) return "image";
  if (VIDEO_EXTS.includes(ext)) return "video";
  return null;
};

/* ================= UPLOAD MIDDLEWARE ================= */

/*
 * Multer middleware for a set of media fields. Each field declares the kind it
 * accepts ("image", "video" or "any"), and files land in the bucket's tmp
 * folder -- nothing is stored under its final name until it has been
 * compressed by storeUploads().
 *
 * Upload errors come back as JSON ({ success:false, message }) rather than the
 * generic error page, since every caller is a fetch() from a dialog.
 */
export function mediaUpload({ bucket, fields }) {
  const dir = ensureBucket(bucket);
  const tmpDir = path.join(dir, "tmp");
  fs.mkdirSync(tmpDir, { recursive: true });

  const kindByField = new Map(fields.map((f) => [f.name, f.kind || "any"]));

  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, tmpDir),
    filename: (req, file, cb) => cb(null, `${randomName()}${path.extname(file.originalname).toLowerCase()}`),
  });

  const fileFilter = (req, file, cb) => {
    const want = kindByField.get(file.fieldname);
    if (!want) return cb(new Error("Unexpected upload field"));

    const byExt = kindForExt(file.originalname);
    const byMime = file.mimetype?.startsWith("image/") ? "image" : file.mimetype?.startsWith("video/") ? "video" : null;
    const kind = byExt || byMime;

    if (!kind) return cb(new Error("Only image and video files are allowed."));
    if (want !== "any" && kind !== want) {
      return cb(new Error(want === "image" ? "That field expects a photo." : "That field expects a video."));
    }
    // Trust the extension only when the browser agrees it's the same kind --
    // some Android browsers send video/* for .heic and vice versa.
    if (byExt && byMime && byExt !== byMime) {
      return cb(new Error("That file's type doesn't match its contents."));
    }
    cb(null, true);
  };

  const handler = multer({
    storage,
    fileFilter,
    limits: { fileSize: MAX_VIDEO_BYTES, files: fields.reduce((n, f) => n + (f.maxCount || 1), 0) },
  }).fields(fields.map((f) => ({ name: f.name, maxCount: f.maxCount || 1 })));

  return (req, res, next) => {
    handler(req, res, async (err) => {
      if (err) {
        await removeTempFiles(req.files);
        const message =
          err.code === "LIMIT_FILE_SIZE"
            ? `File too large (max ${Math.round(MAX_VIDEO_BYTES / 1024 / 1024)}MB).`
            : err.message || "Upload failed.";
        return res.status(400).json({ success: false, message });
      }

      // Images get a tighter ceiling than the multer limit, which has to be set
      // to the video size to let a clip through at all.
      const oversizeImage = flattenFiles(req.files).find(
        (f) => kindForExt(f.originalname) === "image" && f.size > MAX_IMAGE_BYTES,
      );
      if (oversizeImage) {
        await removeTempFiles(req.files);
        return res
          .status(400)
          .json({ success: false, message: `Photo too large (max ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB).` });
      }

      next();
    });
  };
}

const flattenFiles = (files) => (files ? Object.values(files).flat().filter(Boolean) : []);

export async function removeTempFiles(files) {
  await Promise.all(flattenFiles(files).map((f) => fs.promises.unlink(f.path).catch(() => {})));
}

/* ================= COMPRESSION ================= */

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error("ffmpeg is not available on this platform"));
    execFile(
      ffmpegPath,
      ["-hide_banner", "-loglevel", "info", "-nostdin", ...args],
      { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr })) : resolve(String(stderr || ""))),
    );
  });
}

// ffmpeg has no machine-readable output here (ffprobe isn't bundled), so the
// duration and the encoded size are read back off its log. Best-effort: a miss
// just leaves the metadata null.
function parseFfmpegMeta(log) {
  const duration = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(log);
  const durationSec = duration
    ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Math.round(Number(duration[3]))
    : null;

  // Take the resolution from the Output section, which is the encoded size.
  const outputPart = log.includes("Output #0") ? log.slice(log.indexOf("Output #0")) : log;
  const size = /Video:.*?,\s*(\d{2,5})x(\d{2,5})/.exec(outputPart);

  return {
    durationSec,
    width: size ? Number(size[1]) : null,
    height: size ? Number(size[2]) : null,
  };
}

async function makeImageThumb(sourcePath, destPath) {
  await sharp(sourcePath)
    .rotate()
    .resize({ width: THUMB_MAX_EDGE, height: THUMB_MAX_EDGE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: THUMB_QUALITY, mozjpeg: true })
    .toFile(destPath);
}

async function storeImage(file, bucket) {
  const dir = ensureBucket(bucket);
  const base = randomName();
  const filename = `${base}.jpg`;
  const thumbnail = `${base}.thumb.jpg`;

  const info = await sharp(file.path)
    .rotate() // phone shots are otherwise sideways
    .resize({ width: IMAGE_MAX_EDGE, height: IMAGE_MAX_EDGE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: IMAGE_QUALITY, mozjpeg: true, progressive: true })
    .toFile(path.join(dir, filename));

  await makeImageThumb(file.path, path.join(dir, thumbnail));

  return {
    kind: "image",
    bucket: sanitizeBucket(bucket),
    filename,
    thumbnail,
    mimeType: "image/jpeg",
    size: info.size,
    width: info.width,
    height: info.height,
    durationSec: null,
    originalName: file.originalname || "",
    uploadedAt: new Date(),
  };
}

async function storeVideo(file, bucket) {
  const dir = ensureBucket(bucket);
  const base = randomName();
  const filename = `${base}.mp4`;
  const thumbnail = `${base}.thumb.jpg`;
  const destPath = path.join(dir, filename);

  // Cap the long edge whichever way the phone was held: landscape scales by
  // width, portrait by height, and -2 keeps the other edge even (H.264 needs it).
  const scale =
    `scale='if(gt(iw,ih),min(${VIDEO_MAX_EDGE},iw),-2)':'if(gt(iw,ih),-2,min(${VIDEO_MAX_EDGE},ih))'`;

  const log = await runFfmpeg([
    "-i", file.path,
    "-t", String(VIDEO_MAX_SECONDS),
    "-vf", scale,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", String(VIDEO_CRF),
    "-pix_fmt", "yuv420p",
    "-r", "30",
    "-c:a", "aac",
    "-b:a", "96k",
    "-ac", "1",
    "-movflags", "+faststart", // metadata up front so it streams immediately
    "-y", destPath,
  ]);

  const meta = parseFfmpegMeta(log);

  // A frame from just inside the clip as the poster (0.5s in, so it isn't the
  // black frame a camera often starts on).
  await runFfmpeg([
    "-ss", "0.5",
    "-i", destPath,
    "-frames:v", "1",
    "-vf", `scale='if(gt(iw,ih),min(${THUMB_MAX_EDGE},iw),-2)':'if(gt(iw,ih),-2,min(${THUMB_MAX_EDGE},ih))'`,
    "-q:v", "4",
    "-y", path.join(dir, thumbnail),
  ]).catch(() => {});

  const hasThumb = fs.existsSync(path.join(dir, thumbnail));
  const { size } = await fs.promises.stat(destPath);

  return {
    kind: "video",
    bucket: sanitizeBucket(bucket),
    filename,
    thumbnail: hasThumb ? thumbnail : "",
    mimeType: "video/mp4",
    size,
    width: meta.width,
    height: meta.height,
    durationSec: meta.durationSec,
    originalName: file.originalname || "",
    uploadedAt: new Date(),
  };
}

/*
 * Compress every uploaded file into the bucket and return the stored assets in
 * field order. The temp uploads are always cleaned up, and if any one file
 * fails the ones already stored are removed too -- so a caller never ends up
 * saving a half-written attachment set.
 */
export async function storeUploads(files, bucket) {
  const uploads = flattenFiles(files);
  const stored = [];

  try {
    for (const file of uploads) {
      const kind = kindForExt(file.originalname) || (file.mimetype?.startsWith("video/") ? "video" : "image");
      stored.push(kind === "video" ? await storeVideo(file, bucket) : await storeImage(file, bucket));
    }
    return stored;
  } catch (err) {
    await removeAssets(stored);
    if (err?.stderr) console.error("MEDIA FFMPEG ERROR:", String(err.stderr).slice(-1200));
    throw new Error(
      err?.message?.includes("ffmpeg") || err?.stderr
        ? "Could not process the video. Please try a shorter clip."
        : "Could not process the attachment.",
    );
  } finally {
    await removeTempFiles(files);
  }
}

/* ================= READING BACK ================= */

// The only place a stored filename becomes a path. basename() strips any
// traversal even though the names are ours.
export function assetPath(asset, { thumb = false } = {}) {
  if (!asset?.bucket || !asset?.filename) return null;
  const name = thumb ? asset.thumbnail || asset.filename : asset.filename;
  if (!name) return null;
  return path.join(bucketDir(asset.bucket), path.basename(name));
}

export function assetExists(asset, opts) {
  const p = assetPath(asset, opts);
  return Boolean(p && fs.existsSync(p));
}

/*
 * Send an asset (or its thumbnail) to the browser. Uses res.sendFile, which
 * honours Range requests -- that's what lets a video seek and start playing
 * without downloading the whole file first. Callers do their own auth check
 * before calling this.
 */
export function sendAsset(res, asset, { thumb = false, download = false } = {}) {
  const filePath = assetPath(asset, { thumb });
  if (!filePath || !fs.existsSync(filePath)) {
    // A missing thumbnail (older asset, or a video whose poster grab failed)
    // falls back to the file itself rather than 404ing the whole tile.
    if (thumb) return sendAsset(res, asset, { thumb: false, download });
    return res.status(404).send("File not found");
  }

  const type = thumb && asset.thumbnail ? "image/jpeg" : asset.mimeType || "application/octet-stream";
  res.setHeader("Content-Type", type);
  res.setHeader("Cache-Control", "private, max-age=3600");
  if (download) {
    const name = String(asset.originalName || asset.filename).replace(/[^\w.-]+/g, "_");
    res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
  }
  return res.sendFile(filePath);
}

// Delete stored files (both the asset and its thumbnail). Safe to call with
// whatever a document happens to hold, including [] or undefined.
export async function removeAssets(assets) {
  const list = Array.isArray(assets) ? assets : [assets];
  await Promise.all(
    list.filter(Boolean).flatMap((asset) =>
      [assetPath(asset), asset.thumbnail ? assetPath(asset, { thumb: true }) : null]
        .filter(Boolean)
        .map((p) => fs.promises.unlink(p).catch(() => {})),
    ),
  );
}

// Human-readable size/duration for list and detail views.
export const formatBytes = (bytes) => {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
};

export const formatDuration = (seconds) => {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export const MEDIA_LIMITS = {
  maxImageBytes: MAX_IMAGE_BYTES,
  maxVideoBytes: MAX_VIDEO_BYTES,
  maxVideoSeconds: VIDEO_MAX_SECONDS,
};
