/**
 * A first guess at the time zone of a place, so nobody has to know "America/Chicago". Country, then state or
 * province where a country has several zones. A state split between zones gets its main one; the owner can change it.
 * Unknown places give nothing, and the picker stays empty.
 */

const US: Record<string, string> = {
  AL: 'America/Chicago', AK: 'America/Anchorage', AZ: 'America/Phoenix', AR: 'America/Chicago', CA: 'America/Los_Angeles',
  CO: 'America/Denver', CT: 'America/New_York', DE: 'America/New_York', DC: 'America/New_York', FL: 'America/New_York',
  GA: 'America/New_York', HI: 'Pacific/Honolulu', ID: 'America/Boise', IL: 'America/Chicago', IN: 'America/Indiana/Indianapolis',
  IA: 'America/Chicago', KS: 'America/Chicago', KY: 'America/New_York', LA: 'America/Chicago', ME: 'America/New_York',
  MD: 'America/New_York', MA: 'America/New_York', MI: 'America/Detroit', MN: 'America/Chicago', MS: 'America/Chicago',
  MO: 'America/Chicago', MT: 'America/Denver', NE: 'America/Chicago', NV: 'America/Los_Angeles', NH: 'America/New_York',
  NJ: 'America/New_York', NM: 'America/Denver', NY: 'America/New_York', NC: 'America/New_York', ND: 'America/Chicago',
  OH: 'America/New_York', OK: 'America/Chicago', OR: 'America/Los_Angeles', PA: 'America/New_York', RI: 'America/New_York',
  SC: 'America/New_York', SD: 'America/Chicago', TN: 'America/Chicago', TX: 'America/Chicago', UT: 'America/Denver',
  VT: 'America/New_York', VA: 'America/New_York', WA: 'America/Los_Angeles', WV: 'America/New_York', WI: 'America/Chicago',
  WY: 'America/Denver', PR: 'America/Puerto_Rico', GU: 'Pacific/Guam', VI: 'America/St_Thomas',
};
const US_NAMES: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT', delaware: 'DE',
  'district of columbia': 'DC', 'washington dc': 'DC', 'washington d.c.': 'DC', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID',
  illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE',
  nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC',
  'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA',
  'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY', 'puerto rico': 'PR', guam: 'GU', 'virgin islands': 'VI',
};
const CA: Record<string, string> = {
  BC: 'America/Vancouver', 'british columbia': 'America/Vancouver', AB: 'America/Edmonton', alberta: 'America/Edmonton',
  SK: 'America/Regina', saskatchewan: 'America/Regina', MB: 'America/Winnipeg', manitoba: 'America/Winnipeg',
  ON: 'America/Toronto', ontario: 'America/Toronto', QC: 'America/Toronto', quebec: 'America/Toronto', québec: 'America/Toronto',
  NB: 'America/Moncton', 'new brunswick': 'America/Moncton', NS: 'America/Halifax', 'nova scotia': 'America/Halifax',
  PE: 'America/Halifax', 'prince edward island': 'America/Halifax', NL: 'America/St_Johns', newfoundland: 'America/St_Johns',
  'newfoundland and labrador': 'America/St_Johns', YT: 'America/Whitehorse', yukon: 'America/Whitehorse',
  NT: 'America/Yellowknife', 'northwest territories': 'America/Yellowknife', NU: 'America/Iqaluit', nunavut: 'America/Iqaluit',
};
const AU: Record<string, string> = {
  NSW: 'Australia/Sydney', 'new south wales': 'Australia/Sydney', ACT: 'Australia/Sydney', VIC: 'Australia/Melbourne', victoria: 'Australia/Melbourne',
  QLD: 'Australia/Brisbane', queensland: 'Australia/Brisbane', SA: 'Australia/Adelaide', 'south australia': 'Australia/Adelaide',
  WA: 'Australia/Perth', 'western australia': 'Australia/Perth', TAS: 'Australia/Hobart', tasmania: 'Australia/Hobart',
  NT: 'Australia/Darwin', 'northern territory': 'Australia/Darwin',
};

