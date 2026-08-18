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
  { name: 'Muhammad Abdullah', code: 'DRV-001', mobile: '+92 300 4412878' },
  { name: 'Bilal Ahmed', code: 'DRV-002', mobile: '+92 301 2298043' },
  { name: 'Usman Tariq', code: 'DRV-003', mobile: '+92 321 7734190' },
  { name: 'Hamza Sheikh', code: 'DRV-004', mobile: '+92 333 5580216' },
  { name: 'Ali Raza', code: 'DRV-005', mobile: '+92 345 9017762' },
  { name: 'Faisal Mahmood', code: 'DRV-006', mobile: '+92 302 6643915' },
  { name: 'Zain Ul Abideen', code: 'DRV-007', mobile: '+92 311 8820574' },
  { name: 'Ahsan Iqbal', code: 'DRV-008', mobile: '+92 322 4471308' },
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
    area: string;
    city: string;
    postcode?: string;
    instructions?: string;
  };
  receiver: {
    name: string;
    phone: string;
    line1: string;
    area: string;
    city: string;
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
 * right street in the right city, which is all a demo needs. Real orders get
 * their coordinates from the address autocomplete or a dragged pin.
 */
const DEMO_COORDS: Record<string, [number, number]> = {
  // Lahore
  'Warehouse 4, Sundar Industrial Estate': [31.2833, 74.1167],
  'House 214, Street 8, Block C, DHA Phase 5': [31.4697, 74.4083],
  'Office 501, Eden Tower, Main Boulevard': [31.51, 74.35],
  'Lahore High Court Building, Mall Road': [31.5656, 74.3142],
  '31-A, Model Town Link Road': [31.48, 74.32],
  'Apartment 5C, Askari 11 Sector B': [31.45, 74.4],
  // Karachi
  'Plot 22, Korangi Creek Industrial Park': [24.8, 67.16],
  'Flat 703, Ocean Tower, Block 9': [24.8138, 67.03],
  'Unit 9, SITE Industrial Area': [24.89, 67.02],
  'Shop 18, Bolton Market': [24.85, 67.01],
  '145-C, Tariq Road': [24.872, 67.062],
  'House 88, Street 12, Gulshan-e-Iqbal Block 13-D': [24.92, 67.09],
  // Islamabad
  'House 12-B, Street 41, G-9/1': [33.69, 73.03],
  'Warehouse 1, I-9 Industrial Area': [33.66, 73.07],
  'Shop 4, Kohsar Market': [33.7294, 73.0817],
  'Clinic 3, Ground Floor, Pearl Continental Medical Centre': [33.71, 73.06],
  'Suite 12, Beverly Centre, Jinnah Avenue': [33.708, 73.064],
  'Shop 7, F-10 Markaz': [33.695, 73.013],
};

const coordsFor = (line1: string) => DEMO_COORDS[line1] ?? [null, null];

const ORDERS: Record<string, SeedOrder[]> = {
  DRZ: [
    {
      clientReference: 'DRZ-PK-88410233',
      priority: Priority.NORMAL,
      taskType: TaskType.DELIVERY,
      assign: false,
      generalNote: 'Customer requested delivery after 5pm.',
      sender: {
        name: 'Daraz Fulfilment Centre',
        phone: '+92 42 3529 8800',
        line1: 'Warehouse 4, Sundar Industrial Estate',
        area: 'Raiwind Road',
        city: 'Lahore',
        postcode: '54000',
        instructions: 'Report to Gate 2, dock 7.',
      },
      receiver: {
        name: 'Sana Yousaf',
        phone: '+92 300 4471129',
        line1: 'House 214, Street 8, Block C, DHA Phase 5',
        area: 'DHA Phase 5',
        city: 'Lahore',
        postcode: '54792',
        notes: 'Green gate, ring the bell twice.',
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
      clientReference: 'DRZ-PK-88410417',
      priority: Priority.HIGH,
      taskType: TaskType.DELIVERY,
      assign: true,
      generalNote: 'Fragile — glassware. Do not stack.',
      sender: {
        name: 'Daraz Fulfilment Centre',
        phone: '+92 21 3456 7100',
        line1: 'Plot 22, Korangi Creek Industrial Park',
        area: 'Korangi Creek',
        city: 'Karachi',
        postcode: '74900',
      },
      receiver: {
        name: 'Imran Qureshi',
        phone: '+92 333 2298871',
        line1: 'Flat 703, Ocean Tower, Block 9',
        area: 'Clifton',
        city: 'Karachi',
        postcode: '75600',
        notes: 'Leave with building concierge if not home.',
      },
      items: [
        {
          description: 'Ceramic dinner set, 12 pieces',
          qty: 1,
          weightKg: 6.4,
          packageType: PackageType.BOX,
          barcode: '8901234500035',
        },
      ],
    },
    {
      clientReference: 'DRZ-PK-88411006',
      priority: Priority.NORMAL,
      taskType: TaskType.PICKUP,
      assign: false,
      generalNote: 'Return pickup — buyer cancelled after dispatch.',
      sender: {
        name: 'Ayesha Nadeem',
        phone: '+92 345 6612094',
        line1: 'House 12-B, Street 41, G-9/1',
        area: 'G-9',
        city: 'Islamabad',
        postcode: '44000',
      },
      receiver: {
        name: 'Daraz Returns Desk',
        phone: '+92 51 2870 440',
        line1: 'Warehouse 1, I-9 Industrial Area',
        area: 'I-9',
        city: 'Islamabad',
        postcode: '44000',
        notes: 'Returns counter, weekdays only.',
      },
      items: [
        {
          description: 'Running shoes, size 42 (return)',
          qty: 1,
          weightKg: 0.9,
          packageType: PackageType.BOX,
          barcode: '8901234500042',
        },
      ],
    },
  ],
  APX: [
    {
      clientReference: 'APX-2026-00714',
      priority: Priority.HIGH,
      taskType: TaskType.DELIVERY,
      assign: true,
      generalNote: 'Time-critical legal documents.',
      sender: {
        name: 'Malik & Associates',
        phone: '+92 42 3577 1290',
        line1: 'Office 501, Eden Tower, Main Boulevard',
        area: 'Gulberg III',
        city: 'Lahore',
        postcode: '54660',
        instructions: 'Collect from reception, ask for Mr. Farooq.',
      },
      receiver: {
        name: 'Lahore High Court — Registrar Office',
        phone: '+92 42 9921 3300',
        line1: 'Lahore High Court Building, Mall Road',
        area: 'Anarkali',
        city: 'Lahore',
        postcode: '54000',
        notes: 'Signature of receiving clerk required.',
      },
      items: [
        {
          description: 'Sealed legal document envelope',
          qty: 1,
          weightKg: 0.35,
          packageType: PackageType.ENVELOPE,
        },
      ],
    },
    {
      clientReference: 'APX-2026-00728',
      priority: Priority.NORMAL,
      taskType: TaskType.DELIVERY,
      assign: false,
      sender: {
        name: 'BioScript Pharmacy',
        phone: '+92 51 2731 884',
        line1: 'Shop 4, Kohsar Market',
        area: 'F-6/3',
        city: 'Islamabad',
        postcode: '44000',
        instructions: 'Cold chain box — collect from the back counter.',
      },
      receiver: {
        name: 'Dr. Nadia Hussain',
        phone: '+92 300 8842217',
        line1: 'Clinic 3, Ground Floor, Pearl Continental Medical Centre',
        area: 'Blue Area',
        city: 'Islamabad',
        postcode: '44000',
        notes: 'Refrigerate immediately on arrival.',
      },
      items: [
        {
          description: 'Temperature-controlled medicine pack',
          qty: 1,
          weightKg: 2.1,
          packageType: PackageType.BOX,
          barcode: '8909876500017',
        },
        {
          description: 'Cold chain gel packs',
          qty: 4,
          weightKg: 1.6,
          packageType: PackageType.BOX,
        },
      ],
    },
    {
      clientReference: 'APX-2026-00733',
      priority: Priority.LOW,
      taskType: TaskType.DELIVERY,
      assign: false,
      sender: {
        name: 'BoxFleet Inc.',
        phone: '+92 21 3466 2200',
        line1: 'Unit 9, SITE Industrial Area',
        area: 'SITE',
        city: 'Karachi',
        postcode: '75700',
      },
      receiver: {
        name: 'Rehan Enterprises',
        phone: '+92 321 2094476',
        line1: 'Shop 18, Bolton Market',
        area: 'Kharadar',
        city: 'Karachi',
        postcode: '74000',
      },
      items: [
        {
          description: 'Packaging cartons, flat-packed bundle',
          qty: 5,
          weightKg: 14.5,
          packageType: PackageType.PALLET,
        },
      ],
    },
  ],
  TCS: [
    {
      clientReference: 'TCS-KHI-551203',
      priority: Priority.NORMAL,
      taskType: TaskType.DELIVERY,
      assign: true,
      sender: {
        name: 'TCS Express Centre — Tariq Road',
        phone: '+92 21 111 123 456',
        line1: '145-C, Tariq Road',
        area: 'PECHS Block 2',
        city: 'Karachi',
        postcode: '75400',
      },
      receiver: {
        name: 'Farhan Siddiqui',
        phone: '+92 302 7719954',
        line1: 'House 88, Street 12, Gulshan-e-Iqbal Block 13-D',
        area: 'Gulshan-e-Iqbal',
        city: 'Karachi',
        postcode: '75300',
        notes: 'Call on arrival, narrow lane.',
      },
      items: [
        {
          description: 'Documents envelope — bank statements',
          qty: 1,
          weightKg: 0.22,
          packageType: PackageType.ENVELOPE,
          barcode: '8905550012349',
        },
      ],
    },
    {
      clientReference: 'TCS-LHE-551288',
      priority: Priority.NORMAL,
      taskType: TaskType.DELIVERY,
      assign: false,
      generalNote: 'Recipient works night shift — deliver before noon.',
      sender: {
        name: 'TCS Express Centre — Model Town',
        phone: '+92 42 111 123 456',
        line1: '31-A, Model Town Link Road',
        area: 'Model Town',
        city: 'Lahore',
        postcode: '54700',
      },
      receiver: {
        name: 'Hina Baig',
        phone: '+92 336 4408821',
        line1: 'Apartment 5C, Askari 11 Sector B',
        area: 'Askari 11',
        city: 'Lahore',
        postcode: '54000',
      },
      items: [
        {
          description: 'Laptop sleeve and accessories',
          qty: 1,
          weightKg: 1.15,
          packageType: PackageType.BOX,
          barcode: '8905550012356',
        },
      ],
    },
    {
      clientReference: 'TCS-ISB-551340',
      priority: Priority.HIGH,
      taskType: TaskType.PICKUP,
      assign: false,
      generalNote: 'Corporate account — monthly document collection.',
      sender: {
        name: 'Dynacare Diagnostics',
        phone: '+92 51 8446 720',
        line1: 'Suite 12, Beverly Centre, Jinnah Avenue',
        area: 'Blue Area',
        city: 'Islamabad',
        postcode: '44000',
        instructions: 'Pickup from admin office, 1st floor.',
      },
      receiver: {
        name: 'TCS Express Centre — F-10',
        phone: '+92 51 111 123 456',
        line1: 'Shop 7, F-10 Markaz',
        area: 'F-10',
        city: 'Islamabad',
        postcode: '44000',
      },
      items: [
        {
          description: 'Sealed lab report bundle',
          qty: 3,
          weightKg: 2.4,
          packageType: PackageType.ENVELOPE,
        },
      ],
    },
  ],
};

/** Empty the private POD bucket. Truncating tables leaves the files orphaned. */
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
            senderArea: order.sender.area,
            senderCity: order.sender.city,
            senderPostcode: order.sender.postcode ?? null,
            senderInstructions: order.sender.instructions ?? null,
            senderLat: coordsFor(order.sender.line1)[0],
            senderLng: coordsFor(order.sender.line1)[1],

            receiverName: order.receiver.name,
            receiverPhone: order.receiver.phone,
            receiverLine1: order.receiver.line1,
            receiverArea: order.receiver.area,
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
