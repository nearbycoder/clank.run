import test from 'node:test';
import assert from 'node:assert/strict';
import {featureFixture} from './feature-fixture.mjs';
import {openReminders,createReminderClient,mountReminders} from '../dist/reminders.js';
import {previewSchedule} from '../dist/schedules.js';
class Element {
 constructor(tag,doc){this.tag=tag;this.ownerDocument=doc;this.childNodes=[];this.attributes=new Map();this.value='';this.ownText='';this.disabled=false;}
 append(...nodes){for(const node of nodes){node.parentNode=this;this.childNodes.push(node);if(this.tag==='select'&&this.childNodes.length===1)this.value=node.value;}}
 replaceChildren(...nodes){this.childNodes=[];this.ownText='';this.append(...nodes)}
 setAttribute(key,value){this.attributes.set(key,value)} removeAttribute(key){this.attributes.delete(key)}
 get textContent(){return this.ownText+this.childNodes.map(node=>node.textContent).join('')}set textContent(value){this.ownText=value;this.childNodes=[]}
 querySelectorAll(selector){const tags=selector.split(',');return descendants(this).filter(node=>tags.includes(node.tag))}
 remove(){if(this.parentNode)this.parentNode.childNodes=this.parentNode.childNodes.filter(node=>node!==this)}focus(){}
}
function descendants(node){return node.childNodes.flatMap(child=>[child,...descendants(child)])}
function fixture(){const doc={createElement:tag=>new Element(tag,doc),visibilityState:'visible'};return doc.createElement('div')}
async function idle(container){for(let i=0;i<1000;i++){await new Promise(resolve=>setImmediate(resolve));if(!descendants(container).some(node=>node.attributes.has('aria-busy')))return;}throw Error('UI remained busy')}
async function click(container,text){const node=descendants(container).find(node=>node.tag==='button'&&node.textContent===text);assert.ok(node,'Missing '+text);node.onclick();await idle(container)}
function field(container,label){const node=descendants(container).find(node=>node.attributes.get('aria-label')===label);assert.ok(node,'Missing '+label);return node}

test('recurrence editor preserves advanced rules and snoozed times through title edits and rejects stale saves',async()=>{
 const app=await featureFixture(openReminders,createReminderClient,'reminders');const container=fixture();let cleanup;
 try{
  const{client}=await app.user('ui-recurrence@example.test');const rule={frequency:'monthly',interval:2,startDate:'2027-01-31',time:'09:30',timeZone:'America/New_York',dayOfMonth:31,exceptionDates:['2027-03-31'],endDate:'2027-12-31',overlap:'later'};
  const row=await client.save({title:'Original',dueAt:previewSchedule(rule,{after:0,limit:1}).occurrences[0].at,recurrence:rule});await client.snooze(row.id,10,row.version);const snoozed=(await client.list())[0];
  cleanup=mountReminders(container,client);await idle(container);await click(container,'Edit reminder');
  const title=field(container,'Reminder title');title.value='Renamed';title.oninput();await click(container,'Save reminder');let saved=(await client.list())[0];assert.equal(saved.title,'Renamed');assert.equal(saved.dueAt,snoozed.dueAt);assert.deepEqual(saved.recurrence,snoozed.recurrence);
  await click(container,'Edit reminder');const exceptions=field(container,'Exception dates, separated by commas');exceptions.value='2027-03-31, 2027-05-31';exceptions.oninput();await click(container,'Save reminder');saved=(await client.list())[0];assert.equal(saved.recurrence.startDate,rule.startDate);assert.equal(saved.recurrence.time,rule.time);assert.equal(saved.recurrence.interval,2);assert.equal(saved.dueAt,Date.parse('2027-01-31T14:30:00Z'));
  await click(container,'Edit reminder');title.value='Unsaved local draft';title.oninput();await client.save({id:saved.id,expectedVersion:saved.version,title:'Remote title',dueAt:saved.dueAt});await click(container,'Save reminder');assert.equal(title.value,'Unsaved local draft');assert.match(container.textContent,/draft is preserved/);assert.equal((await client.list())[0].title,'Remote title');
  await click(container,'Cancel edit');await click(container,'Refresh reminders');await click(container,'Edit reminder');
  const frequency=field(container,'Repeat reminder');frequency.value='daily';frequency.onchange();const when=field(container,'Reminder local time');when.value='2027-02-01T09:30';when.oninput();await click(container,'Preview schedule');assert.match(container.textContent,/Upcoming occurrences/);await click(container,'Save reminder');saved=(await client.list())[0];assert.equal(saved.recurrence.frequency,'daily');assert.equal(saved.recurrence.weekdays,undefined);assert.equal(saved.recurrence.dayOfMonth,undefined);assert.equal(saved.recurrence.interval,1);assert.equal(saved.dueAt,Date.parse('2027-02-01T14:30:00Z'));
  cleanup();cleanup=undefined;assert.equal(container.childNodes.length,0);
 }finally{cleanup?.();await app.close()}
});
