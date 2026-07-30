export async function fetchJSON<T = unknown>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options);
  const body = await res.text();
  if (!body) return {} as T;

  if (!res.ok) {
    const isJson = body.startsWith('{') || body.startsWith('[');
    if (isJson) {
      try {
        const json = JSON.parse(body);
        throw new Error(json.error || json.message || `Request failed (${res.status})`);
      } catch (e: any) {
        if (e.message && !e.message.includes('Unexpected token')) throw e;
      }
    }
    if (body.length > 120) {
      throw new Error(`Server error (${res.status})`);
    }
    throw new Error(body.trim() || `Request failed (${res.status})`);
  }

  const isJson = body.startsWith('{') || body.startsWith('[');
  if (!isJson && body.length > 2) {
    if (body.includes('<!DOCTYPE') || body.includes('<html')) {
      throw new Error('Server returned HTML page. Check if the API server is running.');
    }
    throw new Error(body.trim().substring(0, 120));
  }

  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error(`Invalid response from server: ${body.substring(0, 60)}`);
  }
}
