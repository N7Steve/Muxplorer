// One JSON record per line, visible in Docker/TrueNAS container logs.
export function diagnostic(event: string, fields: Record<string, unknown> = {}) {
  console.log(
    JSON.stringify({ time: new Date().toISOString(), event, ...fields }, (key, value: unknown) => {
      if (/password|secret|token|cookie|authorization|app_Key/i.test(key)) return '[oculto]';
      return typeof value === 'string'
        ? value.replace(/T-[A-Za-z0-9_@.-]{40,}/g, '[clave oculta]')
        : value;
    }),
  );
}
