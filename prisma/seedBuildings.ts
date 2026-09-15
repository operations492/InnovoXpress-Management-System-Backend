/**
 * Demo orders at real, recognisable buildings across the Greater Toronto Area.
 *
 *   npx tsx prisma/seedBuildings.ts            # (re)create the batch
 *   npx tsx prisma/seedBuildings.ts --clean    # remove it again
 *
 * Additive, like seedGta.ts: it touches nothing except orders whose number starts
 * with `BLD-`, and running it again replaces that batch. `npm run seed` still
 * wipes these along with everything else.
 *
 * Every coordinate below was resolved through TomTom Search to a *point address*
 * — the building itself, not a street segment or a postcode centroid — so a pin
 * lands on the roof of the building it names. Two candidates that only matched
 * at street level (CF Markville, Woodbine) were left out rather than guessed.
 *
 * What the batch exercises:
 *   - 58 distinct buildings, 14 of them used twice, so the map's stacked-pin
 *     badge has something to show;
 *   - all three clients, each collecting from / returning to its own hub;
 *   - a quarter of the jobs are PICKUPs (building → hub), the rest deliveries
 *     (hub → building), so the "Plot at" toggle moves things;
 *   - a third are ASSIGNED across four drivers, a few already en route, so the
 *     Assigned tab, driver colours and the "no longer editable" rule all appear;
 *   - every order has items and a tracking history.
 */
import { ConsignmentStatus, Priority, TaskType } from '@prisma/client';
import { prisma } from '../src/config/prisma.js';

const PREFIX = 'BLD';
const HOUR = 60 * 60 * 1000;

interface Building {
  name: string;
  line1: string;
  city: string;
  postcode: string;
  lat: number;
  lng: number;
}

