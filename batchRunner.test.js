import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as fs from 'node:fs';
import * as childProcess from 'node:child_process';

test('spawns extractor per pending model and records progress', async (t) => {
  const fakeModels = {
    CLS: 'code-cls',
    GLA: 'code-gla',
    EQS: 'code-eqs'
  };
  const fakeProxies = {
    CLS: 'proxy-cls',
    GLA: 'proxy-gla',
    EQS: 'proxy-eqs'
  };
  const fakeProgress = { CLS: 'done' };

  const writes = [];
  const spawns = [];
  const exits = [];

  const originalDirname = global.__dirname;
  global.__dirname = process.cwd();

  mock.method(fs, 'readFileSync', (filePath) => {
    if (filePath.endsWith('models.json')) return JSON.stringify(fakeModels);
    if (filePath.endsWith('proxies.json')) return JSON.stringify(fakeProxies);
    if (filePath.endsWith('progress.json')) return JSON.stringify(fakeProgress);
    throw new Error(`Unexpected read: ${filePath}`);
  });

  mock.method(fs, 'existsSync', (filePath) => filePath.endsWith('progress.json'));

  mock.method(fs, 'writeFileSync', (filePath, data) => {
    writes.push({
      filePath,
      data: JSON.parse(data)
    });
  });

  mock.method(childProcess, 'spawn', (cmd, args, options) => {
    spawns.push({ cmd, args, options });
    return {
      on(event, handler) {
        if (event === 'exit') {
          exits.push({ modelName: args[1], handler });
        }
        return this;
      }
    };
  });

  t.after(() => {
    mock.restoreAll();
    if (typeof originalDirname === 'undefined') {
      delete global.__dirname;
    } else {
      global.__dirname = originalDirname;
    }
  });

  const moduleUrl = pathToFileURL(path.resolve('batchRunner.js')).href;
  await import(moduleUrl);

  assert.equal(spawns.length, 2);
  assert.deepEqual(
    spawns.map(({ cmd, args }) => ({ cmd, args })),
    [
      {
        cmd: 'node',
        args: [
          path.join(process.cwd(), 'extractor.js'),
          'GLA',
          'code-gla',
          'proxy-gla'
        ]
      },
      {
        cmd: 'node',
        args: [
          path.join(process.cwd(), 'extractor.js'),
          'EQS',
          'code-eqs',
          'proxy-eqs'
        ]
      }
    ]
  );

  exits.find(entry => entry.modelName === 'GLA')?.handler(0);
  exits.find(entry => entry.modelName === 'EQS')?.handler(1);

  assert.equal(writes.length, 2);
  assert.deepEqual(writes[0].data, { CLS: 'done', GLA: 'done' });
  assert.deepEqual(writes[1].data, { CLS: 'done', GLA: 'done', EQS: 'failed' });
});