// Countries with one zone (or one that nearly everyone lives in).
const ONE: Record<string, string> = {
  gb: 'Europe/London', ie: 'Europe/Dublin', fr: 'Europe/Paris', de: 'Europe/Berlin', es: 'Europe/Madrid', pt: 'Europe/Lisbon',
  it: 'Europe/Rome', nl: 'Europe/Amsterdam', be: 'Europe/Brussels', lu: 'Europe/Luxembourg', ch: 'Europe/Zurich', at: 'Europe/Vienna',
  dk: 'Europe/Copenhagen', no: 'Europe/Oslo', se: 'Europe/Stockholm', fi: 'Europe/Helsinki', is: 'Atlantic/Reykjavik',
  pl: 'Europe/Warsaw', cz: 'Europe/Prague', sk: 'Europe/Bratislava', hu: 'Europe/Budapest', ro: 'Europe/Bucharest', bg: 'Europe/Sofia',
  gr: 'Europe/Athens', tr: 'Europe/Istanbul', ua: 'Europe/Kyiv', by: 'Europe/Minsk', lt: 'Europe/Vilnius', lv: 'Europe/Riga',
  ee: 'Europe/Tallinn', rs: 'Europe/Belgrade', hr: 'Europe/Zagreb', si: 'Europe/Ljubljana', ba: 'Europe/Sarajevo', al: 'Europe/Tirane',
  mk: 'Europe/Skopje', md: 'Europe/Chisinau', cy: 'Asia/Nicosia', mt: 'Europe/Malta', ge: 'Asia/Tbilisi', am: 'Asia/Yerevan',
  az: 'Asia/Baku', il: 'Asia/Jerusalem', ps: 'Asia/Gaza', lb: 'Asia/Beirut', jo: 'Asia/Amman', sy: 'Asia/Damascus', iq: 'Asia/Baghdad',
  ir: 'Asia/Tehran', sa: 'Asia/Riyadh', ae: 'Asia/Dubai', qa: 'Asia/Qatar', kw: 'Asia/Kuwait', bh: 'Asia/Bahrain', om: 'Asia/Muscat',
  ye: 'Asia/Aden', af: 'Asia/Kabul', pk: 'Asia/Karachi', in: 'Asia/Kolkata', np: 'Asia/Kathmandu', bd: 'Asia/Dhaka', lk: 'Asia/Colombo',
  mm: 'Asia/Yangon', th: 'Asia/Bangkok', vn: 'Asia/Ho_Chi_Minh', kh: 'Asia/Phnom_Penh', la: 'Asia/Vientiane', my: 'Asia/Kuala_Lumpur',
  sg: 'Asia/Singapore', ph: 'Asia/Manila', cn: 'Asia/Shanghai', hk: 'Asia/Hong_Kong', mo: 'Asia/Macau', tw: 'Asia/Taipei',
  kr: 'Asia/Seoul', kp: 'Asia/Pyongyang', jp: 'Asia/Tokyo', uz: 'Asia/Tashkent', tj: 'Asia/Dushanbe', kg: 'Asia/Bishkek',
  tm: 'Asia/Ashgabat', kz: 'Asia/Almaty', mn: 'Asia/Ulaanbaatar', id: 'Asia/Jakarta', nz: 'Pacific/Auckland', fj: 'Pacific/Fiji',
  eg: 'Africa/Cairo', ly: 'Africa/Tripoli', tn: 'Africa/Tunis', dz: 'Africa/Algiers', ma: 'Africa/Casablanca', sd: 'Africa/Khartoum',
  et: 'Africa/Addis_Ababa', er: 'Africa/Asmara', so: 'Africa/Mogadishu', ke: 'Africa/Nairobi', ug: 'Africa/Kampala', tz: 'Africa/Dar_es_Salaam',
  rw: 'Africa/Kigali', bi: 'Africa/Bujumbura', ng: 'Africa/Lagos', gh: 'Africa/Accra', ci: 'Africa/Abidjan', sn: 'Africa/Dakar',
  ml: 'Africa/Bamako', bf: 'Africa/Ouagadougou', ne: 'Africa/Niamey', td: 'Africa/Ndjamena', cm: 'Africa/Douala', ga: 'Africa/Libreville',
  cg: 'Africa/Brazzaville', ao: 'Africa/Luanda', zm: 'Africa/Lusaka', zw: 'Africa/Harare', mw: 'Africa/Blantyre', mz: 'Africa/Maputo',
  za: 'Africa/Johannesburg', na: 'Africa/Windhoek', bw: 'Africa/Gaborone', ls: 'Africa/Maseru', sz: 'Africa/Mbabane', mg: 'Indian/Antananarivo',
  mu: 'Indian/Mauritius', lr: 'Africa/Monrovia', sl: 'Africa/Freetown', gn: 'Africa/Conakry', gm: 'Africa/Banjul', tg: 'Africa/Lome', bj: 'Africa/Porto-Novo',
  gt: 'America/Guatemala', bz: 'America/Belize', sv: 'America/El_Salvador', hn: 'America/Tegucigalpa', ni: 'America/Managua',
  cr: 'America/Costa_Rica', pa: 'America/Panama', cu: 'America/Havana', jm: 'America/Jamaica', ht: 'America/Port-au-Prince',
  do: 'America/Santo_Domingo', tt: 'America/Port_of_Spain', bb: 'America/Barbados', bs: 'America/Nassau', co: 'America/Bogota',
  ve: 'America/Caracas', ec: 'America/Guayaquil', pe: 'America/Lima', bo: 'America/La_Paz', py: 'America/Asuncion', uy: 'America/Montevideo',
  ar: 'America/Argentina/Buenos_Aires', cl: 'America/Santiago', gy: 'America/Guyana', sr: 'America/Paramaribo',
  // Several zones, but most people in the main one.
  mx: 'America/Mexico_City', br: 'America/Sao_Paulo', ru: 'Europe/Moscow',
};

/** The zone a birth or trip there most likely used, or '' when it can't be told. */
export function zoneFor(country: unknown, region: unknown): string {
  const c = String(country ?? '').toLowerCase();
  const raw = String(region ?? '').trim();
  const r = raw.toLowerCase().replace(/\.$/, '');
  if (c === 'us') { const code = raw.length <= 3 ? raw.toUpperCase() : US_NAMES[r]; return (code && US[code]) || ''; }
  if (c === 'ca') return CA[raw.toUpperCase()] || CA[r] || '';
  if (c === 'au') return AU[raw.toUpperCase()] || AU[r] || '';
  return ONE[c] || '';
}

/** "America/Chicago" → "Central Time (Chicago)": how people say it, with the city that pins it down. */
export function zoneLabel(zone: string): string {
  const city = zone.split('/').at(-1)!.replace(/_/g, ' ');
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longGeneric' }).formatToParts(new Date()).find((x) => x.type === 'timeZoneName')?.value;
    return name && !/^GMT/.test(name) ? `${name} (${city})` : city;
  } catch { return city; }
}