// Order matters only for determinism: the same run always produces the same batch.
const BUILDINGS: Building[] = [
  // --- Toronto core ---
  { name: 'CN Tower', line1: '290 Bremner Boulevard', city: 'Toronto', postcode: 'M5V 3L9', lat: 43.6419369, lng: -79.3867155 },
  { name: 'Toronto City Hall', line1: '100 Queen Street West', city: 'Toronto', postcode: 'M5H 2N2', lat: 43.6525649, lng: -79.3837086 },
  { name: 'Union Station', line1: '65 Front Street West', city: 'Toronto', postcode: 'M5J 1E6', lat: 43.6455282, lng: -79.3803484 },
  { name: 'CF Toronto Eaton Centre', line1: '220 Yonge Street', city: 'Toronto', postcode: 'M5B 2H1', lat: 43.6536729, lng: -79.3801128 },
  { name: 'Royal Ontario Museum', line1: "100 Queen's Park", city: 'Toronto', postcode: 'M5S 2C6', lat: 43.6678187, lng: -79.3940835 },
  { name: 'Toronto General Hospital', line1: '200 Elizabeth Street', city: 'Toronto', postcode: 'M5G 2C4', lat: 43.659083, lng: -79.388277 },
  { name: 'The Hospital for Sick Children', line1: '555 University Avenue', city: 'Toronto', postcode: 'M5G 1X8', lat: 43.657231, lng: -79.387732 },
  { name: 'Mount Sinai Hospital', line1: '600 University Avenue', city: 'Toronto', postcode: 'M5G 1X5', lat: 43.6575364, lng: -79.3904451 },
  { name: 'Scotiabank Arena', line1: '40 Bay Street', city: 'Toronto', postcode: 'M5J 2X2', lat: 43.6439688, lng: -79.3789332 },
  { name: 'Rogers Centre', line1: '1 Blue Jays Way', city: 'Toronto', postcode: 'M5V 1J1', lat: 43.6421787, lng: -79.3893711 },
  { name: 'Art Gallery of Ontario', line1: '317 Dundas Street West', city: 'Toronto', postcode: 'M5T 1G4', lat: 43.6538574, lng: -79.3927745 },
  { name: 'Toronto Reference Library', line1: '789 Yonge Street', city: 'Toronto', postcode: 'M4W 2G8', lat: 43.6718896, lng: -79.3866724 },
  { name: 'Robarts Library, University of Toronto', line1: '130 St George Street', city: 'Toronto', postcode: 'M5S 1A5', lat: 43.6644192, lng: -79.3995725 },
  { name: "St. Michael's Hospital", line1: '30 Bond Street', city: 'Toronto', postcode: 'M5B 1W8', lat: 43.653714, lng: -79.377815 },
  { name: 'Toronto Western Hospital', line1: '399 Bathurst Street', city: 'Toronto', postcode: 'M5T 2S8', lat: 43.6530948, lng: -79.4056885 },
  { name: 'First Canadian Place', line1: '100 King Street West', city: 'Toronto', postcode: 'M5X 1A9', lat: 43.6493651, lng: -79.3819258 },
  { name: 'Brookfield Place', line1: '181 Bay Street', city: 'Toronto', postcode: 'M5J 2T3', lat: 43.6472408, lng: -79.3792186 },
  { name: 'Scotia Plaza', line1: '40 King Street West', city: 'Toronto', postcode: 'M5H 3Y2', lat: 43.6494807, lng: -79.3795657 },
  { name: 'St. Lawrence Market', line1: '93 Front Street East', city: 'Toronto', postcode: 'M5E 1C3', lat: 43.6491532, lng: -79.3716136 },
  { name: 'Distillery District', line1: '55 Mill Street', city: 'Toronto', postcode: 'M5A 3C4', lat: 43.6506801, lng: -79.3590896 },
  { name: 'Casa Loma', line1: '1 Austin Terrace', city: 'Toronto', postcode: 'M5R 1X8', lat: 43.6780316, lng: -79.4094441 },
  { name: 'BMO Field', line1: "170 Princes' Boulevard", city: 'Toronto', postcode: 'M6K 3C3', lat: 43.632674, lng: -79.4186159 },
  // --- North York / East York / Scarborough / Etobicoke ---
  { name: 'Ontario Science Centre', line1: '770 Don Mills Road', city: 'North York', postcode: 'M3C 1T3', lat: 43.716444, lng: -79.3381457 },
  { name: 'Sunnybrook Health Sciences Centre', line1: '2075 Bayview Avenue', city: 'East York', postcode: 'M4N 3M5', lat: 43.7213651, lng: -79.3761745 },
  { name: 'Yorkdale Shopping Centre', line1: '3401 Dufferin Street', city: 'North York', postcode: 'M6A 2T9', lat: 43.725983, lng: -79.452408 },
  { name: 'North York General Hospital', line1: '4001 Leslie Street', city: 'North York', postcode: 'M2K 1E1', lat: 43.769509, lng: -79.362965 },
  { name: 'CF Fairview Mall', line1: '1800 Sheppard Avenue East', city: 'North York', postcode: 'M2J 5A7', lat: 43.7777512, lng: -79.3444978 },
  { name: 'Scarborough Town Centre', line1: '300 Borough Drive', city: 'Scarborough', postcode: 'M1P 4P5', lat: 43.7762968, lng: -79.2580238 },
  { name: 'Toronto Zoo', line1: '2000 Meadowvale Road', city: 'Scarborough', postcode: 'M1B 5K7', lat: 43.8204667, lng: -79.1811588 },
  { name: 'Centennial College, Progress Campus', line1: '941 Progress Avenue', city: 'Scarborough', postcode: 'M1G 3T8', lat: 43.7852754, lng: -79.2270297 },
  { name: 'York University, Ross Building', line1: '4700 Keele Street', city: 'North York', postcode: 'M3J 1P3', lat: 43.7734115, lng: -79.5023421 },
  { name: 'Humber River Hospital', line1: '1235 Wilson Avenue', city: 'North York', postcode: 'M3M 0B2', lat: 43.7242581, lng: -79.4892156 },
  { name: 'CF Sherway Gardens', line1: '25 The West Mall', city: 'Etobicoke', postcode: 'M9C 1B8', lat: 43.6119578, lng: -79.5572105 },
  { name: 'Humber College, North Campus', line1: '205 Humber College Boulevard', city: 'Etobicoke', postcode: 'M9W 5L7', lat: 43.7291631, lng: -79.606786 },
  { name: 'Toronto Congress Centre', line1: '650 Dixon Road', city: 'Etobicoke', postcode: 'M9W 1J1', lat: 43.690311, lng: -79.5778128 },
  // --- Peel ---
  { name: 'Toronto Pearson, Terminal 1', line1: '6301 Silver Dart Drive', city: 'Mississauga', postcode: 'L5P 1B2', lat: 43.6863069, lng: -79.6217745 },
  { name: 'Square One Shopping Centre', line1: '100 City Centre Drive', city: 'Mississauga', postcode: 'L5B 2C9', lat: 43.5931145, lng: -79.64336 },
  { name: 'Mississauga Civic Centre', line1: '300 City Centre Drive', city: 'Mississauga', postcode: 'L5B 3C1', lat: 43.5887584, lng: -79.6443209 },
  { name: 'Living Arts Centre', line1: '4141 Living Arts Drive', city: 'Mississauga', postcode: 'L5B 4B8', lat: 43.5894138, lng: -79.6456911 },
  { name: 'Sheridan College, Hazel McCallion Campus', line1: '4180 Duke of York Boulevard', city: 'Mississauga', postcode: 'L5B 0G5', lat: 43.5932143, lng: -79.6425917 },
  { name: 'Mississauga Hospital', line1: '100 Queensway West', city: 'Mississauga', postcode: 'L5B 1B8', lat: 43.5720248, lng: -79.6088813 },
  { name: 'Credit Valley Hospital', line1: '2200 Eglinton Avenue West', city: 'Mississauga', postcode: 'L5M 2N1', lat: 43.5592882, lng: -79.703236 },
  { name: 'University of Toronto Mississauga', line1: '3359 Mississauga Road', city: 'Mississauga', postcode: 'L5L 1C6', lat: 43.548122, lng: -79.663369 },
  { name: 'Erin Mills Town Centre', line1: '5100 Erin Mills Parkway', city: 'Mississauga', postcode: 'L5M 4Z5', lat: 43.5589081, lng: -79.7105165 },
  { name: 'Dixie Outlet Mall', line1: '1250 South Service Road', city: 'Mississauga', postcode: 'L5E 1V4', lat: 43.593192, lng: -79.5690849 },
  { name: 'Brampton City Hall', line1: '2 Wellington Street West', city: 'Brampton', postcode: 'L6Y 4R2', lat: 43.6847426, lng: -79.7598986 },
  { name: 'Bramalea City Centre', line1: '25 Peel Centre Drive', city: 'Brampton', postcode: 'L6T 3R5', lat: 43.7148934, lng: -79.7233342 },
  { name: 'Brampton Civic Hospital', line1: '2100 Bovaird Drive East', city: 'Brampton', postcode: 'L6R 3J7', lat: 43.74693, lng: -79.743681 },
  // --- York / Halton / Durham ---
  { name: 'Vaughan Mills', line1: '1 Bass Pro Mills Drive', city: 'Concord', postcode: 'L4K 5W4', lat: 43.8253888, lng: -79.5388985 },
  { name: 'Vaughan City Hall', line1: '2141 Major Mackenzie Drive West', city: 'Maple', postcode: 'L6A 1T1', lat: 43.8555597, lng: -79.5089569 },
  { name: 'Markham Civic Centre', line1: '101 Town Centre Boulevard', city: 'Markham', postcode: 'L3R 9W3', lat: 43.8563315, lng: -79.3373118 },
  { name: 'Hillcrest Mall', line1: '9350 Yonge Street', city: 'Richmond Hill', postcode: 'L4C 5G2', lat: 43.8548468, lng: -79.4367582 },
  { name: 'Oakville Place', line1: '240 Leighland Avenue', city: 'Oakville', postcode: 'L6H 3H6', lat: 43.462912, lng: -79.688109 },
  { name: 'Oakville Trafalgar Memorial Hospital', line1: '3001 Hospital Gate', city: 'Oakville', postcode: 'L6M 0L8', lat: 43.4499148, lng: -79.7630468 },
  { name: 'Burlington City Hall', line1: '426 Brant Street', city: 'Burlington', postcode: 'L7R 3Z6', lat: 43.3258304, lng: -79.7985959 },
  { name: 'Mapleview Centre', line1: '900 Maple Avenue', city: 'Burlington', postcode: 'L7S 2J8', lat: 43.3252102, lng: -79.8197301 },
  { name: 'Pickering Town Centre', line1: '1355 Kingston Road', city: 'Pickering', postcode: 'L1V 1B8', lat: 43.8367715, lng: -79.0881539 },
  { name: 'Oshawa Centre', line1: '419 King Street West', city: 'Oshawa', postcode: 'L1J 2K5', lat: 43.890709, lng: -78.879513 },
];

