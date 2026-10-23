// Settings validation shared by the server (which enforces it) and the Settings screen.
// Pure: no imports from the server. The two feature switches are the only merchant settings.

export const FEATURE_FIELDS = ["wishlistEnabled", "notifyMeEnabled"];
export const DEFAULT_SETTINGS = { wishlistEnabled: true, notifyMeEnabled: true };

const parseSwitch = (raw) => {
  if (raw === true || raw === "true" || raw === "on") return true;
  if (raw === false || raw === "false" || raw === "off") return false;
  return undefined;
};

// `input` is a FormData or a plain object. Returns { values, errors }. A switch that is missing or is not
// a clear on/off value is an error, so a malformed request can never silently switch a feature off.
export function validateSettings(input) {
  const get = (name) => (typeof input.get === "function" ? input.get(name) : input[name]);
  const values = {};
  const errors = {};
  for (const field of FEATURE_FIELDS) {
    const parsed = parseSwitch(get(field));
    if (parsed === undefined) errors[field] = "Choose on or off.";
    values[field] = parsed ?? DEFAULT_SETTINGS[field];
  }
  return { values, errors };
}

// True when a switch differs from the saved copy.
export function isDirty(current, saved) {
  const a = validateSettings(current).values;
  const b = validateSettings(saved).values;
  return FEATURE_FIELDS.some((key) => a[key] !== b[key]);
}
