import { ConsignmentStatus, PackageType, Priority, TaskType } from '@prisma/client';
import { prisma } from '../src/config/prisma.js';
import { env } from '../src/config/env.js';
import { supabase, POD_BUCKET } from '../src/config/supabase.js';
import { generateOrderNo } from '../src/utils/orderNo.js';
import { MAP_COLOR_COUNT } from '../src/constants/mapTabs.js';

/**
 * ⚠️ DESTRUCTIVE. This wipes and rebuilds.
 *
 * It deletes every consignment, item, proof, tracking event and GPS ping, every
 * object in the `pod` Storage bucket, and every Supabase Auth user — then
 * recreates a known-good world. That is deliberate: the auth migration changed
 * what a user IS, so topping up the old rows was never going to work.
 *
 * Seeded orders sit at UNASSIGNED or ASSIGNED only. Anything from PICKED_UP
 * onward is reachable solely by uploading proof of delivery, so seeding those
 * states directly would produce delivered orders with no proof — the exact thing
 * the design exists to prevent.
 */

/**
 * Logins for the seeded people. Passwords are identical on purpose: this is a
 * demo dataset, and an admin changes them from the Users screen.
 *
 * The addresses need not receive mail — accounts are created with
 * `email_confirm: true`, so nobody is ever sent a confirmation link. Use a
 * domain you own so that if password-reset mail is ever switched on, it does
 * not go to a stranger.
 */
const EMAIL_DOMAIN = 'innovoxpress.com';
const SEED_DRIVER_PASSWORD = 'Driver!123';

/**
 * How many of the roster start clocked on. The rest are left off shift so that
 * "you cannot assign work to a driver who has gone home" can be tried out
 * without first having to clock someone off from a phone.
 */
const ON_SHIFT_COUNT = 6;

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z]+/g, '.')
    .replace(/^\.|\.$/g, '');

const CLIENTS = [
  { name: 'Daraz', code: 'DRZ' },
  { name: 'Apple Express', code: 'APX' },
  { name: 'TCS', code: 'TCS' },
];

const DRIVERS = [
  { name: 'Muhammad Abdullah', code: 'DRV-001', mobile: '+1 416 555 0142' },
  { name: 'Bilal Ahmed', code: 'DRV-002', mobile: '+1 647 555 0198' },
  { name: 'Usman Tariq', code: 'DRV-003', mobile: '+1 905 555 0173' },
  { name: 'Hamza Sheikh', code: 'DRV-004', mobile: '+1 289 555 0126' },
  { name: 'Ali Raza', code: 'DRV-005', mobile: '+1 416 555 0287' },
  { name: 'Faisal Mahmood', code: 'DRV-006', mobile: '+1 437 555 0351' },
  { name: 'Zain Ul Abideen', code: 'DRV-007', mobile: '+1 905 555 0409' },
  { name: 'Ahsan Iqbal', code: 'DRV-008', mobile: '+1 647 555 0468' },
];

type SeedOrder = {
  clientReference: string;
  priority: Priority;
  taskType: TaskType;
  assign: boolean;
  generalNote?: string;
  sender: {
    name: string;
    phone: string;
    line1: string;
    city: string;
    /** Two-letter code — the CHECK constraint rejects anything else. */
    province: string;
    /** Canonical `A1A 1A1`. */
    postcode?: string;
    instructions?: string;
  };
  receiver: {
    name: string;
    phone: string;
    line1: string;
    city: string;
    province: string;
    postcode?: string;
    notes?: string;
  };
  items: Array<{
    description: string;
    qty: number;
    weightKg: number;
    packageType: PackageType;
    barcode?: string;
  }>;
};

/**
 * Approximate coordinates for the demo addresses, keyed by `line1`.
 *
 * These exist because the dispatcher console now requires a map pin before a
 * consignment can be saved. Without them the nine demo orders would become
 * un-editable — you could open one and not save it until you had placed a pin
 * by hand.
 *
 * They are area-accurate, not survey-accurate: good enough to put a pin on the
 * right street in the right Greater Toronto municipality, which is
 * all a demo needs. Real orders get
 * their coordinates from the address autocomplete or a dragged pin.
 */
