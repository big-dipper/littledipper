/**
 * The built-in global data model. Each domain is its own endpoint (/api/data/{id}),
 * its own grant in the contact admin, and its own scope for app keys.
 * Bump schemaVersion when a domain's parts change shape.
 */
import type { DomainDef, PartDef } from './types.js';

const o = (...pairs: string[]): [string, string][] => pairs.map((p) => {
  const [k, l] = p.split('=');
  return [k, l ?? k.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())];
});

// Reusable part groups
const ADDRESS: PartDef[] = [
  { key: 'street1', label: 'Street', type: 'text', required: true, sensitivity: 'sensitive' },
  { key: 'street2', label: 'Apartment, suite, unit', type: 'text', sensitivity: 'sensitive' },
  { key: 'city', label: 'City', type: 'text', required: true },
  { key: 'region', label: 'State / region', type: 'text' },
  { key: 'postalCode', label: 'Postal code', type: 'text', sensitivity: 'sensitive' },
  { key: 'country', label: 'Country', type: 'country', required: true },
];

type Def = Omit<DomainDef, 'builtIn' | 'schemaVersion'> & { schemaVersion?: number };

const DEFS: Def[] = [
  // ── identity ─────────────────────────────────────────────────────────
  {
    // The single source for every name. The profile's legal and preferred names, the account name and the public
    // name all come from here. Kind says what a name is for, dates say when it applied, reason says why it changed:
    // a birth name is the legal name whose reason is birth. Most people only ever need the first two kinds, so the
    // rest wait behind "Another name".
    id: 'names', label: 'Names', noun: 'name', group: 'identity', sensitivity: 'sensitive', dated: true, publicable: false,
    sensitivityBy: [{ part: 'kind', values: { preferred: 'standard' } }, { part: 'otherKind', values: { professional: 'standard', nickname: 'standard' } }],
    description: 'The name you go by, your legal name, and any others, with when each applied.',
    title: '{full} ({otherKind|kind})',
    parts: [
      { key: 'kind', label: 'Which name', ask: 'What’s this name?', type: 'enum', required: true, options: o('preferred=The name I go by', 'legal=My legal name', 'other=Another name') },
      { key: 'full', label: 'Full name', type: 'text', required: true, hint: 'As you write it' },
      { key: 'alsoLegal', label: 'This is also my legal name', type: 'boolean', when: { part: 'kind', in: ['preferred'] }, hint: 'So you don’t add the same name twice' },
      { key: 'otherKind', label: 'What kind', type: 'enum', required: true, when: { part: 'kind', in: ['other'] }, options: o('professional=Work or stage name', 'nickname', 'religious=Religious name', 'other') },
      { key: 'reason', label: 'How you got this name', type: 'enum', when: [{ part: 'kind', in: ['legal'] }, { part: 'alsoLegal', in: ['true'] }], options: o('birth', 'marriage', 'divorce', 'adoption', 'court_order=Court order', 'naturalization', 'other') },
      { key: 'given', label: 'Given name', type: 'text', more: true, hint: 'The parts are for forms that split a name' },
      { key: 'middle', label: 'Middle name(s)', type: 'text', more: true },
      { key: 'family', label: 'Family name', type: 'text', more: true },
      { key: 'suffix', label: 'Suffix', type: 'text', more: true },
    ],
  },
  {
    // One entry. Place before time: most people know where, few know when to the minute. The zone follows the
    // place, so the time is exact without anyone knowing what "America/Chicago" means.
    id: 'birth', label: 'Birth', noun: 'birth', group: 'identity', sensitivity: 'sensitive', dated: false, publicable: true, single: true, livesOn: 'profile', documents: 'certificate',
    description: 'When and where you were born. Your birthday shows in Calendar.',
    title: '{date}',
    parts: [
      { key: 'date', label: 'Born', ask: 'When were you born?', type: 'date', required: true },
      { key: 'city', label: 'City', type: 'text' },
      { key: 'region', label: 'State / region', type: 'text' },
      { key: 'country', label: 'Country', type: 'country', hint: 'Today’s country' },
      { key: 'time', label: 'Time', ask: 'What time?', type: 'time', more: false, hint: 'If you know it. Astrologers and some cultures care.' },
      { key: 'timeZone', label: 'Time zone', type: 'timezone', when: { part: 'time', in: ['*'] }, zoneFrom: { country: 'country', region: 'region' }, more: false, hint: 'Filled in from the place. Change it if you were born near a border.' },
      { key: 'asWritten', label: 'Place name on your birth certificate', type: 'text', more: true, hint: 'If it’s changed since, like Leningrad, USSR' },
    ],
  },
  {
    // Four kinds cover most people anywhere; the rest wait behind "Another ID". Each kind only asks what it has: a
    // license or ID card a state or region (where there are any), never anything US-only by default.
    id: 'ids', label: 'IDs', noun: 'ID', group: 'identity', sensitivity: 'sensitive', confirmShare: true, dated: false, publicable: false, documents: 'id',
    description: 'Passport, driver’s license, ID card, tax or social security number and your other IDs. Numbers are encrypted.',
    title: '{otherKind|kind} · {authority|issuer}',
    parts: [
      { key: 'kind', label: 'Kind', ask: 'What kind of ID?', type: 'enum', required: true, options: o('passport', 'drivers_license=Driver’s license', 'id_card=ID card', 'tax_number=Tax or social security number', 'other=Another ID'), hint: 'An ID card is a state or national ID. A tax or social security number is an SSN, National Insurance, SIN, TFN and the like.' },
      { key: 'otherKind', label: 'Which', ask: 'Which one?', type: 'enum', required: true, when: { part: 'kind', in: ['other'] }, options: o('residence_permit=Residence permit or green card', 'visa', 'work_permit=Work permit', 'known_traveler=Trusted traveler program', 'birth_certificate=Birth certificate', 'naturalization_certificate=Naturalization certificate', 'citizenship_certificate=Certificate of citizenship', 'consular_birth_report=Consular report of birth abroad', 'military_id=Military ID', 'voter_registration=Voter registration', 'other'), hint: 'A trusted traveler program is Global Entry, NEXUS, Registered Traveller and the like' },
      { key: 'number', label: 'Number', type: 'text', required: true, sensitivity: 'secret', labelBy: { part: 'kind', labels: { passport: 'Passport number', drivers_license: 'License number', id_card: 'ID number', tax_number: 'Tax or social security number' } } },
      { key: 'expires', label: 'Expires', type: 'date', more: false, when: { part: 'kind', in: ['passport', 'drivers_license', 'id_card', 'other'] }, hint: 'We’ll remind you before it runs out' },
      { key: 'issuer', label: 'Country', ask: 'Which country?', type: 'country', more: false, prefill: 'home_country' },
      { key: 'authority', label: 'State / region', type: 'text', more: false, when: [{ part: 'kind', in: ['drivers_license', 'id_card'] }, { part: 'otherKind', in: ['birth_certificate', 'voter_registration', 'other'] }], labelBy: { part: 'kind', labels: { other: 'Issued by' } }, hint: 'If it was issued by a state, province or region' },
      { key: 'class', label: 'Class', type: 'text', when: [{ part: 'kind', in: ['drivers_license'] }, { part: 'otherKind', in: ['visa'] }], labelBy: { part: 'kind', labels: { drivers_license: 'License class', other: 'Visa type' } }, hint: 'e.g. B, or work, student' },
      { key: 'issued', label: 'Issued', type: 'date', more: true },
      { key: 'nameOnDocument', label: 'Name as printed', type: 'text', more: true, hint: 'If it differs from your legal name' },
    ],
  },
  {
    // Citizen, non-citizen national and residency statuses are different legal facts and are never shown as one.
    id: 'citizenship', label: 'Citizenship & residency status', noun: 'status', group: 'identity', sensitivity: 'sensitive', dated: true, publicable: false, documents: 'certificate',
    description: 'Citizenships, nationalities and immigration statuses you hold or held, each pointing to the document that proves it.',
    title: '{status} · {country}',
    parts: [
      { key: 'country', label: 'Country', type: 'country', required: true },
      { key: 'status', label: 'Status', type: 'enum', required: true, options: o('citizen', 'noncitizen_national=Non-citizen national', 'permanent_resident=Permanent resident', 'temporary_resident=Temporary resident', 'visa_holder=Visa holder', 'visitor=Visitor (visa-exempt)', 'refugee', 'asylee', 'other') },
      // How you got it is a question about citizenship and nationality only; a visa or a stay has no such story.
      { key: 'acquiredBy', label: 'How you got this status', type: 'enum', options: o('birth', 'descent', 'naturalization', 'marriage', 'investment', 'other'),
        when: { part: 'status', in: ['citizen', 'noncitizen_national'] }, labelBy: { part: 'status', labels: { citizen: 'How you became a citizen' } } },
      { key: 'provenBy', label: 'Proven by', type: 'record', to: ['ids'], many: true, hint: 'The passport, certificate or permit' },
      { key: 'endedBy', label: 'How it ended', type: 'enum', more: true, options: o('renounced', 'revoked', 'expired', 'superseded=Replaced by another status') },
    ],
    companions: [{ domain: 'ids', label: 'The passport, certificate or permit that proves it' }],
  },
  {
    // The one contact-method shape, shared with every party (methods.ts checks and normalises the value).
    id: 'contact_methods', label: 'Contact methods', noun: 'contact method', group: 'identity', sensitivity: 'standard', dated: true, publicable: true,
    sensitivityBy: { part: 'kind', values: { phone: 'sensitive', postal: 'sensitive', messaging: 'sensitive' } },
    description: 'Emails, phones, mailing addresses, websites, social and messaging. Your main email and phone appear in your profile.',
    title: '{label} {kind}: {value}',
    parts: [
      { key: 'kind', label: 'Kind', type: 'enum', required: true, options: o('email', 'phone', 'postal=Mailing address', 'website', 'social', 'messaging') },
      { key: 'value', label: 'Value', type: 'text', required: true, when: { part: 'kind', in: ['email', 'phone', 'website', 'social', 'messaging'] },
        labelBy: { part: 'kind', labels: { email: 'Email address', phone: 'Phone number', website: 'Web address', social: 'Username or handle', messaging: 'Username or number' } } },
      // A mailing address is only for mail that goes somewhere other than home (a PO box, work). Home lives in Residences.
      { key: 'address', label: 'Mailing address', type: 'address', required: true, when: { part: 'kind', in: ['postal'] }, hint: 'Only if mail goes somewhere other than your home' },
      { key: 'service', label: 'Service', type: 'text', required: true, when: { part: 'kind', in: ['social', 'messaging'] }, suggestions: ['Instagram', 'LinkedIn', 'Facebook', 'TikTok', 'X', 'WhatsApp', 'Signal', 'Telegram'] },
      { key: 'label', label: 'Label', type: 'text', suggestions: ['Personal', 'Work', 'Mobile', 'Home'] },
      { key: 'primary', label: 'Main one', type: 'boolean' },
    ],
  },
  // ── life ─────────────────────────────────────────────────────────────
  {
    // City and country are standard (your profile's "Lives in"); the street address is sensitive.
    id: 'residences', label: 'Residences', noun: 'residence', group: 'life', sensitivity: 'standard', dated: true, publicable: false, documents: 'lease',
    description: 'Where you live and have lived. Your primary current one is "Lives in" on your profile.',
    title: '{street1}, {city}',
    parts: [
      ...ADDRESS,
      { key: 'primary', label: 'Primary home', type: 'boolean', hint: 'When you have more than one home at a time' },
      { key: 'ownership', label: 'Ownership', type: 'enum', sensitivity: 'sensitive', options: o('own', 'rent', 'family=With family', 'employer=Employer-provided', 'military', 'other') },
      { key: 'landlord', label: 'Landlord / property manager', type: 'party', sensitivity: 'sensitive' },
    ],
  },
  {
    // Each entry is a relationship between you and a party. Their name, phone, email and birthday live on the party.
    id: 'relationships', label: 'Relationships', noun: 'relationship', group: 'life', sensitivity: 'sensitive', dated: true, publicable: false, livesOn: 'party',
    description: 'Family, partners and the people you work with: spouse, children, parents, references, mentors. Each points to the person.',
    title: '{party} ({relation})',
    parts: [
      { key: 'party', label: 'Who', type: 'party', required: true },
      { key: 'relation', label: 'Relation', type: 'enum', required: true, options: o('spouse', 'civil_union=Civil union partner', 'domestic_partner=Domestic partner', 'partner=Partner', 'child', 'parent', 'sibling', 'grandparent', 'grandchild', 'guardian', 'other_family=Other family', 'friend', 'reference', 'colleague', 'manager', 'mentor', 'other') },
      { key: 'legallySeparated', label: 'Legally separated', type: 'boolean', when: { part: 'relation', in: ['spouse', 'civil_union'] } },
      { key: 'endedBy', label: 'How it ended', type: 'enum', options: o('divorce', 'death', 'annulment', 'separation', 'other'), hint: 'When it has an end date' },
      { key: 'job', label: 'Where you worked together', type: 'record', to: ['employment'], when: { part: 'relation', in: ['reference', 'colleague', 'manager', 'mentor'] } },
      { key: 'emergencyContact', label: 'Emergency contact', type: 'boolean' },
    ],
  },
  {
    id: 'pets', label: 'Pets', noun: 'pet', group: 'life', sensitivity: 'standard', dated: true, publicable: false,
    description: 'Animals in your care, their vet and microchip.',
    title: '{name} ({species})',
    parts: [
      { key: 'name', label: 'Name', type: 'text', required: true },
      { key: 'species', label: 'Species', type: 'text', required: true },
      { key: 'breed', label: 'Breed', type: 'text' },
      { key: 'birthDate', label: 'Born', type: 'date' },
      { key: 'microchip', label: 'Microchip number', type: 'text', sensitivity: 'sensitive' },
      { key: 'vet', label: 'Vet', type: 'party' },
    ],
  },
  {
    id: 'travel', label: 'Travel', noun: 'trip', group: 'life', sensitivity: 'sensitive', dated: true, publicable: false,
    description: 'Trips near and far, and when. Citizenship, visa and clearance forms ask for trips abroad.',
    title: '{city} · {country} · {purpose}',
    parts: [
      { key: 'country', label: 'Country', type: 'country', required: true },
      { key: 'city', label: 'City', type: 'text' },
      { key: 'region', label: 'State / region', type: 'text' },
      { key: 'purpose', label: 'Purpose', type: 'enum', options: o('leisure', 'business', 'family', 'study', 'medical', 'transit', 'other') },
    ],
  },
  {
    // The owner's own calendar. Times are datetimes with their zone; an all-day event ends on its last day.
    // Repeats are iCalendar rules (RFC 5545), so calendars import and export exactly.
    id: 'events', label: 'Events', noun: 'event', group: 'life', sensitivity: 'sensitive', dated: false, publicable: false, livesOn: 'calendar', sortBy: 'start',
    description: 'Appointments, plans and anything with a date and time. They show on your calendar beside the dates your data already holds.',
    title: '{title}',
    parts: [
      { key: 'title', label: 'What', type: 'text', required: true },
      { key: 'start', label: 'Starts', type: 'datetime', required: true },
      { key: 'end', label: 'Ends', type: 'datetime', hint: 'For an all-day event, its last day' },
      { key: 'allDay', label: 'All day', type: 'boolean' },
      { key: 'location', label: 'Where', type: 'text' },
      { key: 'repeat', label: 'Repeats', type: 'repeat' },
    ],
  },
  {
    // A task for you, or one you ask of someone. Asked of a connected Little Dipper, it travels as a message: they
    // accept or say not now, and tell you when it's done. The system parts are that conversation's state.
    id: 'tasks', oneAtATime: true, label: 'Tasks', noun: 'task', group: 'life', sensitivity: 'sensitive', dated: false, publicable: false, livesOn: 'actions', sortBy: 'due',
    description: 'Things to do: yours, and ones you ask of people you’re connected with.',
    title: '{title}',
    parts: [
      { key: 'title', label: 'What', type: 'text', required: true },
      { key: 'due', label: 'When', type: 'date' },
      { key: 'who', label: 'For', type: 'party', hint: 'Someone else doing it. If they’re on Little Dipper, they’re asked.' },
      { key: 'done', label: 'Done', type: 'boolean' },
      { key: 'doneAt', label: 'Done on', type: 'date', system: true },
      { key: 'from', label: 'Asked by', type: 'party', system: true },
      { key: 'answer', label: 'Their answer', type: 'enum', options: o('asked', 'accepted', 'not_now=Not now'), system: true },
      { key: 'ref', label: 'Their task', type: 'text', system: true },
    ],
  },
  // ── work ─────────────────────────────────────────────────────────────
  {
    id: 'employment', label: 'Employment', noun: 'job', group: 'work', sensitivity: 'sensitive', dated: true, publicable: true, documents: 'contract',
    description: 'Current and past employers, roles, supervisors and pay.',
    title: '{title} at {employer}',
    parts: [
      { key: 'employer', label: 'Employer', type: 'party', expects: 'organisation', required: true },
      { key: 'title', label: 'Job title', type: 'text', required: true },
      { key: 'department', label: 'Department', type: 'text' },
      { key: 'type', label: 'Type', type: 'enum', options: o('full_time=Full-time', 'part_time=Part-time', 'contract', 'self_employed=Self-employed', 'internship', 'volunteer', 'seasonal', 'other') },
      { key: 'arrangement', label: 'Where you work', type: 'enum', options: o('onsite=On-site', 'hybrid', 'remote') },
      { key: 'location', label: 'Work location', type: 'address', hint: 'The site you worked at, which can differ from head office' },
      { key: 'supervisor', label: 'Supervisor', type: 'party' },
      { key: 'mayContact', label: 'Employer may be contacted', type: 'boolean' },
      { key: 'employeeId', label: 'Employee ID', type: 'text', sensitivity: 'secret' },
      { key: 'startingPay', label: 'Starting pay', type: 'money', periodic: true, sensitivity: 'secret' },
      { key: 'currentPay', label: 'Current or final pay', type: 'money', periodic: true, sensitivity: 'secret' },
      { key: 'endedHow', label: 'How it ended', type: 'enum', options: o('resigned', 'laid_off=Laid off', 'contract_ended=Contract ended', 'terminated', 'retired', 'other') },
      { key: 'reasonForLeaving', label: 'Reason for leaving', type: 'text' },
      { key: 'description', label: 'What you did', type: 'longtext' },
    ],
    companions: [{ document: 'contract', label: 'Your contract or offer letter' }, { domain: 'relationships', label: 'A reference from this job' }],
  },
  {
    id: 'education', label: 'Education', noun: 'school', group: 'work', sensitivity: 'standard', dated: true, publicable: true, documents: 'certificate',
    description: 'Schools, degrees and fields of study.',
    title: '{degree} · {institution}',
    parts: [
      { key: 'institution', label: 'School', type: 'party', expects: 'organisation', required: true },
      { key: 'level', label: 'Level', type: 'enum', options: o('high_school=High school', 'vocational', 'associate', 'bachelor', 'master', 'doctorate', 'professional', 'certificate=Certificate programme', 'other') },
      { key: 'degree', label: 'Degree / diploma', type: 'text' },
      { key: 'field', label: 'Field of study', type: 'text' },
      { key: 'outcome', label: 'Outcome', type: 'enum', options: o('graduated', 'attending', 'withdrew') },
      { key: 'conferredOn', label: 'Conferred on', type: 'date', when: { part: 'outcome', in: ['graduated'] }, hint: 'The date on the diploma' },
      { key: 'gpa', label: 'GPA', type: 'text', sensitivity: 'sensitive', hint: 'As written, e.g. 3.8/4.0' },
      { key: 'honors', label: 'Honors', type: 'text', hint: 'cum laude…' },
      { key: 'campus', label: 'Campus', type: 'address' },
      { key: 'studentId', label: 'Student ID', type: 'text', sensitivity: 'secret' },
    ],
    companions: [{ document: 'certificate', label: 'Your diploma or transcript' }],
  },
  {
    id: 'credentials', label: 'Licenses & certifications', noun: 'credential', group: 'work', sensitivity: 'standard', dated: false, publicable: true, documents: 'certificate',
    sensitivityBy: { part: 'kind', values: { clearance: 'sensitive' } },
    description: 'Professional licenses, certifications (PMP, CPA…) and security clearances, with numbers and expiry dates.',
    title: '{name} · {issuer}',
    parts: [
      { key: 'kind', label: 'Kind', type: 'enum', options: o('license', 'certification', 'clearance=Security clearance', 'other') },
      { key: 'name', label: 'Name', type: 'text', required: true },
      { key: 'issuer', label: 'Issued by', type: 'party', expects: 'organisation', required: true },
      { key: 'number', label: 'Number', type: 'text', sensitivity: 'sensitive' },
      { key: 'region', label: 'Where it’s valid', type: 'region' },
      { key: 'issued', label: 'Issued', type: 'date' },
      { key: 'expires', label: 'Expires', type: 'date', remind: true },
      { key: 'url', label: 'Verification link', type: 'url', hint: 'Where anyone can check it' },
    ],
  },
  // ── health ───────────────────────────────────────────────────────────
  // Shaped after the FHIR health-records standard, so patient-portal imports map exactly. Little Dipper records who
  // says what (you, a doctor, a naturopath…) and never ranks one practice over another.
  {
    id: 'allergies', label: 'Allergies', noun: 'allergy', group: 'health', sensitivity: 'sensitive', confirmShare: true, dated: true, publicable: false, documents: 'medical',
    description: 'What you react to, how and how badly.',
    title: '{substance}',
    parts: [
      { key: 'substance', label: 'Substance', type: 'text', required: true },
      { key: 'reaction', label: 'Reaction', type: 'text' },
      { key: 'severity', label: 'Severity', type: 'enum', options: o('mild', 'moderate', 'severe', 'life_threatening=Life-threatening') },
      { key: 'accordingTo', label: 'According to', type: 'party', hint: 'Leave empty if it’s your own observation' },
    ],
  },
  {
    id: 'conditions', label: 'Conditions', noun: 'condition', group: 'health', sensitivity: 'sensitive', confirmShare: true, dated: true, publicable: false, documents: 'medical',
    description: 'Health conditions, from a hunch you’re exploring to a confirmed diagnosis, and who says so.',
    title: '{name} ({status})',
    parts: [
      { key: 'name', label: 'Condition', type: 'text', required: true },
      { key: 'status', label: 'Status', type: 'enum', required: true, options: o('suspected', 'provisional', 'confirmed', 'ruled_out=Ruled out', 'resolved') },
      { key: 'accordingTo', label: 'According to', type: 'party', hint: 'Who says so. Leave empty if it’s your own hypothesis' },
      { key: 'diagnosed', label: 'Diagnosed', type: 'date', when: { part: 'status', in: ['provisional', 'confirmed', 'resolved'] } },
    ],
  },
  {
    id: 'medications', label: 'Medications & supplements', noun: 'medication', group: 'health', sensitivity: 'sensitive', confirmShare: true, dated: true, publicable: false, documents: 'medical',
    description: 'Prescriptions, over-the-counter medicines, supplements, herbal and homeopathic remedies.',
    title: '{name} {dose}',
    parts: [
      { key: 'name', label: 'Name', type: 'text', required: true },
      { key: 'kind', label: 'Kind', type: 'enum', options: o('prescription', 'over_the_counter=Over the counter', 'supplement', 'herbal', 'homeopathic', 'other') },
      { key: 'dose', label: 'Dose', type: 'text', hint: 'e.g. 500 mg' },
      { key: 'frequency', label: 'How often', type: 'text', hint: 'e.g. twice a day' },
      { key: 'reason', label: 'What it’s for', type: 'text' },
      { key: 'prescriber', label: 'Prescribed or recommended by', type: 'party' },
    ],
  },
  {
    id: 'immunizations', label: 'Immunizations', noun: 'immunization', group: 'health', sensitivity: 'sensitive', confirmShare: true, dated: false, publicable: false, sortBy: 'date', documents: 'medical',
    description: 'Vaccines, with dates and lots. Schools, employers and travel ask for these.',
    title: '{vaccine}',
    parts: [
      { key: 'vaccine', label: 'Vaccine', type: 'text', required: true },
      { key: 'date', label: 'Date', type: 'date', required: true },
      { key: 'doseNumber', label: 'Dose number', type: 'number' },
      { key: 'lot', label: 'Lot', type: 'text' },
      { key: 'givenBy', label: 'Given by', type: 'party' },
    ],
  },
  {
    id: 'treatments', label: 'Treatments', noun: 'treatment', group: 'health', sensitivity: 'sensitive', confirmShare: true, dated: true, publicable: false, documents: 'medical',
    description: 'Surgeries, procedures and therapies of every kind: physical therapy, acupuncture, chiropractic, massage, talk therapy.',
    title: '{name}',
    parts: [
      { key: 'name', label: 'Treatment', type: 'text', required: true },
      { key: 'kind', label: 'Kind', type: 'enum', options: o('surgery', 'procedure', 'physical_therapy=Physical therapy', 'acupuncture', 'chiropractic', 'massage', 'talk_therapy=Talk therapy', 'other') },
      { key: 'by', label: 'By', type: 'party' },
      { key: 'condition', label: 'What it’s for', type: 'record', to: ['conditions'], hint: 'The condition it treats, if you keep one' },
    ],
  },
  {
    // Readings and results over time: what doctors ask for with blood pressure, diabetes, a child's growth.
    id: 'measurements', label: 'Measurements & lab results', noun: 'measurement', group: 'health', sensitivity: 'sensitive', confirmShare: true, dated: false, publicable: false, sortBy: 'at', documents: 'medical',
    description: 'Blood pressure, blood sugar, weight and lab results over time, with who measured them.',
    title: '{what}: {value} {unit}',
    parts: [
      { key: 'what', label: 'What was measured', type: 'text', required: true, hint: 'Blood pressure, A1C, weight, cholesterol, temperature…' },
      { key: 'value', label: 'Result', type: 'text', required: true, hint: 'A number or a reading, like 128/82' },
      { key: 'unit', label: 'Unit', type: 'text', hint: 'mmHg, %, lb, mg/dL…' },
      { key: 'at', label: 'When', type: 'datetime', required: true },
      { key: 'kind', label: 'Kind', type: 'enum', options: o('home=Home reading', 'lab=Lab result', 'visit=Taken at a visit', 'device=From a device or app') },
      { key: 'by', label: 'Measured by', type: 'party', hint: 'The lab, clinic or device maker' },
      { key: 'range', label: 'Normal range', type: 'text', hint: 'As printed on the lab report' },
      { key: 'relatedTo', label: 'Related to', type: 'record', to: ['conditions', 'medications'], many: true },
    ],
  },
  {
    id: 'health_basics', label: 'Health basics', noun: 'health basics', group: 'health', sensitivity: 'sensitive', confirmShare: true, dated: false, publicable: false, single: true,
    // What a doctor or paramedic needs in a hurry. Allergies, medications, conditions and emergency contacts aren't
    // repeated here: the page shows them from where they live.
    description: 'What a doctor or paramedic needs to know about you in an emergency.',
    title: 'Health basics',
    parts: [
      { key: 'bloodType', label: 'Blood type', type: 'enum', options: o('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', 'unknown=Don’t know') },
      { key: 'organDonor', label: 'Organ donor', type: 'boolean' },
      { key: 'doctor', label: 'Primary doctor', type: 'party' },
      { key: 'pharmacy', label: 'Pharmacy', type: 'party', expects: 'organisation' },
      { key: 'hospital', label: 'Preferred hospital', type: 'party', expects: 'organisation' },
      { key: 'devices', label: 'Implants and devices', type: 'text', hint: 'Pacemaker, insulin pump, metal pins… ERs and MRI need to know' },
      { key: 'directive', label: 'Advance directive or DNR', type: 'record', to: ['legal'], hint: 'Point to it in Legal documents' },
      { key: 'careWishes', label: 'Care wishes', type: 'longtext', hint: 'e.g. no blood transfusions, needs a Spanish interpreter' },
    ],
  },
  // ── money ────────────────────────────────────────────────────────────
  {
    id: 'insurance', label: 'Insurance', noun: 'policy', group: 'money', sensitivity: 'sensitive', dated: true, publicable: false, documents: 'insurance_card',
    description: 'Health, auto, home, life and every other policy, with who and what it covers.',
    title: '{kind} · {insurer}',
    parts: [
      { key: 'kind', label: 'Kind', type: 'enum', required: true, options: o('health', 'dental', 'vision', 'auto', 'home', 'renters', 'life', 'disability', 'travel', 'pet', 'umbrella', 'other') },
      { key: 'insurer', label: 'Insurer', type: 'party', expects: 'organisation', required: true },
      { key: 'policyNumber', label: 'Policy number', type: 'text', sensitivity: 'secret' },
      { key: 'memberId', label: 'Your member ID', type: 'text', sensitivity: 'secret' },
      { key: 'groupNumber', label: 'Group number', type: 'text', sensitivity: 'secret' },
      { key: 'premium', label: 'Premium', type: 'money', periodic: true },
      { key: 'coverage', label: 'Coverage', type: 'text' },
      { key: 'coversPeople', label: 'People covered', type: 'party', many: true },
      { key: 'coversThings', label: 'What it covers', type: 'record', to: ['vehicles', 'real_estate', 'valuables', 'residences', 'pets'], many: true },
      { key: 'agent', label: 'Agent', type: 'party' },
    ],
    companions: [{ domain: 'vehicles', label: 'The car it covers', when: { part: 'kind', in: ['auto'] } }, { domain: 'real_estate', label: 'The home it covers', when: { part: 'kind', in: ['home'] } }],
  },
  {
    id: 'financial_accounts', label: 'Financial accounts', noun: 'account', group: 'money', sensitivity: 'sensitive', confirmShare: true, dated: true, publicable: false, documents: 'statement',
    description: 'Banks, cards, investments, retirement and loans, with their status over time.',
    title: '{institution} {kind}',
    parts: [
      { key: 'kind', label: 'Kind', type: 'enum', required: true, options: o('checking', 'savings', 'credit_card=Credit card', 'debit_card=Debit card', 'brokerage', 'retirement', 'hsa=HSA', 'loan', 'mortgage', 'crypto', 'other') },
      { key: 'institution', label: 'Institution', type: 'party', expects: 'organisation', required: true },
      { key: 'nickname', label: 'Nickname', type: 'text' },
      { key: 'number', label: 'Account or card number', type: 'text', sensitivity: 'secret' },
      { key: 'routingNumber', label: 'Routing number', type: 'text', when: { part: 'kind', in: ['checking', 'savings'] }, hint: 'Identifies the bank; printed on cheques' },
      { key: 'account', label: 'Card for account', type: 'record', to: ['financial_accounts'], when: { part: 'kind', in: ['debit_card'] } },
      { key: 'finances', label: 'What it pays for', type: 'record', to: ['vehicles', 'real_estate'], when: { part: 'kind', in: ['loan', 'mortgage'] } },
      { key: 'balance', label: 'Balance', type: 'money', sensitivity: 'secret' },
      { key: 'balanceAsOf', label: 'Balance as of', type: 'date' },
      { key: 'ownedWith', label: 'Owned with', type: 'party', many: true, hint: 'Anyone on the account with you' },
      { key: 'status', label: 'Status', type: 'enum', options: o('current', 'past_due=Past due', 'charged_off=Charged off', 'in_collections=In collections', 'settled', 'paid_in_full=Paid in full', 'closed') },
      { key: 'statusSince', label: 'Status since', type: 'date' },
      // A debt that went wrong: the details live on the account itself, not in a separate category.
      { key: 'firstDelinquency', label: 'Date of first delinquency', type: 'date', hint: 'Credit-report timelines run from this date', when: { part: 'status', in: ['past_due', 'charged_off', 'in_collections', 'settled'] } },
      { key: 'collector', label: 'Collector', type: 'party', expects: 'organisation', when: { part: 'status', in: ['in_collections'] } },
      { key: 'debtOwner', label: 'Who owns the debt now', type: 'party', expects: 'organisation', hint: 'Often a debt buyer, not the collector', when: { part: 'status', in: ['in_collections'] } },
      { key: 'collectorReference', label: 'Their reference number', type: 'text', sensitivity: 'sensitive', when: { part: 'status', in: ['in_collections'] } },
      { key: 'claimed', label: 'Amount they claim', type: 'money', when: { part: 'status', in: ['in_collections'] } },
      { key: 'claimedAsOf', label: 'Claimed as of', type: 'date', when: { part: 'status', in: ['in_collections'] } },
      { key: 'dispute', label: 'Where it stands', type: 'enum', options: o('open', 'validation_requested=Validation requested', 'disputed', 'payment_plan=Payment plan'), when: { part: 'status', in: ['in_collections'] } },
      { key: 'judgment', label: 'Court judgment', type: 'record', to: ['legal'], when: { part: 'status', in: ['in_collections'] } },
    ],
  },
  {
    // Every movement of money, one row each: the plain record of what happened. Income and Receipts stay as they are;
    // a transaction can point to its income entry or receipt instead of repeating their details. No balances.
    id: 'transactions', label: 'Transactions', noun: 'transaction', group: 'money', sensitivity: 'sensitive', confirmShare: true, dated: false, publicable: false, sortBy: 'date', documents: 'statement',
    description: 'Every payment in or out, with who it was with, how and why. The full story of your money, one line at a time.',
    title: '{counterparty} · {amount}',
    parts: [
      { key: 'date', label: 'Date', type: 'date', required: true },
      { key: 'direction', label: 'Money in or out', type: 'enum', required: true, options: o('out=Money out', 'in=Money in', 'transfer=Moved between your own accounts') },
      { key: 'amount', label: 'Amount', type: 'money', required: true },
      { key: 'counterparty', label: 'With', type: 'party', required: true, hint: 'Who you paid or who paid you', when: { part: 'direction', in: ['in', 'out'] } },
      { key: 'category', label: 'What for', type: 'enum', options: o(
        'income=Income', 'housing=Rent or mortgage', 'utilities=Utilities and phone', 'groceries', 'dining=Eating out', 'transport=Transport and fuel', 'health=Health and medicine',
        'insurance', 'debt=Debt or loan payment', 'childcare=Childcare and school', 'education', 'shopping', 'personal=Personal care', 'entertainment', 'travel',
        'gifts=Gifts and donations', 'family=Money to or from family', 'savings=Savings and investing', 'fees=Fees and interest', 'taxes', 'refund=Refund', 'cash=Cash withdrawal or deposit', 'other') },
      { key: 'account', label: 'Account', type: 'record', to: ['financial_accounts'], hint: 'The account or card it went through' },
      { key: 'toAccount', label: 'Into account', type: 'record', to: ['financial_accounts'], when: { part: 'direction', in: ['transfer'] } },
      { key: 'method', label: 'How', type: 'enum', options: o('card', 'bank_transfer=Bank transfer', 'direct_deposit=Direct deposit', 'check', 'cash', 'app=Payment app (Venmo, Cash App…)', 'benefits_card=Benefits card (EBT…)', 'autopay=Automatic payment', 'other') },
      { key: 'description', label: 'Description', type: 'text', hint: 'As it reads on your statement' },
      { key: 'reference', label: 'Reference or check number', type: 'text' },
      { key: 'entry', label: 'Details in', type: 'record', to: ['income', 'receipts', 'insurance', 'vehicles', 'real_estate', 'residences'], hint: 'The income entry, receipt or bill this payment is' },
    ],
  },
  {
    // Money that actually reached you, one entry per payment (a paycheck, a payout, rent) or per period (a W-2's year).
    // Your rate of pay is on the job. Amounts are sensitive, not secret, so the page can total them.
    id: 'income', label: 'Income', noun: 'payment', group: 'money', sensitivity: 'sensitive', confirmShare: true, dated: false, publicable: false, sortBy: 'received', documents: 'pay_stub',
    description: 'Money you received: paychecks, payouts, rent, benefits. One entry per payment, or one for a whole year.',
    title: '{payer} · {amount}',
    parts: [
      { key: 'received', label: 'Received on', type: 'date', required: true },
      { key: 'amount', label: 'Amount received', type: 'money', required: true, hint: 'What reached you, after tax and fees' },
      // Grouped by where money comes from, because taxes, budgets, benefit applications and building wealth all
      // ask the same question. Cash work, help from family and benefits are first-class: forms ask about them too.
      { key: 'kind', label: 'Kind', type: 'enum', required: true, options: o(
        'wages=Work · Wages or salary', 'bonus=Work · Bonus or commission', 'overtime=Work · Overtime', 'tips=Work · Tips', 'cash_work=Work · Cash job or day labor',
        'self_employment=Business · Self-employment or freelance', 'gig=Business · Gig or app work (Uber, DoorDash, Etsy…)', 'business=Business · Business profits or distributions', 'sales=Business · Selling things you own',
        'interest=Investments · Interest', 'dividends=Investments · Dividends', 'capital_gains=Investments · Capital gains', 'crypto=Investments · Crypto', 'rental=Investments · Rent from a property or room', 'royalties=Investments · Royalties',
        'pension=Retirement · Pension or annuity', 'retirement_withdrawal=Retirement · Withdrawal (401(k), IRA…)', 'social_security=Retirement · Social Security',
        'unemployment=Benefits · Unemployment', 'disability=Benefits · Disability (SSI, SSDI…)', 'food_assistance=Benefits · Food assistance (SNAP, WIC…)', 'cash_assistance=Benefits · Cash assistance (TANF…)', 'tax_credit=Benefits · Tax credit or refund', 'benefits=Benefits · Other government help',
        'child_support=Family · Child support', 'alimony=Family · Alimony or spousal support', 'family_help=Family · Help from family or friends',
        'gift=Other · Gift or inheritance', 'prize=Other · Prize, settlement or winnings', 'scholarship=Other · Scholarship or grant', 'other=Other') },
      { key: 'payer', label: 'Paid by', type: 'party', required: true, hint: 'Who paid you: an employer, a client, an app, an agency, a person' },
      { key: 'taxForm', label: 'Reported on', type: 'enum', hint: 'The tax form this shows up on, if any (US forms for now)', options: o('w2=W-2', 'nec=1099-NEC', 'k=1099-K', 'misc=1099-MISC', 'int=1099-INT', 'div=1099-DIV', 'b=1099-B', 'r=1099-R', 'g=1099-G', 'ssa=SSA-1099', 'k1=Schedule K-1', 'other=Another form', 'none=No form') },
      { key: 'how', label: 'How it was paid', type: 'enum', options: o('direct_deposit=Direct deposit', 'check=Check', 'cash', 'app=Payment app (Venmo, Cash App…)', 'card=Benefits card (EBT…)', 'other') },
      { key: 'gross', label: 'Gross amount', type: 'money', hint: 'Before tax and fees, if the pay stub or statement shows it' },
      { key: 'periodStart', label: 'Covers from', type: 'date', hint: 'A paycheck covers a pay period; a W-2 the whole year' },
      { key: 'periodEnd', label: 'Covers to', type: 'date' },
      { key: 'source', label: 'From', type: 'record', to: ['employment', 'real_estate', 'valuables', 'financial_accounts'], hint: 'The job, rental, copyright or account it came from' },
      { key: 'paidInto', label: 'Paid into', type: 'record', to: ['financial_accounts'] },
    ],
  },
  {
    id: 'tax_returns', label: 'Tax returns', noun: 'return', group: 'money', sensitivity: 'sensitive', confirmShare: true, dated: false, publicable: false, sortBy: 'year', documents: 'tax_form',
    description: 'One entry per filing: year, jurisdiction, status and the numbers forms ask for.',
    title: '{year} {jurisdiction} return',
    parts: [
      { key: 'year', label: 'Tax year', type: 'number', required: true },
      { key: 'jurisdiction', label: 'Jurisdiction', type: 'region', required: true, hint: 'US for federal, US-OR for Oregon…' },
      { key: 'filingStatus', label: 'Filing status', type: 'enum', hint: 'US statuses; other countries say “other” and explain in notes', options: o('single', 'married_joint=Married filing jointly', 'married_separate=Married filing separately', 'head_of_household=Head of household', 'qualifying_surviving_spouse=Qualifying surviving spouse', 'other') },
      { key: 'dependents', label: 'Dependents claimed', type: 'party', many: true },
      { key: 'agi', label: 'Adjusted gross income', type: 'money', sensitivity: 'secret' },
      { key: 'taxPaid', label: 'Total tax', type: 'money', sensitivity: 'secret' },
      { key: 'refund', label: 'Refund (or amount owed, negative)', type: 'money', sensitivity: 'secret' },
      { key: 'preparer', label: 'Preparer', type: 'party' },
    ],
  },
  {
    id: 'legal', label: 'Legal documents', noun: 'document', group: 'money', sensitivity: 'sensitive', confirmShare: true, dated: true, publicable: false, documents: 'contract',
    // Documents that give someone authority or decide who gets what. Deeds, titles and leases are documents on the home, car or property they prove.
    description: 'Wills, powers of attorney, healthcare directives, trusts and court orders: the people they name and where the originals are.',
    title: '{kind} · {title}',
    parts: [
      { key: 'kind', label: 'Kind', type: 'enum', required: true, options: o('will', 'power_of_attorney=Power of attorney', 'healthcare_proxy=Healthcare proxy', 'advance_directive=Advance directive / living will', 'trust', 'beneficiary=Beneficiary designation', 'prenup=Prenuptial agreement', 'court_order=Court order', 'other') },
      { key: 'title', label: 'Title', type: 'text', hint: 'Only if you need to tell two apart, like “2024 update”' },
      { key: 'attorney', label: 'Attorney', type: 'party' },
      { key: 'executors', label: 'Executors', type: 'party', many: true, when: { part: 'kind', in: ['will'] } },
      { key: 'beneficiaries', label: 'Beneficiaries', type: 'party', many: true, when: { part: 'kind', in: ['will', 'trust', 'beneficiary'] } },
      { key: 'agents', label: 'Agents', type: 'party', many: true, when: { part: 'kind', in: ['power_of_attorney', 'healthcare_proxy', 'advance_directive'] } },
      { key: 'trustees', label: 'Trustees', type: 'party', many: true, when: { part: 'kind', in: ['trust'] } },
      { key: 'guardians', label: 'Guardians', type: 'party', many: true, when: { part: 'kind', in: ['will'] } },
      { key: 'originalLocation', label: 'Where the original is', type: 'text', sensitivity: 'secret' },
      { key: 'witnesses', label: 'Witnesses', type: 'party', many: true },
    ],
  },
  {
    // Nothing required: a photo alone is a receipt worth keeping, and the details can come later (by hand or an assistant).
    // Subtotal, tax and total are kept as printed: with discounts, tips and fees they don't always add up, and the receipt is the fact.
    id: 'receipts', label: 'Receipts', noun: 'receipt', group: 'money', sensitivity: 'sensitive', dated: false, publicable: false, sortBy: 'purchased', documents: 'receipt',
    description: 'What you bought, where, when and for how much, with the photo or PDF. For taxes, returns, warranties and buying again.',
    title: '{merchant} · {total}',
    parts: [
      { key: 'merchant', label: 'Merchant', type: 'party', expects: 'organisation' },
      { key: 'purchased', label: 'Purchase date', type: 'date' },
      { key: 'total', label: 'Total', type: 'money' },
      { key: 'category', label: 'Category', type: 'enum', options: o('groceries', 'dining', 'household', 'clothing', 'electronics', 'health', 'transport', 'travel', 'home=Home & garden', 'entertainment', 'subscriptions', 'gifts', 'education', 'business', 'charity', 'other') },
      { key: 'items', label: 'Items', type: 'list', of: [
        { key: 'description', label: 'Item', type: 'text', required: true },
        { key: 'quantity', label: 'Qty', type: 'number' },
        { key: 'price', label: 'Price', type: 'money' },
        { key: 'sku', label: 'Product code', type: 'text' },
      ] },
      { key: 'subtotal', label: 'Subtotal', type: 'money' },
      { key: 'tax', label: 'Tax', type: 'money' },
      { key: 'paymentMethod', label: 'Paid by', type: 'enum', options: o('card', 'cash', 'bank_transfer=Bank transfer', 'mobile_wallet=Mobile wallet', 'crypto=Crypto / stablecoin', 'gift_card=Gift card', 'other') },
      { key: 'paidWith', label: 'Paid with', type: 'record', to: ['financial_accounts'], when: { part: 'paymentMethod', in: ['card', 'bank_transfer', 'mobile_wallet'] } },
      { key: 'orderNumber', label: 'Order or receipt number', type: 'text' },
      { key: 'returnBy', label: 'Return by', type: 'date', remind: true },
      { key: 'warrantyUntil', label: 'Warranty until', type: 'date', remind: true },
    ],
  },
  // ── things ───────────────────────────────────────────────────────────
  {
    id: 'vehicles', label: 'Vehicles', noun: 'vehicle', group: 'money', sensitivity: 'sensitive', dated: true, publicable: false, documents: 'registration',
    description: 'Cars, bikes and boats you own or owned.',
    title: '{year} {make} {model}',
    parts: [
      { key: 'kind', label: 'Kind', type: 'enum', options: o('car', 'motorcycle', 'truck', 'rv=RV', 'boat', 'bicycle', 'other') },
      { key: 'make', label: 'Make', type: 'text', required: true },
      { key: 'model', label: 'Model', type: 'text', required: true },
      { key: 'year', label: 'Year', type: 'number' },
      { key: 'color', label: 'Color', type: 'text' },
      { key: 'vin', label: 'VIN / hull number', type: 'text' },
      { key: 'plate', label: 'Plate', type: 'text' },
      { key: 'registeredIn', label: 'Registered in', type: 'region' },
      { key: 'registrationExpires', label: 'Registration expires', type: 'date', remind: true },
      { key: 'heldAs', label: 'Held as', type: 'enum', options: o('owned', 'financed', 'leased', 'company=Company car') },
      { key: 'ownedWith', label: 'Owned with', type: 'party', many: true, hint: 'Anyone else on the title' },
    ],
    companions: [
      { document: 'title', label: 'The title (proof you own it)' },
      { document: 'registration', label: 'The registration' },
      { domain: 'insurance', label: 'Is it insured?' },
      { domain: 'financial_accounts', label: 'The loan', when: { part: 'heldAs', in: ['financed'] } },
      { document: 'contract', label: 'The lease', when: { part: 'heldAs', in: ['leased'] } },
    ],
  },
  {
    // The biggest thing most people will ever own. Carries what verification (and, one day, tokenization) needs: the parcel,
    // how it's held, who owns what share. Bought and sold are the entry's dates. Living there is a Residence; this is owning it.
    id: 'real_estate', label: 'Real estate', noun: 'property', group: 'money', sensitivity: 'sensitive', dated: true, publicable: false, documents: 'deed',
    description: 'Homes, land and rentals you own: how it’s held, who with, what it’s worth and the papers that prove it.',
    title: '{name} · {address}',
    parts: [
      { key: 'kind', label: 'Kind', type: 'enum', options: o('house', 'condo=Condo or apartment', 'townhouse', 'mobile_home=Mobile or manufactured home', 'multi_family=Multi-family', 'land', 'commercial', 'other') },
      { key: 'use', label: 'Used as', type: 'enum', options: o('home=Your home', 'rental', 'vacation=Vacation place', 'investment=Held as an investment', 'other') },
      { key: 'address', label: 'Address', type: 'address', required: true },
      { key: 'name', label: 'Name', type: 'text', hint: 'Only if it helps, like “Lake cabin”' },
      { key: 'livesHere', label: 'Where you live', type: 'record', to: ['residences'], when: { part: 'use', in: ['home', 'vacation'] }, hint: 'If you live here, point to it in Residences' },
      { key: 'heldAs', label: 'How it’s held', type: 'enum', options: o('sole=Just you', 'joint', 'tenancy_in_common=Tenancy in common', 'trust', 'company') },
      { key: 'ownedWith', label: 'Owned with', type: 'party', many: true, hint: 'People, a trust or a company', when: { part: 'heldAs', in: ['joint', 'tenancy_in_common', 'trust', 'company'] } },
      { key: 'yourShare', label: 'Your share (%)', type: 'number', when: { part: 'heldAs', in: ['joint', 'tenancy_in_common', 'trust', 'company'] } },
      { key: 'parcelId', label: 'Parcel ID', type: 'text', hint: 'The official land identifier, e.g. the APN' },
      { key: 'purchasePrice', label: 'Purchase price', type: 'money' },
      { key: 'value', label: 'Value', type: 'money' },
      { key: 'valueAsOf', label: 'Value as of', type: 'date' },
      { key: 'valuedBy', label: 'Valued by', type: 'party', hint: 'An appraiser. Leave empty if it’s your own estimate' },
    ],
    companions: [
      { document: 'deed', label: 'The deed' },
      { domain: 'financial_accounts', label: 'The mortgage' },
      { domain: 'insurance', label: 'Is it insured?' },
      { document: 'statement', label: 'Property tax bills' },
      { domain: 'income', label: 'Rent you receive', when: { part: 'use', in: ['rental'] } },
    ],
  },
  {
    // Things worth keeping track of for insurance, an estate or a move. Photos are what an insurer asks for after a loss.
    id: 'valuables', label: 'Valuables', noun: 'item', group: 'money', sensitivity: 'sensitive', dated: true, publicable: false, documents: 'photo',
    description: 'Jewelry, art, instruments, electronics and collectibles: what they’re worth, where they’re kept and the photos and receipts that prove it.',
    title: '{name}',
    parts: [
      { key: 'kind', label: 'Kind', type: 'enum', options: o('jewelry', 'art', 'instrument', 'electronics', 'collectible', 'copyright=Copyright (a song, book, photo, software…)', 'other') },
      { key: 'name', label: 'Name', type: 'text', required: true },
      { key: 'keptAt', label: 'Kept at', type: 'record', to: ['residences'], when: { part: 'kind', in: ['jewelry', 'art', 'instrument', 'electronics', 'collectible', 'other'] } },
      { key: 'value', label: 'Value', type: 'money' },
      { key: 'valueAsOf', label: 'Value as of', type: 'date' },
      { key: 'serialNumber', label: 'Serial number', type: 'text', when: { part: 'kind', in: ['jewelry', 'art', 'instrument', 'electronics', 'collectible', 'other'] } },
      { key: 'ownedWith', label: 'Owned with', type: 'party', many: true },
      { key: 'purchasePrice', label: 'Purchase price', type: 'money' },
      { key: 'receipt', label: 'Receipt', type: 'record', to: ['receipts'], hint: 'Its warranty shows from the receipt' },
      { key: 'valuedBy', label: 'Valued by', type: 'party', hint: 'An appraiser. Leave empty if it’s your own estimate' },
    ],
    companions: [
      { domain: 'insurance', label: 'Is it insured?' },
      { domain: 'receipts', label: 'The receipt' },
    ],
  },
  {
    id: 'memberships', label: 'Memberships & loyalty', noun: 'membership', group: 'life', sensitivity: 'standard', dated: true, publicable: true, documents: 'card',
    sensitivityBy: { part: 'kind', values: { union: 'sensitive', religious: 'sensitive', political: 'sensitive' } },
    description: 'Frequent flyer, hotel and loyalty numbers, clubs, associations, unions and subscriptions.',
    title: '{organization}',
    parts: [
      { key: 'kind', label: 'Kind', type: 'enum', options: o('frequent_flyer=Frequent flyer', 'hotel', 'loyalty', 'club', 'association=Professional association', 'union', 'religious=Religious organisation', 'political=Political organisation', 'subscription', 'other') },
      { key: 'organization', label: 'Organization', type: 'party', expects: 'organisation', required: true },
      { key: 'memberNumber', label: 'Member number', type: 'text', sensitivity: 'sensitive' },
      { key: 'tier', label: 'Tier / status', type: 'text' },
      { key: 'cost', label: 'Cost', type: 'money', periodic: true },
      { key: 'renewsOn', label: 'Renews on', type: 'date', remind: true },
    ],
  },
  // ── also life: memberships and notes (Personal folded in, Nov 12) ─────
  {
    // Anything worth remembering, in your own words: the action bar's third kind of thing to add.
    id: 'notes', oneAtATime: true, label: 'Notes', noun: 'note', group: 'life', sensitivity: 'sensitive', dated: false, publicable: false, livesOn: 'menu',
    description: 'Anything you want to remember, in your own words.',
    title: '{text}',
    parts: [{ key: 'text', label: 'Note', type: 'longtext', required: true }],
  },
];

export const BUILT_IN_DOMAINS: DomainDef[] = DEFS.map((d) => ({ ...d, builtIn: true, schemaVersion: d.schemaVersion ?? 1 }));

/** Names domains may never use: they would read as API sections (/api/{name}). */
export const RESERVED = new Set([
  'node', 'auth', 'owner', 'contacts', 'parties', 'federation', 'public-profile', 'keys', 'audit', 'export', 'catalog', 'timeline', 'attention', 'records', 'files', 'documents', 'shares', 'copies', 'domains', 'messages',
]);
