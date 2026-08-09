import { Router } from "express";
import multerPkg from "multer";
import { requireAdmin, requireAuth } from "../middlewares/auth";
import { cloudinary } from "../lib/cloudinary";
import { asyncHandler, HttpError } from "../lib/errors";
import type { ApiRequest } from "../types/apiRequest";

const uploadStorage = multerPkg.memoryStorage();
const uploadMiddleware = multerPkg({
  storage: uploadStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  // MIME filter: only allow image uploads (defense-in-depth before Cloudinary
  // sees the file — saves bandwidth + blocks malicious payload upload attempts).
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new HttpError(400, "Only image files are allowed"));
    }
  },
});

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
router.post(
  "/assets/upload",
  requireAuth,
  requireAdmin,
  uploadMiddleware.single("file"),
  asyncHandler(async (req: ApiRequest, res) => {
    const file = req.file as Express.Multer.File | undefined;
    if (!file) {
      throw new HttpError(400, "No file uploaded");
    }
    const result = await new Promise<{ secure_url: string }>((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: "envyenhance/assets" },
        (err, result) => {
          if (err || !result) {
            return reject(err ?? new HttpError(500, "Upload failed"));
          }
          resolve(result as { secure_url: string });
        }
      );
      stream.end(file.buffer);
    });
    res.json({ url: result.secure_url });
  }),
);

export default router;