const DEMO_COORDS: Record<string, [number, number]> = {
  // Mississauga
  '6750 Century Avenue, Unit 3': [43.589, -79.718],
  '5985 Explorer Drive, Suite 400': [43.628, -79.626],
  '100 City Centre Drive, Unit 212': [43.593, -79.642],
  '6900 Airport Road, Dock 12': [43.689, -79.625],
  '1250 South Service Road': [43.572, -79.562],
  // Brampton / Vaughan
  '7995 Airport Road, Bay 6': [43.706, -79.632],
  '3300 Steeles Avenue West': [43.796, -79.529],
  // Toronto
  '25 Telegram Mews, Unit 1907': [43.6395, -79.396],
  '18 Yonge Street, Suite 2204': [43.6425, -79.377],
  '220 Yonge Street, Unit 118': [43.6544, -79.3807],
  '2300 Yonge Street, Suite 1600': [43.707, -79.398],
  '1 Dundas Street West, Unit 505': [43.656, -79.382],
  '55 Bloor Street West, Suite 900': [43.67, -79.388],
  '50 Bay Street, Floor 12': [43.642, -79.377],
  '100 Queen Street West': [43.6535, -79.3839],
  '300 Borough Drive, Unit 44': [43.775, -79.257],
  '25 The West Mall, Unit 210': [43.621, -79.556],
  '4700 Keele Street, Bergeron Centre': [43.7735, -79.5019],
};

const coordsFor = (line1: string) => DEMO_COORDS[line1] ?? [null, null];

