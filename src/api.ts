export async function apiRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
    body: options?.body ? options.body : undefined
  });
  const body = await response.json();
  if (!response.ok) throw Object.assign(new Error(body.error ?? 'Request failed'), { body, status: response.status });
  return body as T;
}