/** Buildings that get a second order — hospitals and malls, where stacking really happens. */
const SECOND_ORDER_AT = [5, 6, 23, 36, 3, 24, 27, 41, 47, 35, 15, 12, 46, 25];

/** Each client collects from and returns to its own hub. All three are real buildings. */
const HUBS: Record<string, Building & { phone: string; contact: string }> = {
  DRZ: { name: 'Daraz Etobicoke Fulfilment Centre', contact: 'Daraz Dispatch Desk', phone: '+1 416 555 0140', line1: '1475 The Queensway', city: 'Etobicoke', postcode: 'M8Z 1T3', lat: 43.618924, lng: -79.5344874 },
  APX: { name: 'Apple Express Downsview Depot', contact: 'Apple Express Outbound', phone: '+1 416 555 0172', line1: '100 Billy Bishop Way', city: 'North York', postcode: 'M3K 2C8', lat: 43.7310516, lng: -79.4558144 },
  TCS: { name: 'TCS Bayview Village Hub', contact: 'TCS Hub Receiving', phone: '+1 647 555 0119', line1: '15 Provost Drive', city: 'North York', postcode: 'M2K 2X9', lat: 43.7680553, lng: -79.3690777 },
};

const PEOPLE = [
  'Priya Raman', 'Marcus Bellamy', 'Aisha Siddiqui', 'Jean-Luc Tremblay', 'Hannah O’Connor',
  'Wei Zhang', 'Olumide Adeyemi', 'Sofia Rossi', 'Daniel Kim', 'Fatima Al-Sayed',
  'Graham Whitfield', 'Leila Haddad', 'Noah Fischer', 'Chantal Dubois', 'Rajesh Menon',
  'Emily Carter', 'Tomasz Nowak', 'Grace Okafor', 'Liam Gallagher', 'Mei Lin Chen',
  'Samuel Osei', 'Isabella Moreau', 'Arjun Patel', 'Rebecca Stein', 'Yusuf Demir',
  'Claire Lévesque', 'Victor Nguyen', 'Amara Diallo', 'Ethan Brooks', 'Zara Hussain',
];

