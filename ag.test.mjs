import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { guidedSetup, launchSession, loadSetup, saveSetup, main } from './ag.mjs';

const fixture = { client: 'codex', endpoint: 'https://provider.example/v1', apiKey: 'fixture-key', model: 'fixture-model' };
async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), 'ag-assistant-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function answers(values) {
  return { questions: [], async ask(label, options) { this.questions.push({ label, options }); assert(values.length, 'Unexpected prompt'); return values.shift(); } };
}
function output() {
  return { value: '', write(value) { this.value += value; } };
}

test('saved setup rejects invalid inputs and linked files, and keys stay private with recoverable backups', async t => {
  const root = await directory(t), file = join(root, 'ag.json');
  await assert.rejects(loadSetup(file), /No saved setup/);
  for (const value of [{ ...fixture, endpoint: 'http://provider.example' }, { ...fixture, apiKey: 'bad\nkey' }, { ...fixture, client: 'unknown' }, { ...fixture, model: '' }]) await assert.rejects(saveSetup(value, file));
  assert.deepEqual(await readdir(root), []);
  await saveSetup(fixture, file);
  assert.deepEqual(await loadSetup(file), fixture);
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
  await saveSetup({ ...fixture, apiKey: 'replacement-key' }, file);
  const backup = (await readdir(root)).find(name => name.includes('agentrouter-backup-'));
  assert.equal(JSON.parse(await readFile(join(root, backup), 'utf8')).apiKey, 'fixture-key');
  if (process.platform !== 'win32') {
    const link = join(root, 'linked.json');
    await symlink(file, link);
    await assert.rejects(loadSetup(link), /linked/);
    await assert.rejects(saveSetup(fixture, link), /linked/);
  }
});

test('declining a missing client installation does not install or save anything', async t => {
  const root = await directory(t), ui = answers(['1', 'n']);
  let calls = 0;
  await assert.rejects(guidedSetup(ui, { file: join(root, 'ag.json'), env: { PATH: '' }, installed: () => false, install: () => { calls++; } }), /declined/);
  assert.equal(calls, 0);
  assert.deepEqual(await readdir(root), []);
});

test('guided setup installs only on consent, hides key input, and runs without saving when declined', async t => {
  const root = await directory(t), sink = output();
  const ui = answers(['2', 'yes', 'https://provider.example/v1', 'fixture-key', 'fixture-model', 'n', '']);
  let present = false;
  const installedClients = [];
  const result = await guidedSetup(ui, { file: join(root, 'ag.json'), env: { PATH: '' }, output: sink, installed: () => present,
    install: async client => { installedClients.push(client); present = true; } });
  assert.deepEqual(installedClients, ['claude']);
  assert.equal(result.start, true);
  assert.equal(result.setup.client, 'claude');
  assert.equal(ui.questions.find(item => item.label.startsWith('API key')).options.secret, true);
  assert.deepEqual(await readdir(root), []);
  assert(!sink.value.includes('fixture-key'));
});

test('guided setup can save an environment key and decline startup without installing an existing client', async t => {
  const root = await directory(t), file = join(root, 'ag.json'), sink = output();
  const ui = answers(['3', '', 'fixture-model', 'y', 'n']);
  const result = await guidedSetup(ui, { file, env: { PATH: '', AG_API_KEY: 'fixture-key' }, output: sink, installed: () => true,
    install: () => assert.fail('Existing client must not be installed') });
  assert.equal(result.start, false);
  assert.equal((await loadSetup(file)).client, 'opencode');
  assert(!ui.questions.some(item => item.label.startsWith('API key')));
  assert(!sink.value.includes('fixture-key'));
});