const ORDERS: Record<string, SeedOrder[]> = {
  DRZ: [
    {
      clientReference: 'DRZ-CA-88410233',
      priority: Priority.NORMAL,
      taskType: TaskType.DELIVERY,
      assign: false,
      generalNote: 'Customer requested delivery after 5pm.',
      sender: {
        name: 'Daraz Fulfilment Centre',
        phone: '+1 905 555 8800',
        line1: '6750 Century Avenue, Unit 3',
        city: 'Mississauga',
        province: 'ON',
        postcode: 'L5N 2V8',
        instructions: 'Report to Gate 2, dock 7.',
      },
      receiver: {
        name: 'Sarah Whitfield',
        phone: '+1 416 555 4471',
        line1: '25 Telegram Mews, Unit 1907',
        city: 'Toronto',
        province: 'ON',
        postcode: 'M5V 3Z1',
        notes: 'Concierge desk holds parcels after 6pm.',
      },
      items: [
        {
          description: 'Anker PowerCore 20000mAh power bank',
          qty: 1,
          weightKg: 0.48,
          packageType: PackageType.BOX,
          barcode: '8901234500011',
        },
        {
          description: 'USB-C braided cable 2m',
          qty: 2,
          weightKg: 0.12,
          packageType: PackageType.ENVELOPE,
          barcode: '8901234500028',
        },
      ],
    },
    {
      clientReference: 'DRZ-CA-88410571',
      priority: Priority.HIGH,
      taskType: TaskType.DELIVERY,
      assign: true,
      sender: {
        name: 'Daraz Square One Hub',
        phone: '+1 905 555 2210',
        line1: '100 City Centre Drive, Unit 212',
        city: 'Mississauga',
        province: 'ON',
        postcode: 'L5B 2C9',
      },
      receiver: {
        name: 'Marcus Delaney',
        phone: '+1 647 555 9013',
        line1: '18 Yonge Street, Suite 2204',
        city: 'Toronto',
        province: 'ON',
        postcode: 'M5E 1Z8',
        notes: 'Buzz 2204; no access before 09:00.',
      },
      items: [
        {
          description: 'Dyson V8 replacement filter',
          qty: 1,
          weightKg: 0.3,
          packageType: PackageType.BOX,
          barcode: '8901234500110',
        },
      ],
    },
    {
      clientReference: 'DRZ-CA-88411904',
      priority: Priority.NORMAL,
      taskType: TaskType.PICKUP,
      assign: false,
      generalNote: 'Return — customer cancelled before dispatch.',
      sender: {
        name: 'Priya Raghunathan',
        phone: '+1 416 555 3388',
        line1: '300 Borough Drive, Unit 44',
        city: 'Toronto',
        province: 'ON',
        postcode: 'M1P 4P5',
        instructions: 'Collect from unit door, not the mall entrance.',
      },
      receiver: {
        name: 'Daraz Returns Desk',
        phone: '+1 905 555 8811',
        line1: '5985 Explorer Drive, Suite 400',
        city: 'Mississauga',
        province: 'ON',
        postcode: 'L4W 5K6',
        notes: 'Returns counter closes at 16:30.',
      },
      items: [
        {
          description: 'Instant Pot Duo 6qt (sealed, unopened)',
          qty: 1,
          weightKg: 5.6,
          packageType: PackageType.BOX,
          barcode: '8901234500202',
        },
      ],
    },
  ],
  APX: [
    {
      clientReference: 'APX-2291046',
      priority: Priority.HIGH,
      taskType: TaskType.DELIVERY,
      assign: true,
      generalNote: 'Time-critical — retail launch stock.',
      sender: {
        name: 'Apple Express Airport Depot',
        phone: '+1 905 555 7712',
        line1: '7995 Airport Road, Bay 6',
        city: 'Brampton',
        province: 'ON',
        postcode: 'L6T 5A4',
        instructions: 'Bay 6 only; Bay 5 is a different carrier.',
      },
      receiver: {
        name: 'Eaton Centre — Receiving',
        phone: '+1 416 555 2200',
        line1: '220 Yonge Street, Unit 118',
        city: 'Toronto',
        province: 'ON',
        postcode: 'M5B 2H1',
        notes: 'Loading dock off Trinity Way.',
      },
      items: [
        {
          description: 'Retail display unit, flat-packed',
          qty: 3,
          weightKg: 11.2,
          packageType: PackageType.PALLET,
          barcode: '7701122330014',
        },
      ],
    },
    {
      clientReference: 'APX-2291188',
      priority: Priority.NORMAL,
      taskType: TaskType.DELIVERY,
      assign: false,
      sender: {
        name: 'Apple Express Midtown',
        phone: '+1 416 555 6640',
        line1: '2300 Yonge Street, Suite 1600',
        city: 'Toronto',
        province: 'ON',
        postcode: 'M4P 1E4',
      },
      receiver: {
        name: 'Dr. Helen Osei',
        phone: '+1 647 555 1174',
        line1: '1 Dundas Street West, Unit 505',
        city: 'Toronto',
        province: 'ON',
        postcode: 'M5G 1Z3',
        notes: 'Signature required — do not leave with security.',
      },
      items: [
        {
          description: 'Sealed document wallet',
          qty: 1,
          weightKg: 0.35,
          packageType: PackageType.ENVELOPE,
          barcode: '7701122330120',
        },
      ],
    },
    {
      clientReference: 'APX-2291402',
      priority: Priority.LOW,
      taskType: TaskType.PICKUP,
      assign: true,
      sender: {
        name: 'Vaughan Cold Store',
        phone: '+1 905 555 4409',
        line1: '3300 Steeles Avenue West',
        city: 'Vaughan',
        province: 'ON',
        postcode: 'L4K 2Y4',
        instructions: 'Chilled goods — bring insulated tote.',
      },
      receiver: {
        name: 'West Mall Pharmacy',
        phone: '+1 416 555 8827',
        line1: '25 The West Mall, Unit 210',
        city: 'Toronto',
        province: 'ON',
        postcode: 'M9C 1B8',
      },
      items: [
        {
          description: 'Temperature-controlled sample case',
          qty: 2,
          weightKg: 3.4,
          packageType: PackageType.BOTTLE,
          barcode: '7701122330217',
        },
      ],
    },
  ],
  TCS: [
    {
      clientReference: 'TCS-CA-5580912',
      priority: Priority.NORMAL,
      taskType: TaskType.DELIVERY,
      assign: true,
      sender: {
        name: 'TCS Airport Road Hub',
        phone: '+1 905 555 9100',
        line1: '6900 Airport Road, Dock 12',
        city: 'Mississauga',
        province: 'ON',
        postcode: 'L4V 1E8',
        instructions: 'Dock 12 — reverse in, no side loading.',
      },
      receiver: {
        name: 'Bloor Street Legal LLP',
        phone: '+1 416 555 3050',
        line1: '55 Bloor Street West, Suite 900',
        city: 'Toronto',
        province: 'ON',
        postcode: 'M4W 1A5',
        notes: 'Reception closes 17:00 sharp.',
      },
      items: [
        {
          description: 'Legal case files, banded',
          qty: 4,
          weightKg: 2.1,
          packageType: PackageType.BOX,
          barcode: '6612009900018',
        },
      ],
    },
    {
      clientReference: 'TCS-CA-5581037',
      priority: Priority.HIGH,
      taskType: TaskType.DELIVERY,
      assign: false,
      generalNote: 'Municipal tender documents — deadline 15:00.',
      sender: {
        name: 'Bay Street Corporate Services',
        phone: '+1 416 555 7788',
        line1: '50 Bay Street, Floor 12',
        city: 'Toronto',
        province: 'ON',
        postcode: 'M5J 3A5',
      },
      receiver: {
        name: 'Toronto City Hall — Clerk',
        phone: '+1 416 555 0100',
        line1: '100 Queen Street West',
        city: 'Toronto',
        province: 'ON',
        postcode: 'M5H 2N2',
        notes: 'Deliver to the Clerk counter, main rotunda.',
      },
      items: [
        {
          description: 'Sealed tender envelope',
          qty: 1,
          weightKg: 0.6,
          packageType: PackageType.ENVELOPE,
          barcode: '6612009900117',
        },
      ],
    },
    {
      clientReference: 'TCS-CA-5581290',
      priority: Priority.NORMAL,
      taskType: TaskType.DELIVERY,
      assign: false,
      sender: {
        name: 'TCS Lakeshore Depot',
        phone: '+1 905 555 6612',
        line1: '1250 South Service Road',
        city: 'Mississauga',
        province: 'ON',
        postcode: 'L5E 1V4',
      },
      receiver: {
        name: 'York University — Bergeron Receiving',
        phone: '+1 416 555 5544',
        line1: '4700 Keele Street, Bergeron Centre',
        city: 'Toronto',
        province: 'ON',
        postcode: 'M3J 1P3',
        notes: 'Campus deliveries 08:00-15:00 only.',
      },
      items: [
        {
          description: 'Lab consumables carton',
          qty: 2,
          weightKg: 7.8,
          packageType: PackageType.BOX,
          barcode: '6612009900214',
        },
        {
          description: 'Calibration fluid, 1L',
          qty: 6,
          weightKg: 1.05,
          packageType: PackageType.BOTTLE,
          barcode: '6612009900221',
        },
      ],
    },
  ],
};

