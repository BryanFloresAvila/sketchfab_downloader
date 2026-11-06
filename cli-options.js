'use strict';
const HELP = `Usage: node download.js <Sketchfab URL or UID> [output.glb] [options]
  --out <file.glb>           Output file (legacy positional path still works)
  --merge off|objects|groups Combine static primitives; default off
  --max-edge 2048|4096       Limit downloaded textures (resized after decoding)
  --concurrency <1..16>      Parallel texture downloads; default 3
  --no-textures             Export material factors without image downloads
  --external                Also write .gltf + .bin + separate image files
  --quiet                   Print only the output path on success
  --help                    Show this help
An adjacent .info.json records counts, warnings and source attribution.`;
function parseArgs(args) {
  const out = {merge: 'off', maxEdge: 0, concurrency: 3, textures: true, external: false, quiet: false};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--no-textures') out.textures = false;
    else if (a === '--external') out.external = true;
    else if (a === '--quiet' || a === '-q') out.quiet = true;
    else if (/^--(out|merge|max-edge|concurrency)(=|$)/.test(a)) {
      const [flag, ...rest] = a.split('='), value = rest.length ? rest.join('=') : args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
      if (flag === '--out') out.output = value;
      else if (flag === '--merge') out.merge = value;
      else out[flag === '--max-edge' ? 'maxEdge' : 'concurrency'] = Number(value);
    } else if (a.startsWith('-')) throw new Error(`Unknown option: ${a}`);
    else positional.push(a);
  }
  if (out.help) return out;
  if (!positional.length || positional.length > 2) throw new Error(HELP);
  if (positional[1] && out.output) throw new Error('Specify only one output path');
  const match = positional[0].match(/(?:^|[^a-f0-9])([a-f0-9]{32})(?:[^a-f0-9]|$)/i);
  if (!match) throw new Error('Expected a Sketchfab URL or 32-character UID');
  out.uid = match[1].toLowerCase();out.output ||= positional[1] || `${out.uid}.glb`;
  if (!out.output.toLowerCase().endsWith('.glb')) throw new Error('Output filename must end with .glb');
  if (!['off', 'objects', 'groups'].includes(out.merge)) throw new Error('Merge must be off, objects or groups');
  if (![0, 2048, 4096].includes(out.maxEdge)) throw new Error('max-edge must be 2048 or 4096');
  if (!Number.isInteger(out.concurrency) || out.concurrency < 1 || out.concurrency > 16) throw new Error('concurrency must be 1..16');
  return out;
}
module.exports = {parseArgs, HELP};
