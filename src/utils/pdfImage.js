/**
 * An image PDFKit can draw from a stored logo: a PNG/JPEG data URL, or an http(s) PNG/JPEG
 * fetched with a short timeout. Anything else (SVG, WebP, unreachable) gives null.
 */
export const loadPdfImage = async (source) => {
  if (!source) return null;
  try {
    if (/^data:image\/(png|jpe?g);base64,/.test(source)) return Buffer.from(source.split(',')[1], 'base64');
    if (/^https?:\/\//.test(source)) {
      const response = await fetch(source, { signal: AbortSignal.timeout(4000) });
      if (!response.ok) return null;
      const buffer = Buffer.from(await response.arrayBuffer());
      if ((buffer[0] === 0x89 && buffer[1] === 0x50) || (buffer[0] === 0xff && buffer[1] === 0xd8)) return buffer;
    }
  } catch {
    return null;
  }
  return null;
};
