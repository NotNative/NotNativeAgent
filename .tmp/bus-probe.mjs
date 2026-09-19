import { createWireEventBus } from '../src/opencode/wire-events.js';

const first = [];
const second = [];
const bus = createWireEventBus();
bus.subscribe({ writableEnded: false, write: (chunk) => first.push(chunk) });
bus.subscribe({ writableEnded: false, write: (chunk) => second.push(chunk) });
bus.publishGlobal('ping', { hello: true });
console.log('first', first.length, JSON.stringify(first.map((chunk) => JSON.parse(chunk.slice('data: '.length)))));
console.log('second', second.length);
bus.close();

const mine = [];
const world = [];
const filtered = createWireEventBus();
filtered.subscribe({ writableEnded: false, write: (chunk) => mine.push(chunk) }, { directory: 'C:\\mine' });
filtered.subscribe({ writableEnded: false, write: (chunk) => world.push(chunk) });
filtered.publishGlobal('instance.event', {});
filtered.publishSession({ directory: 'C:\\theirs', sessionID: 's2', project: 'x', type: 'session.updated', properties: {} });
filtered.publishSession({ directory: 'C:\\mine', sessionID: 's3', project: 'x', type: 'session.updated', properties: {} });
console.log('mine', mine.length);
console.log('world', world.length);
filtered.close();
