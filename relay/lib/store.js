// Counter storage. Both stores take a batch of Redis commands and return one result per command.

export function upstashStore({ url, token, fetchImpl = fetch }) {
  return {
    async pipeline(commands) {
      const response = await fetchImpl(`${url}/pipeline`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(commands),
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) throw new Error(`store ${response.status}`);
      return (await response.json()).map((entry) => {
        if (entry.error) throw new Error(`store ${entry.error}`);
        return entry.result;
      });
    },
  };
}

// For tests and local runs. Expiry is ignored: a process does not live that long.
export function memoryStore(values = new Map()) {
  const run = ([name, key, ...rest]) => {
    switch (name) {
      case 'GET':
        return values.has(key) ? String(values.get(key)) : null;
      case 'INCR':
      case 'INCRBY': {
        const next = Number(values.get(key) ?? 0) + Number(rest[0] ?? 1);
        values.set(key, next);
        return next;
      }
      case 'EXPIRE':
        return values.has(key) ? 1 : 0;
      case 'SET': {
        if (rest.includes('NX') && values.has(key)) return null;
        values.set(key, rest[0]);
        return 'OK';
      }
      default:
        throw new Error(`memoryStore: unsupported ${name}`);
    }
  };
  return { values, pipeline: async (commands) => commands.map(run) };
}
