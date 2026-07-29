export type JsonLdValue =
  | null
  | boolean
  | number
  | string
  | JsonLdValue[]
  | { [key: string]: JsonLdValue };

const SCRIPT_DATA_ESCAPES = {
  "<": "\\u003c",
  ">": "\\u003e",
  "&": "\\u0026",
  "\u2028": "\\u2028",
  "\u2029": "\\u2029",
} as const;

export function serializeJsonLd(value: JsonLdValue): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError("JSON-LD value could not be serialized");
  }

  return serialized.replace(
    /[<>&\u2028\u2029]/gu,
    (character) => SCRIPT_DATA_ESCAPES[character as keyof typeof SCRIPT_DATA_ESCAPES],
  );
}