const AREA_CODES = ['416', '647', '905', '289', '437'];

interface CatalogueItem {
  description: string;
  /** Whole-line weight in pounds, as an operator would type it. */
  weightLb: number;
  /** Outer dimensions in inches. */
  dims: [number, number, number];
}

const CATALOGUE: CatalogueItem[] = [
  { description: 'Laptop, boxed', weightLb: 5.3, dims: [16, 12, 4] },
  { description: 'Contract documents', weightLb: 0.7, dims: [13, 10, 1] },
  { description: 'Lab reagents, chilled', weightLb: 4.0, dims: [12, 9, 9] },
  { description: 'Printer toner cartridges', weightLb: 9.3, dims: [18, 12, 8] },
  { description: 'Retail apparel restock', weightLb: 16.5, dims: [24, 18, 12] },
  { description: 'Surgical gloves, 10 cases', weightLb: 84.0, dims: [48, 40, 36] },
  { description: 'Event signage', weightLb: 6.8, dims: [36, 24, 3] },
  { description: 'Replacement network switch', weightLb: 12.3, dims: [22, 16, 6] },
  { description: 'Pharmacy order', weightLb: 2.6, dims: [10, 7, 6] },
  { description: 'Architectural drawings', weightLb: 1.3, dims: [37, 4, 4] },
  { description: 'Catering supplies', weightLb: 21.8, dims: [24, 16, 14] },
  { description: 'Textbooks, 2 cartons', weightLb: 30.9, dims: [18, 12, 10] },
];

