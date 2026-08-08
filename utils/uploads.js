const multer = require('multer');
const path = require('path');
const fs = require('fs');

const UPLOADS_DIR = path.join(__dirname, '..', 'data', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const ALLOWED_MIME = new Set(['image/png', 'image/x-icon', 'image/vnd.microsoft.icon', 'image/jpeg', 'image/svg+xml', 'image/webp']);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.png';
    const safeField = file.fieldname.replace(/[^a-z_]/gi, '');
    cb(null, `${safeField}-${Date.now()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB is plenty for a favicon/app icon
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      return cb(new Error('Unsupported image type. Use PNG, ICO, JPG, WEBP, or SVG.'));
    }
    cb(null, true);
  },
});

// For uploading files into an S3-compatible bucket - memory storage since
// the file just needs to be streamed to the bucket, never persisted on
// our own disk, and no MIME restriction since bucket contents can be
// anything (unlike the branding upload above, which is images only).
const bucketUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB per file - generous for typical use, but a hard cap so one upload can't tie up the request indefinitely
});

module.exports = { upload, bucketUpload, UPLOADS_DIR };
