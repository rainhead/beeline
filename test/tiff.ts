/** Minimal single-strip little-endian TIFF — geotiff's own writer mangles
 * anything wider than 8 bits, so we emit the ~200 bytes by hand. SRTM tiles
 * are signed 16-bit integers; GLO-30's are 32-bit floats. */
export function tinyTiff(data: Int16Array | Float32Array, width: number, height: number): Buffer {
  const float = data instanceof Float32Array;
  const bytesPerSample = float ? 4 : 2;
  const tags: Array<[number, number, number]> = [
    [256, 3, width], // ImageWidth
    [257, 3, height], // ImageLength
    [258, 3, bytesPerSample * 8], // BitsPerSample
    [259, 3, 1], // Compression: none
    [262, 3, 1], // PhotometricInterpretation
    [273, 4, 0], // StripOffsets (patched below)
    [277, 3, 1], // SamplesPerPixel
    [278, 3, height], // RowsPerStrip
    [279, 4, data.length * bytesPerSample], // StripByteCounts
    [339, 3, float ? 3 : 2], // SampleFormat: IEEE float / signed integer
  ];
  const ifdStart = 8;
  const pixelStart = ifdStart + 2 + tags.length * 12 + 4;
  tags[5]![2] = pixelStart;
  const buf = Buffer.alloc(pixelStart + data.length * bytesPerSample);
  buf.write("II", 0, "ascii");
  buf.writeUInt16LE(42, 2);
  buf.writeUInt32LE(ifdStart, 4);
  buf.writeUInt16LE(tags.length, ifdStart);
  tags.forEach(([id, type, value], i) => {
    const at = ifdStart + 2 + i * 12;
    buf.writeUInt16LE(id, at);
    buf.writeUInt16LE(type, at + 2);
    buf.writeUInt32LE(1, at + 4);
    buf.writeUInt32LE(value, at + 8);
  });
  data.forEach((v, i) => {
    const at = pixelStart + i * bytesPerSample;
    if (float) buf.writeFloatLE(v, at);
    else buf.writeInt16LE(v, at);
  });
  return buf;
}
