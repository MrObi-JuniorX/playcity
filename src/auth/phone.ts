/* Phone numbers in, one canonical E.164 string out, so "0803 123 4567" and "+234 803 123 4567" are the same player
   (ID-2). The page sends a country and what the person typed; the country decides the calling code and how to read
   a leading trunk 0. Strict patterns for the big launch markets; a length check elsewhere. */

export interface Country { iso: string; dial: string; name: string; trunk0: boolean; mobile?: RegExp }

export const COUNTRIES: Country[] = [
  { iso: "NG", dial: "234", name: "Nigeria", trunk0: true, mobile: /^234[789][01]\d{8}$/ },
  { iso: "GB", dial: "44", name: "United Kingdom", trunk0: true, mobile: /^447\d{9}$/ },
  { iso: "US", dial: "1", name: "United States", trunk0: false, mobile: /^1[2-9]\d{2}[2-9]\d{6}$/ },
  { iso: "CA", dial: "1", name: "Canada", trunk0: false, mobile: /^1[2-9]\d{2}[2-9]\d{6}$/ },
  { iso: "IE", dial: "353", name: "Ireland", trunk0: true, mobile: /^3538[3-9]\d{7}$/ },
  { iso: "GH", dial: "233", name: "Ghana", trunk0: true, mobile: /^233[25]\d{8}$/ },
  { iso: "ZA", dial: "27", name: "South Africa", trunk0: true, mobile: /^27[6-8]\d{8}$/ },
  { iso: "AE", dial: "971", name: "United Arab Emirates", trunk0: true, mobile: /^9715\d{8}$/ },
  { iso: "DE", dial: "49", name: "Germany", trunk0: true },
  { iso: "NL", dial: "31", name: "Netherlands", trunk0: true },
  { iso: "FR", dial: "33", name: "France", trunk0: true },
  { iso: "IT", dial: "39", name: "Italy", trunk0: false },
  { iso: "ES", dial: "34", name: "Spain", trunk0: false },
];
export const DEFAULT_COUNTRIES = COUNTRIES.map(c => c.iso);

export function allowedCountries(list?: string): Country[] {
  const want = (list || "").split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
  return want.length ? COUNTRIES.filter(c => want.includes(c.iso)) : COUNTRIES;
}

/** E.164 digits without the plus, or null when it can't be a mobile number in that country. */
export function normalizePhone(country: Country, typed: string): string | null {
  if (typeof typed !== "string" || typed.length > 32) return null;
  const plus = typed.trim().startsWith("+") || typed.trim().startsWith("00");
  let d = typed.replace(/\D/g, "");
  if (typed.trim().startsWith("00")) d = d.slice(2);
  if (plus) { if (!d.startsWith(country.dial)) return null; }
  else if (d.startsWith(country.dial) && d.length > country.dial.length + 8) { /* typed with the code but no plus */ }
  else { if (country.trunk0 && d.startsWith("0")) d = d.slice(1); d = country.dial + d; }
  if (d.length < 8 || d.length > 15) return null;
  if (country.mobile && !country.mobile.test(d)) return null;
  return d;
}

/** What a person sees of their own number: "+234 ••• ••• ••67". */
export const maskPhone = (dial: string, last2: string) => `+${dial} ••• ••• ••${last2}`;
