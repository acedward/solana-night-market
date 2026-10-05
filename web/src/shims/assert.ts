// AA 00060 P6.2: Node's `assert` for the browser. midnight-js (Bridge out's lazy chunk) reaches the wallet
// SDK's address format, whose @subsquid/scale-codec calls `require("assert")(cond)`; Vite would replace
// the module with an empty stub that throws when called. web/vite.config.ts aliases `assert` here.

export class AssertionError extends Error {
  override name = 'AssertionError';
}

function assert(value: unknown, message?: string): asserts value {
  if (!value) throw new AssertionError(message ?? 'Assertion failed');
}

assert.ok = assert;
// Node's `assert.equal` is loose equality on purpose.
// eslint-disable-next-line eqeqeq
assert.equal = (a: unknown, b: unknown, message?: string) => assert(a == b, message ?? `${String(a)} == ${String(b)}`);
assert.strictEqual = (a: unknown, b: unknown, message?: string) =>
  assert(Object.is(a, b), message ?? `${String(a)} === ${String(b)}`);
assert.notStrictEqual = (a: unknown, b: unknown, message?: string) =>
  assert(!Object.is(a, b), message ?? `${String(a)} !== ${String(b)}`);
assert.fail = (message?: string): never => {
  throw new AssertionError(message ?? 'Failed');
};
assert.AssertionError = AssertionError;

export default assert;
