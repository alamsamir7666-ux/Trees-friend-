import { Router } from "express";
import multerPkg from "multer";
import { v2 as cloudinaryV2 } from "cloudinary";
import { requireAdmin, requireAuth } from "../middlewares/auth";

cloudinaryV2.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const uploadStorage = multerPkg.memoryStorage();
const uploadMiddleware = multerPkg({ storage: uploadStorage, limits: { fileSize: 5 * 1024 * 1024 } });

const router = Router();

/**
 * Generic asset upload -- icons, badges, logos, and any other non-product
 * image. Unlike /products/upload-image, this endpoint does NOT force a
 * format conversion (no f_jpg on the "primary" file, no webp re-encode).
 * That coercion is correct for product photo galleries but silently
 * destroys transparency on icons/logos (JPG has no alpha channel), so
 * asset uploads get their own endpoint instead of a conditional flag on
 * the product route.
 */
router.post("/assets/upload", requireAuth, requireAdmin, uploadMiddleware.single("file"), async (req: any, res) => {
  try {
    const file = req.file as Express.Multer.File | undefined;
    if (!file) {
      res.status(400).json({ error: "No file uploaded" });
      return;
    }
    const result = await new Promise<{ secure_url: string }>((resolve, reject) => {
      const stream = cloudinaryV2.uploader.upload_stream(
        { folder: "envyenhance/assets" },
        (err, result) => {
          if (err || !result) { console.error("Cloudinary error:", err); return reject(err ?? new Error("Upload failed")); }
          resolve(result as { secure_url: string });
        }
      );
      stream.end(file.buffer);
    });
    res.json({ url: result.secure_url });
  } catch (err) {
    console.error("Asset upload endpoint error:", err);
    res.status(500).json({ error: "Upload failed", details: String(err) });
  }
});

export default router;
