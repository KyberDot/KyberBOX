// Thin wrapper around ssh2's built-in SFTP support - the same library
// already used elsewhere in this app for the admin SSH console and
// health checks (utils/ssh.js), so no new dependency was needed for
// this. Exposes the same operation shape as utils/s3.js (list/stats/
// upload/download/delete) so the Storage page's frontend can browse
// either an S3 bucket or an SFTP box through one unified interface,
// even though the underlying protocols work quite differently - S3 has
// a flat keyspace with synthetic "folders" via key prefixes, SFTP has
// real directories that need actual recursive traversal for a full
// stats scan.

const { Client } = require('ssh2');
const { decrypt } = require('./crypto');

function connect(box) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn.on('ready', () => {
      conn.sftp((err, sftp) => {
        if (err) {
          conn.end();
          return reject(err);
        }
        resolve({ conn, sftp });
      });
    });
    conn.on('error', (err) => reject(err));

    const connectOptions = {
      host: box.host,
      port: box.port || 22,
      username: box.username,
      readyTimeout: 15000,
    };
    if (box.auth_type === 'key') {
      connectOptions.privateKey = decrypt(box.secret_encrypted);
    } else {
      connectOptions.password = decrypt(box.secret_encrypted);
    }
    conn.connect(connectOptions);
  });
}

// Runs fn(sftp) with a connection, always closing it afterward whether
// fn succeeds or throws - callers never need to remember to clean up.
async function withSftp(box, fn) {
  const { conn, sftp } = await connect(box);
  try {
    return await fn(sftp);
  } finally {
    conn.end();
  }
}

function joinPath(base, name) {
  if (base === '/' || base === '') return '/' + name;
  return base.replace(/\/+$/, '') + '/' + name;
}

async function testConnection(box) {
  try {
    await withSftp(box, (sftp) => {
      return new Promise((resolve, reject) => {
        sftp.readdir(box.root_path || '/', (err) => {
          if (err) return reject(err);
          resolve();
        });
      });
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err.message || 'Could not connect to that storage box.' };
  }
}

// Lists a single directory level - folders and files separated, matching
// the shape utils/s3.js's listObjects returns, so the frontend file
// browser can treat both the same way. No pagination token concept here
// since SFTP's readdir returns a directory's full contents in one call,
// unlike S3's paginated key listing.
async function listObjects(box, dirPath) {
  const path = dirPath || box.root_path || '/';
  return withSftp(box, (sftp) => {
    return new Promise((resolve, reject) => {
      sftp.readdir(path, (err, list) => {
        if (err) return reject(err);

        const folders = [];
        const files = [];
        list.forEach((entry) => {
          const fullPath = joinPath(path, entry.filename);
          const isDir = (entry.attrs.mode & 0o170000) === 0o040000; // S_IFDIR bit, the standard way to tell a directory apart from a regular file in POSIX file mode bits
          if (isDir) {
            folders.push(fullPath + '/');
          } else {
            files.push({ key: fullPath, size: entry.attrs.size, lastModified: new Date(entry.attrs.mtime * 1000) });
          }
        });

        resolve({ folders, files, isTruncated: false, nextContinuationToken: null });
      });
    });
  });
}

// Recursively walks every directory from root_path to compute total size
// and file count - there's no single-call equivalent to S3's flat
// ListObjectsV2 here, so this has to descend into each subdirectory in
// turn. Capped at a generous but finite number of directories visited,
// same reasoning as utils/s3.js's page cap: a pathological directory
// tree shouldn't be able to hang the request indefinitely. If the cap is
// hit, the totals are a lower bound and isComplete is false.
async function getBucketStats(box) {
  const MAX_DIRS = 2000;
  let totalSize = 0;
  let totalCount = 0;
  let dirsVisited = 0;
  let isComplete = true;

  await withSftp(box, async (sftp) => {
    const readdirAsync = (path) =>
      new Promise((resolve, reject) => {
        sftp.readdir(path, (err, list) => (err ? reject(err) : resolve(list)));
      });

    const queue = [box.root_path || '/'];

    while (queue.length > 0) {
      if (dirsVisited >= MAX_DIRS) {
        isComplete = false;
        break;
      }

      const dirPath = queue.shift();
      dirsVisited += 1;

      let list;
      try {
        list = await readdirAsync(dirPath);
      } catch (err) {
        continue; // permission error or similar on one subdirectory - skip it rather than fail the whole scan
      }

      list.forEach((entry) => {
        const isDir = (entry.attrs.mode & 0o170000) === 0o040000;
        if (isDir) {
          queue.push(joinPath(dirPath, entry.filename));
        } else {
          totalSize += entry.attrs.size || 0;
          totalCount += 1;
        }
      });
    }
  });

  return { totalSize, totalCount, isComplete };
}

async function deleteObject(box, key) {
  return withSftp(box, (sftp) => {
    return new Promise((resolve, reject) => {
      sftp.unlink(key, (err) => (err ? reject(err) : resolve()));
    });
  });
}

async function uploadObject(box, key, buffer) {
  return withSftp(box, (sftp) => {
    return new Promise((resolve, reject) => {
      const stream = sftp.createWriteStream(key);
      stream.on('error', reject);
      stream.on('close', resolve);
      stream.end(buffer);
    });
  });
}

// Unlike S3, SFTP has no concept of a presigned URL - there's no public
// HTTP endpoint to hand the browser at all, so the file has to be
// streamed through our own server. Returns a Buffer directly, which the
// route can send as a download response.
async function downloadObject(box, key) {
  return withSftp(box, (sftp) => {
    return new Promise((resolve, reject) => {
      const chunks = [];
      const stream = sftp.createReadStream(key);
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('error', reject);
      stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
  });
}

module.exports = { testConnection, listObjects, getBucketStats, deleteObject, uploadObject, downloadObject };
