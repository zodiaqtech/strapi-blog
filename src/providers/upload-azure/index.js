'use strict';

/**
 * Custom Azure Blob Storage upload provider for Strapi v5
 * Uses @azure/storage-blob SDK directly
 */

const { BlobServiceClient, StorageSharedKeyCredential } = require('@azure/storage-blob');
const { Readable } = require('stream');

module.exports = {
  init(config) {
    const {
      account,
      accountKey,
      containerName,
      cdnBaseURL,   // optional: CDN or custom domain in front of blob storage
    } = config;

    const credential = new StorageSharedKeyCredential(account, accountKey);
    const serviceURL  = `https://${account}.blob.core.windows.net`;
    const blobServiceClient = new BlobServiceClient(serviceURL, credential);
    const containerClient   = blobServiceClient.getContainerClient(containerName);

    // Build the public URL for a blob
    const getPublicURL = (blobName) => {
      const base = cdnBaseURL ? cdnBaseURL.replace(/\/$/, '') : `${serviceURL}/${containerName}`;
      return `${base}/${blobName}`;
    };

    return {
      /**
       * Upload a file (Buffer already in memory)
       */
      async upload(file) {
        const blobName   = file.hash + (file.ext ? file.ext : '');
        const blockBlob  = containerClient.getBlockBlobClient(blobName);
        const buffer     = file.buffer;

        await blockBlob.uploadData(buffer, {
          blobHTTPHeaders: { blobContentType: file.mime },
        });

        file.url = getPublicURL(blobName);
      },

      /**
       * Upload via readable stream (large files)
       */
      async uploadStream(file) {
        const blobName  = file.hash + (file.ext ? file.ext : '');
        const blockBlob = containerClient.getBlockBlobClient(blobName);
        const stream    = file.stream instanceof Readable ? file.stream : Readable.from(file.stream);

        await blockBlob.uploadStream(stream, undefined, undefined, {
          blobHTTPHeaders: { blobContentType: file.mime },
        });

        file.url = getPublicURL(blobName);
      },

      /**
       * Delete a file from Azure Blob
       */
      async delete(file) {
        const blobName  = file.hash + (file.ext ? file.ext : '');
        const blockBlob = containerClient.getBlockBlobClient(blobName);
        await blockBlob.deleteIfExists();
      },

      /**
       * Check file size (optional — Strapi enforces its own limits too)
       */
      checkFileSize(file, { sizeLimit } = {}) {
        if (sizeLimit && file.size > sizeLimit) {
          throw new Error(`File size (${file.size}) exceeds the limit (${sizeLimit})`);
        }
      },
    };
  },
};