async function wipeStorage() {
  const { data: folders, error } = await supabase.storage.from(POD_BUCKET).list('', { limit: 1000 });
  if (error) {
    console.warn(`· could not list ${POD_BUCKET}: ${error.message}`);
    return;
  }

  const paths: string[] = [];
  for (const folder of folders ?? []) {
    // Objects live at {consignmentId}/{LEG}/{photo|signature}.{ext}, so the
    // listing is two levels deep before there is anything to delete.
    for (const leg of ['PICKUP', 'DELIVERY']) {
      const { data: files } = await supabase.storage
        .from(POD_BUCKET)
        .list(`${folder.name}/${leg}`, { limit: 100 });
      for (const f of files ?? []) paths.push(`${folder.name}/${leg}/${f.name}`);
    }
  }

  if (paths.length) await supabase.storage.from(POD_BUCKET).remove(paths);
  console.log(`✓ storage: removed ${paths.length} proof file(s)`);
}

/** Remove every Supabase Auth account, so the seed owns the whole user list. */
async function wipeAuthUsers() {
  const { data, error } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) {
    console.warn(`· could not list auth users: ${error.message}`);
    return;
  }
  for (const u of data.users) await supabase.auth.admin.deleteUser(u.id);
  console.log(`✓ auth: removed ${data.users.length} login(s)`);
}

