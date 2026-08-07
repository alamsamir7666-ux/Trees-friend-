let _getToken: (() => Promise<string | null>) | null = null;

export function setTokenGetter(fn: () => Promise<string | null>) {
  _getToken = fn;
}

export async function getToken(): Promise<string | null> {
  if (_getToken) return _getToken();
  return null;
}
