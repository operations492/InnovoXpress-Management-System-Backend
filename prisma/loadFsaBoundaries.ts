/**
 * Load Statistics Canada's forward sortation area boundaries.
 *
 * This is the free half of the postal-geography problem. StatCan publishes FSA
 * polygons (the first three characters, `M5V`) under the Open Licence; the point
 * location of every six-character code is a licensed Canada Post product and is
 * NOT loaded here. That is the whole reason drawing a shape produces FSAs and a
 * carve-out like `T2E6W5` is still typed in by hand.
 *
 * Getting the file (once, by hand — it is ~60 MB and changes every census):
 *
 *   1. Download the Forward Sortation Areas Cartographic Boundary File from
 *      https://www150.statcan.gc.ca/n1/en/catalogue/92-179-X  (lfsa000b21a_e.zip)
 *   2. Convert the shapefile to GeoJSON in WGS84 with GDAL:
 *
 *        ogr2ogr -f GeoJSON -t_srs EPSG:4326 fsa.geojson lfsa000b21a_e.shp
 *
 *   3. npx tsx prisma/loadFsaBoundaries.ts path\to\fsa.geojson
 *
 * Re-running replaces a code's polygon in place, so a newer file can be loaded
 * over an older one without dropping anything. `--clean` empties the table.
 *
 * Nothing else in the application writes this table, and pricing never reads it:
 * only the zone editor does, to turn a drawn shape into postal codes.
 */
import { createReadStream } from 'node:fs';
import { prisma } from '../src/config/prisma.js';

/** StatCan's own column names, with the obvious alternatives allowed. */
const CODE_KEYS = ['CFSAUID', 'cfsauid', 'FSA', 'fsa', 'code', 'CFSAUID_1'];
const PROV_KEYS = ['PRUID', 'pruid', 'PRNAME', 'prname', 'province'];
const NAME_KEYS = ['PRNAME', 'prname', 'name'];

interface Feature {
  properties?: Record<string, unknown>;
  geometry?: { type: string; coordinates: unknown } | null;
}

function pick(props: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = props[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return String(v);
  }
  return null;
}

async function readJson(path: string): Promise<{ features: Feature[] }> {
  const chunks: Buffer[] = [];
  for await (const chunk of createReadStream(path)) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function load(path: string) {
  const data = await readJson(path);
  if (!Array.isArray(data.features)) throw new Error('Not a GeoJSON FeatureCollection');

  let written = 0;
  let skipped = 0;

  for (const f of data.features) {
    const props = f.properties ?? {};
    const code = pick(props, CODE_KEYS)?.toUpperCase().replace(/\s+/g, '');
    if (!code || code.length !== 3 || !f.geometry) {
      skipped += 1;
      continue;
    }

    // ST_Multi so a single-polygon FSA and an island FSA land in the same column
    // type; ST_MakeValid because published boundaries routinely self-intersect by
    // a few centimetres and PostGIS refuses to answer questions about those.
    //
    // ST_CollectionExtract(..., 3) keeps only the polygons. Repairing a
    // self-intersection can leave a stray line or point stitched onto the shape,
    // which makes the whole thing a GeometryCollection the MultiPolygon column
    // rejects. A dangling edge is not area and is no loss.
    await prisma.$executeRaw`
      INSERT INTO fsa_boundaries (code, province, name, geom)
      VALUES (
        ${code},
        ${pick(props, PROV_KEYS)},
        ${pick(props, NAME_KEYS)},
        extensions.ST_Multi(
          extensions.ST_CollectionExtract(
            extensions.ST_MakeValid(
              extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON(${JSON.stringify(f.geometry)}), 4326)
            ),
            3
          )
        )
      )
      ON CONFLICT (code) DO UPDATE
        SET geom = EXCLUDED.geom,
            province = EXCLUDED.province,
            name = EXCLUDED.name,
            loaded_at = now()
    `;
    written += 1;
    if (written % 250 === 0) console.log(`  ... ${written}`);
  }

  console.log(`✓ loaded ${written} FSA boundaries (${skipped} features skipped)`);
}

async function clean() {
  const n = await prisma.$executeRaw`DELETE FROM fsa_boundaries`;
  console.log(`✓ removed ${n} FSA boundaries`);
}

async function main() {
  const arg = process.argv[2];
  if (arg === '--clean') {
    await clean();
    return;
  }
  if (!arg) {
    console.error('Usage: npx tsx prisma/loadFsaBoundaries.ts <fsa.geojson> | --clean');
    process.exitCode = 1;
    return;
  }
  await load(arg);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
