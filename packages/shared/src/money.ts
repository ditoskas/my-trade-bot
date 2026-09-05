import { Decimal128 } from "mongodb";
import { Decimal } from "decimal.js";

// Always build Decimal128 from a string, never a JS number — passing a
// float here would silently reintroduce the binary floating-point error
// this type exists to avoid.
export function toDecimal128(value: string): Decimal128 {
  return Decimal128.fromString(value);
}

// For display only — never feed this back into a Decimal128 field.
export function decimal128ToNumber(value: Decimal128): number {
  return Number(value.toString());
}

// Decimal128 has no arithmetic methods of its own. Use these to convert to
// decimal.js for any add/multiply/divide on a money or quantity value, then
// back to Decimal128 for storage — never route the math through a plain JS
// number, which reintroduces the float error Decimal128 exists to avoid.
export function toDecimalJs(value: Decimal128): Decimal {
  return new Decimal(value.toString());
}

export function fromDecimalJs(value: Decimal): Decimal128 {
  return Decimal128.fromString(value.toString());
}