/**
 * Create a Supabase login and the matching profile row.
 *
 * The profile's primary key IS the auth user's id — they are the same person,
 * and `middleware/auth.ts` resolves one to the other on every request.
 */
async function createLogin(opts: {
  email: string;
  password: string;
  name: string;
  role: 'admin' | 'operator' | 'driver';
  driverId?: string;
}) {
  const { data, error } = await supabase.auth.admin.createUser({
    email: opts.email,
    password: opts.password,
    email_confirm: true,
    app_metadata: { role: opts.role, driver_id: opts.driverId ?? null },
    user_metadata: { name: opts.name },
  });
  if (error || !data.user) {
    throw new Error(`Could not create ${opts.email}: ${error?.message ?? 'unknown error'}`);
  }

  return prisma.user.create({
    data: {
      id: data.user.id,
      email: opts.email,
      name: opts.name,
      role: opts.role,
      driverId: opts.driverId ?? null,
    },
  });
}

async function main() {
  // 0. wipe — order matters: children before parents, files before rows.
  await wipeStorage();
  await prisma.driverLocation.deleteMany();
  await prisma.proofOfDelivery.deleteMany();
  await prisma.trackingEvent.deleteMany();
  await prisma.item.deleteMany();
  await prisma.consignment.deleteMany();
  await prisma.orderCounter.deleteMany();
  await prisma.user.deleteMany();
  await prisma.driver.deleteMany();
  await prisma.client.deleteMany();
  await wipeAuthUsers();
  console.log('✓ wiped');

  // 1. clients
  for (const c of CLIENTS) {
    await prisma.client.create({ data: { name: c.name, code: c.code, active: true } });
  }
  console.log(`✓ clients: ${CLIENTS.length}`);

  /*
   * 2. drivers — roster row first, then the login that points at it.
   *
   * Not all off shift any more. Assignment now REFUSES an off-shift driver, so a
   * roster where nobody is clocked on is a dataset where an operator cannot
   * assign anything and the console looks broken.
   *
   * The split is deliberate: most drivers on shift so the happy path works
   * immediately, and two left off — with a *completed* shift from yesterday — so
   * the refusal is testable and `shiftEndedAt` has something in it.
   *
   * Times are relative offsets, never a fixed hour: seeding at 07:00 must not
   * produce a shift that started at 09:00 this morning, in the future.
   */
  const now = Date.now();
  const HOUR = 3_600_000;

  for (const [i, d] of DRIVERS.entries()) {
    const onShift = i < ON_SHIFT_COUNT;
    const driver = await prisma.driver.create({
      data: {
        name: d.name,
        code: d.code,
        mobile: d.mobile,
        active: true,
        // Stable map colours from the start. Without this every driver is null and
        // the dispatch map falls back to hashing their id, so colours shuffle on
        // every reseed.
        mapColorIndex: i % MAP_COLOR_COUNT,
        onShift,
        shiftStartedAt: new Date(now - (onShift ? 3 * HOUR : 27 * HOUR)),
        shiftEndedAt: onShift ? null : new Date(now - 18 * HOUR),
      },
    });
    await createLogin({
      email: `${slug(d.name)}@${EMAIL_DOMAIN}`,
      password: SEED_DRIVER_PASSWORD,
      name: d.name,
      role: 'driver',
      driverId: driver.id,
    });
  }
  console.log(
    `✓ drivers: ${DRIVERS.length} (each with a login; ${ON_SHIFT_COUNT} on shift, ` +
      `${DRIVERS.length - ON_SHIFT_COUNT} off)`,
  );

  // 3. admin
  const admin = await createLogin({
    email: env.SEED_ADMIN_EMAIL,
    password: env.SEED_ADMIN_PASSWORD,
    name: env.SEED_ADMIN_NAME,
    role: 'admin',
  });
  console.log(`✓ admin: ${admin.email}`);

  // Only on-shift drivers receive seeded work. An assigned order belonging to a
  // driver who is off shift is legal — they clocked off mid-run — but seeding one
  // would hand an operator a dataset that contradicts the rule they are about to
  // meet when they try to swap the driver.
  const drivers = await prisma.driver.findMany({
    where: { onShift: true },
    orderBy: { code: 'asc' },
    select: { id: true, name: true },
  });

  // 4. orders — skipped for any client that already has some
  let driverCursor = 0;
  let created = 0;

  for (const clientDef of CLIENTS) {
    const client = await prisma.client.findUniqueOrThrow({ where: { code: clientDef.code } });
    const existing = await prisma.consignment.count({ where: { clientId: client.id } });
    if (existing > 0) {
      console.log(`· ${client.name}: ${existing} order(s) already present, skipping`);
      continue;
    }

    for (const order of ORDERS[clientDef.code]) {
      const driver = order.assign ? drivers[driverCursor++ % drivers.length] : null;

      await prisma.$transaction(async (tx) => {
        // Same allocator the API uses, so the counter advances and the first
        // API-created order of the day does not collide with seeded numbers.
        const orderNo = await generateOrderNo(tx, {
          clientId: client.id,
          clientCode: client.code,
        });

        const consignment = await tx.consignment.create({
          data: {
            orderNo,
            clientReference: order.clientReference,
            clientId: client.id,
            driverId: driver?.id ?? null,
            status: driver ? ConsignmentStatus.ASSIGNED : ConsignmentStatus.UNASSIGNED,
            assignedAt: driver ? new Date() : null,
            priority: order.priority,
            taskType: order.taskType,

            senderName: order.sender.name,
            senderPhone: order.sender.phone,
            senderLine1: order.sender.line1,
            senderProvince: order.sender.province,
            senderCity: order.sender.city,
            senderPostcode: order.sender.postcode ?? null,
            senderInstructions: order.sender.instructions ?? null,
            senderLat: coordsFor(order.sender.line1)[0],
            senderLng: coordsFor(order.sender.line1)[1],

            receiverName: order.receiver.name,
            receiverPhone: order.receiver.phone,
            receiverLine1: order.receiver.line1,
            receiverProvince: order.receiver.province,
            receiverCity: order.receiver.city,
            receiverPostcode: order.receiver.postcode ?? null,
            receiverNotes: order.receiver.notes ?? null,
            receiverLat: coordsFor(order.receiver.line1)[0],
            receiverLng: coordsFor(order.receiver.line1)[1],

            generalNote: order.generalNote ?? null,
            createdByUserId: admin.id,
            lastUpdatedByUserId: admin.id,

            items: {
              create: order.items.map((i) => ({
                description: i.description,
                qty: i.qty,
                weightKg: i.weightKg,
                packageType: i.packageType,
                barcode: i.barcode ?? null,
              })),
            },
          },
          select: { id: true },
        });

        await tx.trackingEvent.create({
          data: {
            consignmentId: consignment.id,
            fromStatus: null,
            toStatus: ConsignmentStatus.UNASSIGNED,
            actorUserId: admin.id,
            actorEmail: admin.email,
            note: 'Consignment logged (seed)',
          },
        });

        if (driver) {
          await tx.trackingEvent.create({
            data: {
              consignmentId: consignment.id,
              fromStatus: ConsignmentStatus.UNASSIGNED,
              toStatus: ConsignmentStatus.ASSIGNED,
              driverId: driver.id,
              actorUserId: admin.id,
              actorEmail: admin.email,
              note: `Assigned to ${driver.name} (seed)`,
            },
          });
        }
      });

      created += 1;
    }
  }

  console.log(`✓ consignments created: ${created}`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error('Seed failed:', e);
    await prisma.$disconnect();
    process.exit(1);
  });
