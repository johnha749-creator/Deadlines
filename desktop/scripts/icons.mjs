// Renders desktop/icon.svg into every icon format the build needs:
//   icon-1024.png (macOS grid), icon.icns, icon.ico, icon.png (512, for the Linux/Windows window)
// Usage: node icons.mjs <tooling node_modules parent> <icon.svg> <out dir>
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

export async function makeIcons({ toolingDir, svgPath, outDir }) {
  const require = createRequire(path.join(toolingDir, 'package.json'));
  const { Resvg } = require('@resvg/resvg-js');
  const svg = fs.readFileSync(svgPath, 'utf8');
  // macOS icons keep Apple's grid padding; Windows/Linux icons use the tile edge to edge.
  const tight = svg.replace('viewBox="0 0 1024 1024"', 'viewBox="100 100 824 824"');
  const render = (src, size) => Buffer.from(new Resvg(src, { fitTo: { mode: 'width', value: size }, background: 'rgba(0,0,0,0)' }).render().asPng());
  fs.mkdirSync(outDir, { recursive: true });

  const mac = new Map();
  for (const s of [16, 32, 64, 128, 256, 512, 1024]) mac.set(s, render(svg, s));
  const win = new Map();
  for (const s of [16, 24, 32, 48, 64, 128, 256, 512]) win.set(s, render(tight, s));

  fs.writeFileSync(path.join(outDir, 'icon-1024.png'), mac.get(1024));
  fs.writeFileSync(path.join(outDir, 'icon.png'), win.get(512));
  for (const [s, buf] of win) fs.writeFileSync(path.join(outDir, `icon-${s}.png`), buf);

  // .icns: PNG payloads in the modern slots (macOS 10.7+).
  const icnsEntries = [
    ['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024],
    ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512],
  ];
  const chunks = icnsEntries.map(([type, size]) => {
    const data = mac.get(size);
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([head, data]);
  });
  const body = Buffer.concat(chunks);
  const icnsHead = Buffer.alloc(8);
  icnsHead.write('icns', 0, 'ascii');
  icnsHead.writeUInt32BE(body.length + 8, 4);
  fs.writeFileSync(path.join(outDir, 'icon.icns'), Buffer.concat([icnsHead, body]));

  // .ico: PNG-compressed entries (Windows Vista+).
  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const dir = Buffer.alloc(6 + 16 * icoSizes.length);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(icoSizes.length, 4);
  let offset = dir.length;
  const images = [];
  icoSizes.forEach((s, i) => {
    const data = win.get(s);
    const e = 6 + 16 * i;
    dir.writeUInt8(s >= 256 ? 0 : s, e);
    dir.writeUInt8(s >= 256 ? 0 : s, e + 1);
    dir.writeUInt8(0, e + 2);
    dir.writeUInt8(0, e + 3);
    dir.writeUInt16LE(1, e + 4);
    dir.writeUInt16LE(32, e + 6);
    dir.writeUInt32LE(data.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += data.length;
    images.push(data);
  });
  fs.writeFileSync(path.join(outDir, 'icon.ico'), Buffer.concat([dir, ...images]));
  return { icns: path.join(outDir, 'icon.icns'), ico: path.join(outDir, 'icon.ico'), png: path.join(outDir, 'icon.png') };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const [toolingDir, svgPath, outDir] = process.argv.slice(2);
  makeIcons({ toolingDir, svgPath, outDir }).then((r) => console.log(r));
}
