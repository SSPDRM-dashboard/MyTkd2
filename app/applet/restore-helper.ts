import { initializeApp } from 'firebase/app';
import { getFirestore, getDoc, doc, setDoc } from 'firebase/firestore';
import fs from 'fs';

const app = initializeApp(JSON.parse(fs.readFileSync('firebase-applet-config.json', 'utf8')));
const db = getFirestore(app);

async function run() {
  const qDoc = await getDoc(doc(db, 'sync', 'tkd_bout_queue'));
  if (qDoc.exists()) {
    const data = qDoc.data().value;
    const byEvent = data.reduce((acc, item) => {
       const eid = item.data?.eventId || 'none';
       acc[eid] = (acc[eid] || 0) + 1;
       return acc;
    }, {});
    console.log("Queue counts:", byEvent);
    
    // update all queue items that lack the current event ID? 
    // What if we just set all queue items' eventId to 'o6nsg2u9k'? 
    // Is that what the user wants? Let's check test_data.ts to see what the old events were.
    const eDoc = await getDoc(doc(db, 'sync', 'tkd_events_v3'));
    const events = eDoc.exists() ? eDoc.data().value : [];
    console.log("Current Events:", events);
    
    // Maybe we just need to assign the largest block (eu7fp235r, 313 items and dqyof3jl4, 276 items) to the current event ID?
    // Wait, let's read the first item of eu7fp235r and dqyof3jl4.
    const sample1 = data.find(i => i.data?.eventId === 'dqyof3jl4');
    const sample2 = data.find(i => i.data?.eventId === 'eu7fp235r');
    
    console.log("Sample dqyof3jl4:", sample1);
    console.log("Sample eu7fp235r:", sample2);
  }
}
run();
