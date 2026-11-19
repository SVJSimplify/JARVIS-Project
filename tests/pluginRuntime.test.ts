import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerPlugin, listPlugins, disposePlugins } from '../src/main/pluginRuntime';
import { runtimeEvents } from '../src/main/runtimeEvents';
import { agentToolRegistry } from '../src/main/agentEngine/toolRegistry';
describe('plugin runtime', () => {
 afterEach(() => { disposePlugins(); runtimeEvents.clear(); });
 it('registers event hooks and disposes them', () => {
  const handler = vi.fn(), p = registerPlugin({ id:'sample.plugin', version:'1.0', events:{'turn.started':handler} });
  runtimeEvents.emit('turn.started',{task:'x',at:1}); expect(handler).toHaveBeenCalledOnce();
  p.dispose(); runtimeEvents.emit('turn.started',{task:'y',at:2}); expect(handler).toHaveBeenCalledOnce();
  expect(listPlugins()).toEqual([]);
 });
 it('rejects duplicate and unsafe ids', () => {
  registerPlugin({id:'valid.plugin',version:'1',events:{}});
  expect(()=>registerPlugin({id:'valid.plugin',version:'1',events:{}})).toThrow(/already registered/);
  expect(()=>registerPlugin({id:'../escape',version:'1',events:{}})).toThrow(/safe characters/);
 });
 it('registers and disposes capability-declared custom tools', () => {
  const p = registerPlugin({
   id:'sample.plugin', version:'1.0', manifest:{capabilities:['tools']},
   tools:[{name:'lookup',description:'Look up a record.',inputSchema:{type:'object',properties:{id:{type:'string'}}},execute:({id})=>String(id)}],
   events:{}
  });
  expect(agentToolRegistry.get('plugin_sample_plugin_lookup')).toBeTruthy();
  p.dispose();
  expect(agentToolRegistry.get('plugin_sample_plugin_lookup')).toBeUndefined();
 });
 it('requires an explicit tools capability for custom tool contributions', () => {
  expect(()=>registerPlugin({
   id:'missing.capability',version:'1',tools:[{name:'lookup',description:'Lookup',inputSchema:{type:'object'},execute:()=> 'ok'}],events:{}
  })).toThrow(/declare the "tools" capability/);
 });

});