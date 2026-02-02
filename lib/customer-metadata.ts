import { Prisma } from "@prisma/client";

export type CustomerProfile = {
  active: boolean;
  newsletter: boolean;
  b2b: boolean;
  gender: string | null;
  birthDate: string | null;
  customerNumber: string | null;
  companyName: string | null;
  discountPercent: number | null;
  comment: string | null;
  priceBook: string | null;
  firstSeenAt: string | null;
  phoneType: string | null;
  photoUrl: string | null;
  address: {
    street: string | null;
    houseNumber: string | null;
    postalCode: string | null;
    city: string | null;
    state: string | null;
    country: string | null;
  };
};

export type CustomerNote = {
  id: string;
  text: string;
  createdAt: string;
};

type CustomerMetadataShape = {
  customerProfile?: Partial<CustomerProfile>;
  customerNotes?: CustomerNote[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length ? value : null;
}

function readBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

export function readCustomerProfile(metadata: Prisma.JsonValue | null): CustomerProfile {
  const record = isRecord(metadata) ? (metadata as CustomerMetadataShape) : {};
  const profile = isRecord(record.customerProfile) ? record.customerProfile : {};
  const address = isRecord(profile.address) ? profile.address : {};

  return {
    active: readBoolean(profile.active, true),
    newsletter: readBoolean(profile.newsletter, false),
    b2b: readBoolean(profile.b2b, false),
    gender: readString(profile.gender),
    birthDate: readString(profile.birthDate),
    customerNumber: readString(profile.customerNumber),
    companyName: readString(profile.companyName),
    discountPercent: readNumber(profile.discountPercent),
    comment: readString(profile.comment),
    priceBook: readString(profile.priceBook),
    firstSeenAt: readString(profile.firstSeenAt),
    phoneType: readString(profile.phoneType),
    photoUrl: readString(profile.photoUrl),
    address: {
      street: readString(address.street),
      houseNumber: readString(address.houseNumber),
      postalCode: readString(address.postalCode),
      city: readString(address.city),
      state: readString(address.state),
      country: readString(address.country),
    },
  };
}

export function applyCustomerProfile(
  metadata: Prisma.JsonValue | null,
  updates: Partial<CustomerProfile>,
): Prisma.InputJsonValue {
  const record = isRecord(metadata) ? { ...(metadata as CustomerMetadataShape) } : {};
  const currentProfile = isRecord(record.customerProfile) ? { ...record.customerProfile } : {};
  const nextProfile = { ...currentProfile, ...updates };
  record.customerProfile = nextProfile;
  return record as Prisma.InputJsonValue;
}

export function readCustomerNotes(metadata: Prisma.JsonValue | null): CustomerNote[] {
  const record = isRecord(metadata) ? (metadata as CustomerMetadataShape) : {};
  const raw = Array.isArray(record.customerNotes) ? record.customerNotes : [];
  return raw
    .map((note) => {
      if (!isRecord(note)) return null;
      const text = readString(note.text);
      const createdAt = readString(note.createdAt);
      const id = readString(note.id);
      if (!text || !createdAt || !id) return null;
      return { id, text, createdAt };
    })
    .filter((note): note is CustomerNote => Boolean(note));
}

export function appendCustomerNote(
  metadata: Prisma.JsonValue | null,
  note: CustomerNote,
): Prisma.InputJsonValue {
  const record = isRecord(metadata) ? { ...(metadata as CustomerMetadataShape) } : {};
  const notes = readCustomerNotes(record as Prisma.JsonValue | null);
  notes.unshift(note);
  record.customerNotes = notes;
  return record as Prisma.InputJsonValue;
}
