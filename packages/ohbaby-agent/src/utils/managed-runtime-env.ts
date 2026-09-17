// Values copied into process.env by this runtime are a cache of the global
// secret file, not an explicit caller override. Keep caller-supplied env first.
const managedValues = new Map<string, string>();

export function rememberManagedRuntimeEnv(name: string, value: string): void {
  managedValues.set(name, value);
}

export function setManagedRuntimeEnv(name: string, value: string): void {
  process.env[name] = value;
  rememberManagedRuntimeEnv(name, value);
}

export function runtimeEnvValue(
  name: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const value = env[name];
  return env === process.env &&
    managedValues.has(name) &&
    managedValues.get(name) === value
    ? undefined
    : value;
}
