// Run: node --test scripts/verify-card-query-dedup.cjs
// Exercise the real hook options with TanStack Query observers, without a DOM.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const query = require('@tanstack/react-query');

function loadHook(filename, client, observers) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'hooks', filename), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  const requireHook = (name) => {
    assert.equal(name, '@tanstack/react-query');
    return {
      ...query,
      useQuery(options) {
        const observer = new query.QueryObserver(client, options);
        observers.push(observer);
        return observer;
      },
    };
  };
  new Function('require', 'module', 'exports', js)(requireHook, module, module.exports);
  return module.exports;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

for (const [filename, hookName, key] of [
  ['useFavoritesQuery.ts', 'useIsFavoritedQuery', 'favorites'],
  ['useRemindersQuery.ts', 'useIsRemindedQuery', 'reminders'],
]) {
  test(`${key}: 50 cards share one request and update independently`, async () => {
    const client = new query.QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const observers = [];
    const subscriptions = [];
    const originalFetch = global.fetch;
    let calls = 0;
    let data = { 'source+0': { title: 'first' } };
    global.fetch = async (url) => {
      assert.equal(url, `/api/${key}`);
      calls++;
      await tick();
      return { ok: true, json: async () => data };
    };
    try {
      const hook = loadHook(filename, client, observers)[hookName];
      // A disabled card must not start a request.
      const disabled = hook('source', 'disabled', { enabled: false });
      subscriptions.push(disabled.subscribe(() => {}));
      await tick();
      assert.equal(calls, 0);
      for (let i = 0; i < 50; i++) {
        subscriptions.push(hook('source', String(i)).subscribe(() => {}));
      }
      await tick();
      await tick();
      assert.equal(calls, 1, 'all cards must deduplicate their list request');
      assert.equal(observers[1].getCurrentResult().data, true);
      assert.equal(observers[2].getCurrentResult().data, false);
      // Existing mutations write this shared cache for optimistic changes/rollback.
      client.setQueryData([key], { 'source+1': { title: 'second' } });
      assert.equal(observers[1].getCurrentResult().data, false);
      assert.equal(observers[2].getCurrentResult().data, true);
      data = { 'source+2': { title: 'third' } };
      await client.invalidateQueries({ queryKey: [key] });
      assert.equal(calls, 2, 'a change must cause one shared refetch, not 50');
      assert.equal(observers[2].getCurrentResult().data, false);
      assert.equal(observers[3].getCurrentResult().data, true);
      // Reusing a card for a different movie must change its selected boolean.
      const updated = loadHook(filename, client, [])[hookName]('source', '2');
      assert.equal(updated.getCurrentResult().data, true);
      updated.destroy();
    } finally {
      subscriptions.forEach((unsubscribe) => unsubscribe());
      observers.forEach((observer) => observer.destroy());
      client.clear();
      global.fetch = originalFetch;
    }
  });
}
