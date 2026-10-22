// multipart/form-data built in memory (no FormData/Blob copies of a multi-second capture).

/**
 * @param {Array<{name: string, value?: string, filename?: string, type?: string, data?: Buffer}>} parts
 *   a text field (`value`) or a file (`filename`, `type`, `data`)
 * @param {string} [boundary]
 * @returns {{body: Buffer, contentType: string}}
 */
export function multipart(parts, boundary = `----jet${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`) {
  const chunks = [];
  for (const p of parts) {
    if (p.filename !== undefined) {
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\nContent-Type: ${p.type ?? 'application/octet-stream'}\r\n\r\n`), p.data, Buffer.from('\r\n'));
    } else {
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"\r\n\r\n${p.value}\r\n`));
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}
