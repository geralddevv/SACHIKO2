import mongoose from "mongoose";

/*
 * One stored file (photo or video) after it has been through the media
 * pipeline in utils/media.js -- always normalized: images are JPEG, videos are
 * faststart H.264 MP4, and both carry a small JPEG thumbnail.
 *
 * Embed this schema anywhere a document needs attachments, so every feature
 * describes its files the same way:
 *
 *   import { mediaAssetSchema } from "../system/mediaAsset.js";
 *   media: { type: [mediaAssetSchema], default: [] },
 */
export const mediaAssetSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ["image", "video"], required: true },
    // Which folder under media/ the file lives in -- one bucket per feature.
    bucket: { type: String, required: true, trim: true },
    filename: { type: String, required: true, trim: true },
    // Small JPEG preview: a downscaled copy for images, a grabbed frame for
    // videos. Lets a list render fast without pulling the full file.
    thumbnail: { type: String, trim: true, default: "" },
    mimeType: { type: String, trim: true, default: "" },
    size: { type: Number, default: 0 },
    width: { type: Number, default: null },
    height: { type: Number, default: null },
    durationSec: { type: Number, default: null },
    // The name the file arrived with -- kept for display/download only; the
    // stored filename is always a random one.
    originalName: { type: String, trim: true, default: "" },
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

export default mediaAssetSchema;
