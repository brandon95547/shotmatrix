// A ZIP writer for the "download all" button: stored, not deflated, and streamed.
//
// Stored because every file in a run is already a PNG or a JPEG — deflating compressed
// images spends CPU to save nothing. And that makes the archive's size knowable before a
// byte is written, so the response can carry a Content-Length and the browser can show
// real progress instead of a spinner.
//
// No ZIP64: a run is well under the 4GB that would need it, and zipSize() refuses
// anything that is not.

import zlib from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
// zlib.crc32 arrived in Node 22.2 / 20.15; the table is the fallback for anything older.
const crc32 = zlib.crc32 ?? ((buf) => {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
});

function dosTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

// entries: [{ name, path, size }] — names are ASCII paths inside the archive.
export function zipSize(entries) {
  let total = 22; // end of central directory
  for (const e of entries) total += 30 + e.name.length + e.size + 46 + e.name.length;
  if (total > 0xffffffff || entries.length > 0xffff) throw new Error('too large for a plain zip');
  return total;
}

export async function writeZip(out, entries, when = new Date()) {
  const { time, date } = dosTime(when);
  const central = [];
  let offset = 0;
  const write = async (buf) => {
    offset += buf.length;
    if (!out.write(buf)) await once(out, 'drain');
  };

  for (const e of entries) {
    const data = await readFile(e.path);
    const crc = crc32(data);
    const name = Buffer.from(e.name, 'ascii');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4); // version made by
    header.writeUInt16LE(20, 6); // version needed
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(time, 12);
    header.writeUInt16LE(date, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(offset, 42); // where this entry's local header starts
    central.push(header, name);

    await write(local);
    await write(name);
    await write(data);
  }

  const dirStart = offset;
  for (const buf of central) await write(buf);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(offset - dirStart, 12);
  end.writeUInt32LE(dirStart, 16);
  await write(end);
}