const DRIVER_CODES = ['DRV-001', 'DRV-002', 'DRV-003', 'DRV-004'];

function phone(i: number): string {
  return `+1 ${AREA_CODES[i % AREA_CODES.length]} 555 0${String(100 + ((i * 37) % 900)).padStart(3, '0')}`;
}

/** 08:00 local, `days` from today. Windows are built from this so the CHECK constraints hold. */
function morning(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(8, 0, 0, 0);
  return d;
}

async function clean() {
  const { count } = await prisma.consignment.deleteMany({
    where: { orderNo: { startsWith: `${PREFIX}-` } },
  });
  console.log(`✓ removed ${count} ${PREFIX}- orders`);
}

async function main() {
  if (process.argv.includes('--clean')) {
    await clean();
    return;
  }

  // Every active level, in dropdown order; orders cycle through them.
  const levels = await prisma.serviceLevel.findMany({
    where: { active: true },
    select: { id: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });

  const clients = await prisma.client.findMany({
    where: { active: true, code: { in: Object.keys(HUBS) } },
    select: { id: true, code: true, name: true },
  });
  if (clients.length === 0) throw new Error('No active DRZ / APX / TCS clients — run `npm run seed` first');

  const drivers = await prisma.driver.findMany({
    where: { active: true, code: { in: DRIVER_CODES } },
    select: { id: true, name: true, code: true },
    orderBy: { code: 'asc' },
  });
  if (drivers.length === 0) throw new Error('No active drivers DRV-001…004 — run `npm run seed` first');

  const admin = await prisma.user.findFirst({
    where: { role: 'admin', active: true },
    select: { id: true, email: true },
  });

  // Running twice replaces the batch rather than failing on a duplicate order number.
  await clean();

  const stops: Building[] = [...BUILDINGS, ...SECOND_ORDER_AT.map((i) => BUILDINGS[i]!)];
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const perClient: Record<string, number> = {};
  let created = 0;

  for (const [i, building] of stops.entries()) {
    const client = clients[i % clients.length]!;
    const code = client.code as keyof typeof HUBS;
    const hub = HUBS[code] ?? HUBS.DRZ!;
    const person = PEOPLE[i % PEOPLE.length]!;
    const isPickup = i % 4 === 3;

    // A third assigned, and every fourth of those already on the road.
    const assigned = i % 3 === 0;
    const driver = assigned ? drivers[(i / 3) % drivers.length]! : null;
    const enRoute = assigned && i % 12 === 0;
    const status = !assigned
      ? ConsignmentStatus.UNASSIGNED
      : enRoute
        ? ConsignmentStatus.EN_ROUTE_TO_PICKUP
        : ConsignmentStatus.ASSIGNED;

    const pickupAfter = new Date(morning(i % 3).getTime() + (i % 4) * HOUR);
    const priority = i % 7 === 0 ? Priority.HIGH : i % 11 === 0 ? Priority.LOW : Priority.NORMAL;

    // The building's own contact, and the hub's, at whichever end each belongs.
    const site = {
      name: person,
      phone: phone(i),
      line1: building.line1,
      city: building.city,
      postcode: building.postcode,
      lat: building.lat,
      lng: building.lng,
    };
    const depot = {
      name: hub.contact,
      phone: hub.phone,
      line1: hub.line1,
      city: hub.city,
      postcode: hub.postcode,
      lat: hub.lat,
      lng: hub.lng,
    };
    const from = isPickup ? site : depot;
    const to = isPickup ? depot : site;

    const seq = (perClient[code] = (perClient[code] ?? 0) + 1);
    const orderNo = `${PREFIX}-${stamp}-${String(i + 1).padStart(4, '0')}`;
    const items = Array.from({ length: 1 + (i % 3) }, (_, k) => {
      const c = CATALOGUE[(i + k * 5) % CATALOGUE.length]!;
      return {
        description: c.description,
        qty: 1 + ((i + k) % 4),
        weightLb: c.weightLb,
        lengthIn: c.dims[0],
        widthIn: c.dims[1],
        heightIn: c.dims[2],
        barcode: `${code}${String(100000 + i * 7 + k)}`,
      };
    });

    await prisma.consignment.create({
      data: {
        orderNo,
        clientId: client.id,
        clientReference: `${code}-PO-${String(24000 + seq * 13)}`,
        serviceLevelId: levels.length ? levels[i % levels.length]!.id : null,
        status,
        driverId: driver?.id ?? null,
        assignedAt: driver ? new Date(pickupAfter.getTime() - 14 * HOUR) : null,
        priority,
        taskType: isPickup ? TaskType.PICKUP : TaskType.DELIVERY,

        senderName: from.name,
        senderPhone: from.phone,
        senderLine1: from.line1,
        senderCity: from.city,
        senderProvince: 'ON',
        senderPostcode: from.postcode,
        senderLat: from.lat,
        senderLng: from.lng,
        senderInstructions: isPickup ? `Collect from reception — ${building.name}` : `Dock ${1 + (i % 6)} — ${hub.name}`,

        receiverName: to.name,
        receiverPhone: to.phone,
        receiverLine1: to.line1,
        receiverCity: to.city,
        receiverProvince: 'ON',
        receiverPostcode: to.postcode,
        receiverLat: to.lat,
        receiverLng: to.lng,
        receiverNotes: isPickup ? `Returns desk — ${hub.name}` : `Receiving — ${building.name}`,

        pickupAfter,
        pickupBefore: new Date(pickupAfter.getTime() + 3 * HOUR),
        deliverAfter: new Date(pickupAfter.getTime() + 3 * HOUR),
        deliverBefore: new Date(pickupAfter.getTime() + 8 * HOUR),

        generalNote: i % 5 === 0 ? 'Call the contact on arrival; security desk signs.' : null,
        createdByUserId: admin?.id ?? null,
        lastUpdatedByUserId: admin?.id ?? null,

        items: { create: items },
        trackingEvents: {
          create: [
            {
              fromStatus: null,
              toStatus: ConsignmentStatus.UNASSIGNED,
              actorUserId: admin?.id ?? null,
              actorEmail: admin?.email ?? null,
              note: 'Consignment logged (buildings seed)',
            },
            ...(driver
              ? [
                  {
                    fromStatus: ConsignmentStatus.UNASSIGNED,
                    toStatus: ConsignmentStatus.ASSIGNED,
                    driverId: driver.id,
                    actorUserId: admin?.id ?? null,
                    actorEmail: admin?.email ?? null,
                    note: `Assigned to ${driver.name} (buildings seed)`,
                  },
                ]
              : []),
            ...(enRoute && driver
              ? [
                  {
                    fromStatus: ConsignmentStatus.ASSIGNED,
                    toStatus: ConsignmentStatus.EN_ROUTE_TO_PICKUP,
                    driverId: driver.id,
                    note: 'Driver en route to pickup (buildings seed)',
                  },
                ]
              : []),
          ],
        },
      },
    });
    created += 1;
  }

  const byStatus = await prisma.consignment.groupBy({
    by: ['status'],
    where: { orderNo: { startsWith: `${PREFIX}-` } },
    _count: { _all: true },
  });

  console.log(`✓ created ${created} ${PREFIX}- orders at ${BUILDINGS.length} real buildings`);
  for (const row of byStatus) console.log(`  ${row.status.padEnd(20)} ${row._count._all}`);
  console.log(`  clients: ${clients.map((c) => c.name).join(', ')}`);
  console.log(`  drivers: ${drivers.map((d) => d.name).join(', ')}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