test('guided launch authenticates through a temporary token and closes the proxy when the client exits', async t => {
  const upstream = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer fixture-key');
    assert.equal(req.url, '/v1/models');
    res.end('fixture-response');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const signals = new EventEmitter(), sink = output();
  let local;
  const code = await launchSession({ setup: { ...fixture, endpoint: `http://127.0.0.1:${upstream.address().port}/v1` }, port: 0 }, {
    signals, output: sink, launch: async (client, options) => {
      assert.equal(client, 'codex');
      assert.equal(options.model, 'fixture-model');
      assert.notEqual(options.localBearer, 'fixture-key');
      local = options.baseUrl;
      assert.equal((await fetch(local + '/models')).status, 401);
      const response = await fetch(local + '/models', { headers: { authorization: `Bearer ${options.localBearer}` } });
      assert.equal(await response.text(), 'fixture-response');
      return 7;
    },
  });
  assert.equal(code, 7);
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
  await assert.rejects(fetch(local + '/models'));
  assert(!sink.value.includes('fixture-key'));
});

test('proxy-only launch forwards existing credentials and stops on a signal', async t => {
  const upstream = http.createServer((req, res) => { assert.equal(req.headers.authorization, 'Bearer existing-key'); res.end('existing-ok'); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const signals = new EventEmitter(), sink = output();
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  const original = sink.write;
  sink.write = function(value) { original.call(this, value); if (value.includes('Ctrl+C')) ready(); };
  const running = launchSession({ endpoint: `http://127.0.0.1:${upstream.address().port}/v1`, port: 0, client: 'claude' }, {
    signals, output: sink, launch: () => assert.fail('Proxy-only mode must not override/launch a client'),
  });
  await started;
  const local = /Proxy: (http:\/\/[^ ]+)/.exec(sink.value)[1];
  assert.equal(await (await fetch(local + '/models', { headers: { authorization: 'Bearer existing-key' } })).text(), 'existing-ok');
  assert(sink.value.includes('ANTHROPIC_BASE_URL'));
  signals.emit('SIGTERM');
  assert.equal(await running, 0);
  await assert.rejects(fetch(local + '/models'));
});

test('CLI help needs no terminal, npm-style symlinks run correctly, and bad options fail without starting a proxy', async t => {
  const sink = output(),root=await directory(t);
  assert.equal(await main(['help'], { output: sink }), 0);
  assert(sink.value.includes('ag proxy'));
  await assert.rejects(main(['unknown']), /Unknown/);
  await assert.rejects(main(['proxy', '--port', '0']), /Invalid option/);
  await assert.rejects(main(['proxy', '--endpoint', 'http://remote.example']), /HTTPS/);
  await assert.rejects(main([], { input: {}, output: sink,env:{AG_APP_DIR:root} }), /interactive terminal/);
  if (process.platform !== 'win32') {
    const root = await directory(t), link = join(root, 'ag');
    await symlink(new URL('./ag.mjs', import.meta.url), link);
    const result = await promisify(execFile)(process.execPath, [link, 'help']);
    assert(result.stdout.includes('ag setup'));
  }
});

test('the interactive proxy menu starts a background service and returns without launching a client',async t=>{
  const root=await directory(t),env={PATH:'',XDG_DATA_HOME:root},sink=output(),ui=answers(['1','2','']);
  let closed=false,call;
  ui.close=()=>{closed=true;};
  assert.equal(await main([],{ui,env,output:sink,activation:async(setup,options)=>{
    assert.equal(closed,true);call={setup,options};return {mode:'relay',setup,port:options.port};
  }}),0);
  assert.deepEqual(call.setup,{endpoint:'https://agentrouter.org/v1',client:'claude'});
  assert.equal(call.options.relay,true);assert.equal(call.options.port,18766);
  assert.equal(call.options.app,join(root,'agentrouter-codex-relay'));
  assert.match(ui.questions[0].label,/Autostart and crash restart/);
  assert.match(sink.value,/ANTHROPIC_BASE_URL/);
  assert.doesNotMatch(sink.value,/Keep this terminal open/);
});

test('ag proxy defaults to persistent mode and supports custom endpoint and port',async()=>{
  let call;
  assert.equal(await main(['proxy','--endpoint','https://provider.example/v1','--port','18767'],{output:output(),activation:async(setup,options)=>{call={setup,options};}}),0);
  assert.equal(call.setup.endpoint,'https://provider.example/v1');assert.equal(call.options.port,18767);assert.equal(call.options.relay,true);
  await assert.rejects(main(['activate','--foreground']),/Invalid option/);
});
