import { Decimal128 } from "mongodb";

// Always build Decimal128 from a string, never a JS number — passing a
// float here would silently reintroduce the binary floating-point error
// this type exists to avoid.
export function toDecimal128(value: string): Decimal128 {
  return Decimal128.fromString(value);
}

// For display/math only — never feed this back into a Decimal128 field.
export function decimal128ToNumber(value: Decimal128): number {
  return Number(value.toString());
}
