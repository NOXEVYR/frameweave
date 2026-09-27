import test from 'node:test';
import assert from 'node:assert/strict';
import {configurationScope} from '../web/workflow-canvas.mjs';

test('single configuration includes its text wires but no unrelated broken definitions',()=>{
 const graph={nodes:[{id:'chosen',type:'generation',data:{kind:'package',package_id:'good'}},{id:'text',type:'prompt',data:{text:'hello'}},{id:'broken',type:'generation',data:{kind:'package',package_id:'missing'}},{id:'media',type:'reference'}],edges:[{id:'a',source:'text',target:'chosen'},{id:'b',source:'media',target:'chosen'},{id:'c',source:'broken',target:'chosen'}]};
 const scope=configurationScope(graph,'chosen');
 assert.deepEqual(scope.nodes.map(n=>n.id),['chosen','text']);
 assert.deepEqual(scope.edges.map(e=>e.id),['a']);assert.equal(graph.nodes.length,4);
 assert.throws(()=>configurationScope(graph,'deleted'),/移除/);
});
