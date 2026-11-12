import type { Sensitivity } from '../fields.js';

/** What a single part of a record can hold. Validation and display follow from this. */
export type PartType =
  | 'text'      // one line
  | 'longtext'  // paragraphs
  | 'date'      // partial ISO date: YYYY, YYYY-MM or YYYY-MM-DD (histories rarely know the day)
  | 'datetime'  // a moment and its time zone: { at: ISO 8601 with offset, tz: IANA zone } (see datetime.ts)
  | 'email'
  | 'phone'
  | 'url'
  | 'country'   // ISO 3166-1 alpha-2, e.g. US
  | 'currency'  // ISO 4217, e.g. USD
  | 'money'     // { amount: number, currency: 'USD' }
  | 'number'
  | 'boolean'
  | 'enum'      // one of options
  | 'last4'     // exactly four digits, e.g. a card on a receipt
  | 'region'    // ISO 3166-1 country or ISO 3166-2 subdivision, e.g. US or US-OR
  | 'address'   // { street1?, street2?, city?, region?, postalCode?, country }: one shape everywhere
  | 'time'      // local time of day, HH:MM or HH:MM:SS
  | 'timezone'  // IANA time zone, e.g. America/Chicago
  | 'geo'       // { lat, lon } in decimal degrees
  | 'repeat'    // iCalendar repeat rule (RFC 5545 RRULE), e.g. FREQ=WEEKLY;BYDAY=TU
  | 'party'     // id of a party: a person or organisation (employer, landlord, doctor…). Never a typed name.
  | 'record'    // id of another entry (`to` lists the categories it may point to); `many` for a list of them
  | 'contact'   // old name for party, kept until every caller says party
  | 'list';     // rows of sub-parts (`of`), e.g. a receipt's line items

/** A condition on another part's value. ['*'] means any value at all (a birth's time zone once a time is given). */
export type When = { part: string; in: string[] };

export type SensitivityBy = { part: string; values: Record<string, Sensitivity> };

export type PartDef = {
  key: string;
  /** What cards, shares and copies call it ("Born"). */
  label: string;
  /** The question the form asks instead, in plain words ("When were you born?"). */
  ask?: string;
  type: PartType;
  required?: boolean;
  /** Defaults to the domain's sensitivity. Only secret parts are encrypted at rest. */
  sensitivity?: Sensitivity;
  options?: [string, string][];
  hint?: string;
  /** For list parts: what each row holds. Simple types only (no list or contact). */
  of?: PartDef[];
  /** A date worth a heads-up before it passes (return by, warranty until). Shown on Home, then dropped two weeks after. */
  remind?: boolean;
  /** money: the value also says per what (hour, week, month, year, once), e.g. pay or a premium. */
  periodic?: boolean;
  /** record: the categories this link may point to, e.g. ['ids'] for "Proven by". */
  to?: string[];
  /** record: a list of links rather than one. */
  many?: boolean;
  /** Only applies when another part holds one of these values, e.g. collection details when status is in_collections.
   *  A list means any of them: "Owned with" shows for a shared home or for a valuable. */
  when?: When | When[];
  /** A label that follows another part, e.g. a contact method's value reads "Email address" or "Phone number" by kind. */
  labelBy?: { part: string; labels: Record<string, string> };
  /** text: common answers offered as you type (Personal, Work…). Anything else is still fine. */
  suggestions?: string[];
  /** country: a new entry starts with the country you live in (your passport, your license), changeable as ever. */
  prefill?: 'home_country';
  /** timezone: filled in from the place (these parts) until the owner picks one, so nobody has to know "America/Chicago". */
  zoneFrom?: { country: string; region?: string };
  /** true: always under More details, however early it comes (name parts most people never need). false: always up
   *  front, however late it comes (a birth's time, after the place). Otherwise the form decides. */
  more?: boolean;
  /** party: what's usually there (an employer is an organisation), so a new one starts as the right type. */
  expects?: 'person' | 'organisation';
  /** Replaced by another part. It keeps working (old records and clients use it), but new UIs shouldn't offer it. Parts are never removed. */
  deprecated?: boolean;
  /** Kept up to date by Little Dipper itself (who asked you, their answer), never typed: editors don't offer it. */
  system?: boolean;
};

export type DomainDef = {
  /** URL segment and grant key: /api/data/{id}. Custom domains are prefixed x_. */
  id: string;
  label: string;
  /** Singular noun for one record, e.g. "residence". */
  noun: string;
  group: 'identity' | 'life' | 'work' | 'health' | 'money' | 'personal' | 'custom';
  description: string;
  /**
   * How sensitive an entry is unless the owner says otherwise. Each entry can be set on its own;
   * parts that declare a sensitivity (a passport number is always secret) keep it whatever the entry says.
   */
  sensitivity: Sensitivity;
  /** A default per kind of entry, e.g. names: preferred is standard, legal is sensitive. A list: the first that matches. */
  sensitivityBy?: SensitivityBy | SensitivityBy[];
  /** Sharing or sending the whole category needs an explicit confirm, even without secret details (IDs, health, money). */
  confirmShare?: boolean;
  /** At most one entry (Birth, Health basics). */
  single?: boolean;
  /** Shown somewhere other than My data: on each person's page (relationships), in the action bar (tasks), on the Calendar (events), on its own page in the menu (notes) or on Profile basics (birth). Still records. */
  livesOn?: 'party' | 'actions' | 'profile' | 'calendar' | 'menu';
  /** Shared one entry at a time, never as a whole live category: too revealing together (online accounts) or not a thing to share (tasks, notes). */
  oneAtATime?: boolean;
  /** Related entries and documents this category invites, e.g. a vehicle invites its title, insurance and loan. Never required. */
  companions?: { domain?: string; document?: string; label: string; when?: { part: string; in: string[] } }[];
  parts: PartDef[];
  /** Records carry validFrom/validTo; "current" = no validTo. */
  dated: boolean;
  /** Display line for one record, e.g. "{title} at {employer}". */
  title: string;
  /** Allowed on the public profile (only its non-secret, standard-or-sensitive parts the owner chooses). */
  publicable: boolean;
  /** Newest-first order by this date part instead of when the record was added (receipts: purchase date). */
  sortBy?: string;
  /** Entries take linked documents (scans, photos, PDFs); new ones get this kind, e.g. 'insurance_card'. */
  documents?: string;
  builtIn: boolean;
  schemaVersion: number;
};

/** Who wrote to a record: the owner (session), an app key, an import, or Little Dipper itself. */
export type Actor = { type: 'owner' | 'app' | 'import' | 'system'; id: string };

/**
 * A record as it stood after one change (or just before, for a delete), kept so owners can see
 * how it changed and go back. Same fields as the record; secret parts stay encrypted.
 */
export type VersionDoc = Omit<RecordDoc, '_id'> & { _id: string; recordId: string; action: 'create' | 'update' | 'delete' | 'restore'; at: string; by: Actor };

export type RecordDoc = {
  _id: string;
  domain: string;
  /** Part values. Secret parts hold enc:v1:… strings. */
  data: Record<string, unknown>;
  validFrom: string | null;
  validTo: string | null;
  /** The owner's choice for this entry; unset means the category's default for its kind. */
  sensitivity?: Sensitivity;
  notes: string;
  /** Who created it. Owner, an app key, an import… */
  source: Actor;
  /** Who made the latest change: set on every create and edit, so an app's edit to the owner's record says so. */
  updatedBy: Actor;
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;
};
