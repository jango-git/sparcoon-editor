/**
 * A sparcoon object's private member `name`, which its build emits with a `_private_` prefix. For
 * tests that look inside the runtime.
 */
export function runtimePrivate<T>(object: unknown, name: string): T {
  return (object as Record<string, unknown>)[`_private_${name}`] as T;
}
