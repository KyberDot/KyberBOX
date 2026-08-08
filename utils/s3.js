// Thin wrapper around the AWS SDK's S3 client for talking to any
// S3-compatible object storage provider - Hetzner Object Storage, AWS S3
// itself, Backblaze B2, DigitalOcean Spaces, Cloudflare R2, MinIO, etc.
// The SDK handles all the request signing; this module just adapts it to
// what the buckets admin page actually needs.

const { S3Client, ListObjectsV2Command, DeleteObjectCommand, PutObjectCommand, GetObjectCommand, HeadBucketCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { decrypt } = require('./crypto');

function getClient(bucket) {
  return new S3Client({
    endpoint: bucket.endpoint,
    region: bucket.region || 'auto',
    credentials: {
      accessKeyId: decrypt(bucket.access_key_encrypted),
      secretAccessKey: decrypt(bucket.secret_key_encrypted),
    },
    forcePathStyle: !!bucket.force_path_style,
  });
}

// Confirms the bucket is reachable with the given credentials - used when
// adding a new connection, so a typo in the endpoint or a bad key is
// caught immediately rather than silently failing the first time someone
// tries to browse it.
async function testConnection(bucket) {
  const client = getClient(bucket);
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket.bucket_name }));
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err.message || 'Could not connect to that bucket.' };
  }
}

// Lists objects under a given prefix, one "folder level" at a time using
// S3's delimiter mechanism - Delimiter: '/' makes the API group keys
// sharing a common prefix as "CommonPrefixes" (folders) instead of
// returning every object under them flatly, which is what makes
// practical browsing of a bucket with a folder-like key structure
// possible without listing everything at once.
async function listObjects(bucket, prefix, continuationToken) {
  const client = getClient(bucket);
  const result = await client.send(
    new ListObjectsV2Command({
      Bucket: bucket.bucket_name,
      Prefix: prefix || '',
      Delimiter: '/',
      MaxKeys: 200,
      ContinuationToken: continuationToken || undefined,
    })
  );

  const folders = (result.CommonPrefixes || []).map((p) => p.Prefix);
  const files = (result.Contents || [])
    .filter((obj) => obj.Key !== prefix) // S3 sometimes includes the "folder marker" object itself (a zero-byte object matching the prefix) - not a real file to show
    .map((obj) => ({ key: obj.Key, size: obj.Size, lastModified: obj.LastModified }));

  return {
    folders,
    files,
    isTruncated: !!result.IsTruncated,
    nextContinuationToken: result.NextContinuationToken || null,
  };
}

// Walks every object in the bucket to compute total size and count.
// There's no single S3 API call that returns "bucket size" reliably
// across every provider, so this has to paginate through everything.
// Capped at a generous but finite number of pages so a bucket with an
// enormous number of objects can't hang the request indefinitely - if it
// hits the cap, the totals returned are a lower bound and isComplete is
// false, which the caller can use to say so rather than presenting a
// possibly-partial number as definitive.
async function getBucketStats(bucket) {
  const client = getClient(bucket);
  const MAX_PAGES = 500; // up to 100,000 objects (200 per page) before giving up and reporting a partial total

  let totalSize = 0;
  let totalCount = 0;
  let continuationToken;
  let pages = 0;
  let isComplete = true;

  do {
    const result = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket.bucket_name,
        MaxKeys: 200,
        ContinuationToken: continuationToken,
      })
    );

    (result.Contents || []).forEach((obj) => {
      totalSize += obj.Size || 0;
      totalCount += 1;
    });

    continuationToken = result.NextContinuationToken;
    pages += 1;

    if (pages >= MAX_PAGES && continuationToken) {
      isComplete = false;
      break;
    }
  } while (continuationToken);

  return { totalSize, totalCount, isComplete };
}

async function deleteObject(bucket, key) {
  const client = getClient(bucket);
  await client.send(new DeleteObjectCommand({ Bucket: bucket.bucket_name, Key: key }));
}

async function uploadObject(bucket, key, buffer, contentType) {
  const client = getClient(bucket);
  await client.send(
    new PutObjectCommand({
      Bucket: bucket.bucket_name,
      Key: key,
      Body: buffer,
      ContentType: contentType || 'application/octet-stream',
    })
  );
}

// A time-limited URL the browser can download the file from directly,
// without the file passing through our own server at all - important
// for anything large, since proxying would tie up a request for as long
// as the download takes and double the bandwidth used.
async function getDownloadUrl(bucket, key) {
  const client = getClient(bucket);
  const command = new GetObjectCommand({ Bucket: bucket.bucket_name, Key: key });
  return getSignedUrl(client, command, { expiresIn: 300 }); // 5 minutes - long enough to start a download, short enough not to linger as a standing credential
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
}

module.exports = { testConnection, listObjects, getBucketStats, deleteObject, uploadObject, getDownloadUrl, formatBytes };
