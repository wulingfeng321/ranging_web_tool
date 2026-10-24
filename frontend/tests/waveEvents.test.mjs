import test from 'node:test';
import assert from 'node:assert/strict';
import {waveEvents} from '../src/waveEvents.ts';

const a={index:0,event:'12',local_ns:'1000000000000000001',local_time_s:1,master_time_s:1,locked:true};
const b={...a,event:'29',local_ns:'2000000000000000001',local_time_s:2,master_time_s:1.000003};
const boards={A:{event_markers:[a]},B:{event_markers:[b,{...b,index:1,event:'30',master_time_s:null}]}};
const pairs=[{index:4,arrival_delta_us:3,events:{A:{...a,locked:'1'},B:{...b,locked:'1'}}}];
test('marks all positioned detections, links local IDs, and displays B minus A in microseconds',()=>{
 const plot=waveEvents(boards,pairs,'master',[0,3],[true,false,true,false],4,true);
 assert.equal(plot.events.length,2);assert.equal(plot.unpositioned,1);
 assert.equal(plot.events[1].pairIndex,4);assert.equal(plot.events[1].delta,3);
 assert.match(plot.traces[1].hovertext[0],/3.000 μs/);
 assert.equal(plot.shapes[1].x0,1.000003);
 assert.notEqual(plot.traces[0].y[0],plot.traces[1].y[0]);
});
test('local recording mode includes unmapped events without implying synchronized delays',()=>{
 const plot=waveEvents(boards,pairs,'local',[0,3],[true,false,true,false],null,true);
 assert.equal(plot.events.length,3);assert.equal(plot.events[1].time,2);
 assert.equal(plot.events[1].delta,null);assert.equal(plot.unpositioned,0);
 assert.match(plot.traces[1].hovertext[0],/不能直接比较/);
});
test('unlocked and unmatched events remain visible but provide no reliable delay',()=>{
 const modified={...boards,B:{event_markers:[{...b,locked:false}]}};
 const plot=waveEvents(modified,[],'master',[0,3],[true,false,true,false],null,true);
 assert.equal(plot.events[1].pairIndex,null);
 assert.equal(plot.traces[1].marker.symbol[0],'triangle-down-open');
 assert.equal(plot.events[1].delta,null);
});
test('range, channel controls and visibility toggle filter markers correctly',()=>{
 const plot=waveEvents(boards,pairs,'master',[1.000001,2],[true,false,true,false],null,true);
 assert.equal(plot.events.length,1);assert.equal(plot.events[0].board,'B');
 const onlyA=waveEvents(boards,pairs,'master',[0,3],[true,false,false,false],null,true);
 assert.equal(onlyA.events.length,1);
 const hidden=waveEvents(boards,pairs,'master',[0,3],[true,false,true,false],null,false);
 assert.deepEqual(hidden.traces,[]);assert.deepEqual(hidden.shapes,[]);
});
