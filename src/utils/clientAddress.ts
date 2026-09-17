/**
 * A client's default pickup address lives in flat columns on `clients`, but it
 * travels as one value object: either a complete, routable address or nothing.
 *
 * "Complete" means line1 + city + both coordinates. A client with a street but
 * no pin would prefill an order that cannot be mapped or routed, and an
 * operator would not notice until the order was already on a driver's phone.
 * Returning null instead makes the gap visible in the picker.
 */
export type ClientAddressColumns = {
  contactName: string | null;
  phone: string | null;
  email: string | null;
  line1: string | null;
  city: string | null;
  province: string | null;
  postcode: string | null;
  lat: number | null;
  lng: number | null;
  instructions: string | null;
};

export type ClientAddressDto = {
  contactName: string | null;
  phone: string | null;
  email: string | null;
  line1: string;
  city: string;
  province: string | null;
  postcode: string | null;
  lat: number;
  lng: number;
  instructions: string | null;
};

export function toClientAddress(row: ClientAddressColumns): ClientAddressDto | null {
  if (!row.line1 || !row.city || row.lat === null || row.lng === null) return null;
  return {
    contactName: row.contactName,
    phone: row.phone,
    email: row.email,
    line1: row.line1,
    city: row.city,
    province: row.province,
    postcode: row.postcode,
    lat: row.lat,
    lng: row.lng,
    instructions: row.instructions,
  };
}
