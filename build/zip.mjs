import fs from 'node:fs';
import path from 'node:path';
import archiver from 'archiver';

const outDir = path.resolve('dist');
const inDir = path.resolve('extension');
const outZip = path.join(outDir, 'affilifind-v0.1.0.zip');

fs.mkdirSync(outDir, { recursive: true });
const output = fs.createWriteStream(outZip);
const archive = archiver('zip', { zlib: { level: 9 } });

output.on('close', () => console.log(`Zipped ${archive.pointer()} total bytes -> ${outZip}`));
archive.on('warning', err => { if (err.code !== 'ENOENT') throw err; });
archive.on('error', err => { throw err; });

archive.pipe(output);
archive.directory(inDir, false);
archive.finalize();
